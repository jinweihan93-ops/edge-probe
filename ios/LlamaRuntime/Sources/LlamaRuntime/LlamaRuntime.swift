import Foundation
import llama

/// Thin Swift wrapper around llama.cpp's C API.
///
/// Two objects, two lifetimes:
///   • `LlamaModel` — owns the loaded GGUF weights + vocab. Expensive
///     to create (model load is the ~400 MB read-and-mmap step). Safe
///     to reuse across many sessions.
///   • `LlamaSession` — owns a llama_context + sampler chain. Cheaper
///     to create; holds the KV cache for one conversation. Create a
///     new session to reset context.
///
/// **Concurrency contract:** neither class is `Sendable`. Callers must
/// confine a given instance to one isolation domain (MainActor, a
/// custom actor, or a serial dispatch queue). Concurrent calls against
/// the same `LlamaSession` will corrupt the KV cache — they have no
/// lock because adding one would paper over a misuse rather than
/// prevent it.
///
/// **Simulator path:** llama.cpp's xcframework declares `link framework
/// "Metal"` in its modulemap, which compiles fine under the simulator
/// but `MTLCreateSystemDefaultDevice()` returns nil there. We force
/// `n_gpu_layers = 0` so load and decode never touch Metal in the
/// first place — same reason `LLMService.swift` caps MLX cache on
/// device. Works on simulator CPU, device ARM64, and Mac Catalyst.
///
/// Public API is deliberately small so the call sites in `LLMService`
/// stay readable. If you need batching, streaming, multi-sequence
/// contexts, or custom sampling (top-k / top-p / temperature), extend
/// here rather than exposing the raw llama_* symbols to the rest of
/// the app.
public enum LlamaRuntimeError: Error, LocalizedError {
    case backendInitFailed
    case modelLoadFailed(path: String)
    case vocabUnavailable
    case contextInitFailed
    case samplerInitFailed
    case tokenizationFailed(String)
    case chatTemplateFailed(String)
    case decodeFailed(code: Int32, phase: String)
    case detokenizationFailed(String)

    public var errorDescription: String? {
        switch self {
        case .backendInitFailed:
            return "llama.cpp backend_init failed. Likely a corrupted xcframework install."
        case .modelLoadFailed(let path):
            return "Failed to load GGUF from \(path). File exists? Readable? Valid GGUF v3?"
        case .vocabUnavailable:
            return "llama_model_get_vocab returned nil. Model file is malformed or partially loaded."
        case .contextInitFailed:
            return "llama_init_from_model returned nil. Check n_ctx / n_batch values — a 0.5B model on sim CPU should tolerate 2048/512."
        case .samplerInitFailed:
            return "Sampler chain init failed. This is normally infallible; check for OOM."
        case .tokenizationFailed(let m):
            return "Tokenization failed: \(m)"
        case .chatTemplateFailed(let m):
            return "Chat template apply failed: \(m)"
        case .decodeFailed(let code, let phase):
            return "llama_decode returned \(code) during \(phase). Common codes: 1=no-kv-slot (context full), 2=compute-error."
        case .detokenizationFailed(let m):
            return "Detokenization failed: \(m)"
        }
    }
}

// MARK: - Backend lifecycle

/// llama.cpp requires a one-time backend_init() per process before any
/// model / context API is safe. The upstream sample apps typically
/// call this from main() — we instead trip it lazily on the first
/// `LlamaModel.init` so app code never has to think about it.
///
/// `llama_backend_free()` intentionally never called — the cost is
/// negligible, and calling it while a model is still loaded is UB per
/// the header. The process exit handles it for us.
private enum LlamaBackend {
    nonisolated(unsafe) private static var didInit = false
    private static let lock = NSLock()

    static func ensureInitialized() {
        lock.lock()
        defer { lock.unlock() }
        if !didInit {
            llama_backend_init()
            didInit = true
        }
    }
}

// MARK: - Model

/// A loaded GGUF model. Holds weights + vocab pointer. Reusable across
/// many `LlamaSession`s.
public final class LlamaModel {
    /// `llama_model*`. Opaque to callers. `nonisolated(unsafe)` because
    /// `OpaquePointer` isn't Sendable but we enforce single-domain use
    /// at the class docstring level, not with a lock.
    fileprivate let modelPtr: OpaquePointer

    /// `const llama_vocab*`. Cached here because `llama_model_get_vocab`
    /// is cheap but not free — every tokenize call pays the lookup
    /// otherwise.
    fileprivate let vocabPtr: OpaquePointer

    /// Load a GGUF file from disk.
    ///
    /// - Parameter path: absolute path to a `.gguf` file.
    /// - Throws: `LlamaRuntimeError.modelLoadFailed` if the file doesn't
    ///   exist, isn't readable, or isn't a valid GGUF v3 blob.
    ///
    /// Forces CPU-only execution (`n_gpu_layers = 0`) because this
    /// wrapper's primary consumer is VoiceProbe on iOS simulator, where
    /// Metal isn't available. Device builds that want GPU offload
    /// should either (a) bump `n_gpu_layers` here behind a flag or
    /// (b) keep using MLX, which this wrapper is not meant to replace.
    public init(path: String) throws {
        LlamaBackend.ensureInitialized()

        var params = llama_model_default_params()
        params.n_gpu_layers = 0  // sim-safe; see class doc.

        guard let m = llama_model_load_from_file(path, params) else {
            throw LlamaRuntimeError.modelLoadFailed(path: path)
        }
        self.modelPtr = m

        guard let v = llama_model_get_vocab(m) else {
            llama_model_free(m)
            throw LlamaRuntimeError.vocabUnavailable
        }
        self.vocabPtr = v
    }

    deinit {
        llama_model_free(modelPtr)
    }

    /// The Jinja-ish chat template string embedded in the GGUF's
    /// metadata, or nil if the file doesn't carry one.
    ///
    /// Modern instruction-tuned GGUFs (Qwen2.5, Llama-3, Phi-3 etc.)
    /// embed the template the original tokenizer_config.json used at
    /// training time, so `llama_chat_apply_template(this, ...)` will
    /// produce the exact same prompt format the model was tuned on.
    /// Older base models (pre-2024) sometimes omit it — the session's
    /// `renderChat` falls back to llama.cpp's built-in format sniffing
    /// in that case; if that also fails, it throws `.chatTemplateFailed`.
    public var embeddedChatTemplate: String? {
        guard let cstr = llama_model_chat_template(modelPtr, nil) else {
            return nil
        }
        return String(cString: cstr)
    }

    /// The end-of-sequence token id. Used as a default stop criterion
    /// in `LlamaSession.generate`.
    public var eosToken: llama_token {
        return llama_vocab_eos(vocabPtr)
    }
}

// MARK: - Session

/// One conversation's worth of context + sampling state.
///
/// Reset semantics: throw this away and build a new one. The C API
/// does support KV-cache eviction, but for the voice-turn use case
/// (each hold-and-release is independent) a fresh session is simpler
/// and faster than figuring out which tokens to evict.
public final class LlamaSession {
    public let model: LlamaModel

    /// `llama_context*`.
    private let ctxPtr: OpaquePointer

    /// `llama_sampler*` — a sampler chain with one greedy sampler added.
    /// Greedy (argmax) chosen for deterministic benchmark output —
    /// same prompt → same reply → reproducible harness diffs.
    /// Swap in top-p / temperature by extending the init below.
    ///
    /// Type is `UnsafeMutablePointer<llama_sampler>` rather than
    /// `OpaquePointer` because llama.h fully declares `struct
    /// llama_sampler` (with function-pointer vtable in
    /// `llama_sampler_i`) rather than forward-declaring it like
    /// `llama_model` / `llama_context` / `llama_vocab`. Swift surfaces
    /// that distinction at the type level.
    private let samplerPtr: UnsafeMutablePointer<llama_sampler>

    /// Fixed context window. 2048 matches Qwen2.5-0.5B's training length;
    /// larger burns sim-CPU RAM with no quality gain on short voice turns.
    /// If a future caller ever needs a different size, re-introduce a
    /// `Config` init parameter — we removed it because none of the
    /// existing call sites customized it and YAGNI won.
    private static let contextSize: UInt32 = 2048

    /// Batch size for prefill. 512 is llama.cpp's usual default; same
    /// YAGNI reasoning as `contextSize` applies.
    private static let batchSize: UInt32 = 512

    public init(model: LlamaModel) throws {
        self.model = model

        var cparams = llama_context_default_params()
        cparams.n_ctx = Self.contextSize
        cparams.n_batch = Self.batchSize
        // Thread count left at llama.cpp's default (picks #performance
        // cores). If deterministic timings matter, wire a knob back in.

        guard let c = llama_init_from_model(model.modelPtr, cparams) else {
            throw LlamaRuntimeError.contextInitFailed
        }
        self.ctxPtr = c

        // Sampler chain: greedy only. `llama_sampler_chain_default_params`
        // is cheap — pulls defaults including `.no_perf = false` which we
        // keep (perf metrics cost essentially nothing and help debugging).
        let sparams = llama_sampler_chain_default_params()
        guard let chain = llama_sampler_chain_init(sparams) else {
            llama_free(c)
            throw LlamaRuntimeError.samplerInitFailed
        }
        // `llama_sampler_init_greedy` can't fail — returns a non-null chain node.
        llama_sampler_chain_add(chain, llama_sampler_init_greedy())
        self.samplerPtr = chain
    }

    deinit {
        llama_sampler_free(samplerPtr)
        llama_free(ctxPtr)
    }

    // MARK: Chat template

    /// Render `system` + `user` into the model's native prompt format
    /// using the chat template embedded in the GGUF (via
    /// `llama_chat_apply_template`). For Qwen2.5 this produces:
    ///
    ///     <|im_start|>system
    ///     You are ...
    ///     <|im_end|>
    ///     <|im_start|>user
    ///     Hello
    ///     <|im_end|>
    ///     <|im_start|>assistant
    ///
    /// (the trailing assistant-start sentinel is what `add_ass=true`
    /// gives us — without it the model would hallucinate another user
    /// turn instead of replying).
    ///
    /// If the model has no embedded template, `tmpl` stays nil and we
    /// pass nil into `llama_chat_apply_template` — it then picks a
    /// built-in format by sniffing message shape. If *that* fails the
    /// call returns a negative length and we throw `.chatTemplateFailed`.
    public func renderChat(
        system: String?,
        user: String
    ) throws -> String {
        let tmpl = model.embeddedChatTemplate

        // Build role/content C strings that outlive the call. strdup +
        // free is fine for 2–3 messages; it avoids nesting
        // `withCString` closures which gets unwieldy past one level.
        var cstrings: [UnsafeMutablePointer<CChar>] = []
        defer { for p in cstrings { free(p) } }

        func dup(_ s: String) -> UnsafePointer<CChar> {
            let p = strdup(s)!
            cstrings.append(p)
            return UnsafePointer(p)
        }

        var messages: [llama_chat_message] = []
        if let s = system {
            messages.append(llama_chat_message(role: dup("system"), content: dup(s)))
        }
        messages.append(llama_chat_message(role: dup("user"), content: dup(user)))

        let tmplDup = tmpl.map { strdup($0)! }
        defer { if let t = tmplDup { free(t) } }
        let tmplPtr: UnsafePointer<CChar>? = tmplDup.map { UnsafePointer($0) }

        // Try a 8 KB buffer first — enough for any sane single-turn
        // prompt. If the call returns a needed-size greater than that,
        // retry once with the exact size. Guardrail: 128 KB ceiling
        // because anything larger is almost certainly a bug (the model
        // context is 2048 tokens ~ 8 KB of text anyway).
        var bufSize: Int32 = 8192
        while true {
            var buf = [CChar](repeating: 0, count: Int(bufSize))
            let needed = messages.withUnsafeBufferPointer { mp -> Int32 in
                llama_chat_apply_template(
                    tmplPtr,
                    mp.baseAddress,
                    mp.count,
                    true,  // add_ass — append assistant-start sentinel
                    &buf,
                    bufSize
                )
            }
            if needed < 0 {
                throw LlamaRuntimeError.chatTemplateFailed(
                    "llama_chat_apply_template returned \(needed) "
                    + "(GGUF has no embedded template and llama.cpp's built-in sniffer couldn't match a known format)"
                )
            }
            if needed <= bufSize {
                return String(cString: buf)
            }
            if needed > 131072 {
                throw LlamaRuntimeError.chatTemplateFailed(
                    "rendered prompt would be \(needed) bytes, which exceeds the 128K safety cap"
                )
            }
            bufSize = needed + 64
        }
    }

    // MARK: Tokenize / detokenize

    /// Turn text into GGUF token ids.
    ///
    /// - Parameter addSpecial: usually `true` for the initial prompt
    ///   (adds BOS and any model-specific prefix). `false` when
    ///   tokenizing generated output mid-stream (where re-adding BOS
    ///   would shift positions).
    public func tokenize(_ text: String, addSpecial: Bool = true) throws -> [llama_token] {
        let byteCount = Int32(text.utf8.count)

        // First attempt: a buffer sized to byteCount + slack. Real
        // tokens-per-byte ratio is ~0.25–1.0 for English so this
        // typically holds on the first try; fall back to the
        // llama-reported required size if not.
        var capacity = Int(byteCount + 16)
        var tokens = [llama_token](repeating: 0, count: capacity)

        var produced: Int32 = text.withCString { cstr in
            llama_tokenize(
                model.vocabPtr,
                cstr,
                byteCount,
                &tokens,
                Int32(tokens.count),
                addSpecial,
                /* parse_special */ true
            )
        }

        if produced < 0 {
            // Negative return = "buffer too small; needed abs(produced)
            // entries". Resize and retry.
            capacity = Int(-produced)
            tokens = [llama_token](repeating: 0, count: capacity)
            produced = text.withCString { cstr in
                llama_tokenize(
                    model.vocabPtr,
                    cstr,
                    byteCount,
                    &tokens,
                    Int32(tokens.count),
                    addSpecial,
                    /* parse_special */ true
                )
            }
            if produced < 0 {
                throw LlamaRuntimeError.tokenizationFailed(
                    "llama_tokenize returned \(produced) even after resize to \(capacity)"
                )
            }
        }

        return Array(tokens.prefix(Int(produced)))
    }

    /// Decode a single token id into its string piece. llama.cpp
    /// token-to-piece is stateful enough (multi-byte UTF-8, special
    /// tokens) that we let it do the work rather than maintaining our
    /// own byte fallback table.
    ///
    /// `special = false` is hardcoded: callers only ever want the
    /// human-readable piece (special tokens like `<|im_end|>` should
    /// stay invisible in the streamed reply). If that ever changes,
    /// thread a parameter back through.
    public func pieceForToken(_ token: llama_token) throws -> String {
        // 256 bytes covers every real vocab piece (Qwen's longest is
        // around 32 bytes); overshoot is harmless because the string
        // read below stops at the NUL terminator llama_token_to_piece
        // writes.
        var buf = [CChar](repeating: 0, count: 256)
        let n = llama_token_to_piece(
            model.vocabPtr,
            token,
            &buf,
            Int32(buf.count),
            /* lstrip */ 0,
            /* special */ false
        )
        if n < 0 {
            // Grow and retry. Practically never triggered for sane
            // vocabs, but the API contract allows it.
            let needed = Int(-n)
            buf = [CChar](repeating: 0, count: needed + 1)
            let m = llama_token_to_piece(
                model.vocabPtr,
                token,
                &buf,
                Int32(buf.count),
                0,
                false
            )
            if m < 0 {
                throw LlamaRuntimeError.detokenizationFailed(
                    "llama_token_to_piece returned \(m) even after resize to \(buf.count)"
                )
            }
        }
        // llama_token_to_piece is not guaranteed to null-terminate —
        // it writes exactly N bytes. Use String(bytes:encoding:) with
        // the reported length to be safe.
        let byteCount = n < 0 ? Int(-n) : Int(n)
        return buf.withUnsafeBufferPointer { bp -> String in
            let raw = UnsafeRawBufferPointer(
                start: bp.baseAddress,
                count: byteCount
            )
            return String(decoding: raw.prefix(byteCount), as: UTF8.self)
        }
    }

    // MARK: Generate

    /// Greedy single-turn generation. Renders the chat, tokenizes it,
    /// runs prefill in one batch, then loops sample → decode one token
    /// at a time until EOS or `maxNewTokens`.
    ///
    /// Returns the assistant reply as a single string, trimmed of
    /// leading/trailing whitespace but NOT of the model's own
    /// punctuation or formatting.
    ///
    /// Batch-style only (no per-token callback). VoiceProbe hands the
    /// whole reply to TTS in one shot, so streaming tokens out as they
    /// arrive buys nothing. If you need a streaming UI later, thread a
    /// callback back through `pieceForToken` at the site marked below.
    public func generate(
        systemPrompt: String?,
        userPrompt: String,
        maxNewTokens: Int = 128
    ) throws -> String {
        let rendered = try renderChat(system: systemPrompt, user: userPrompt)
        let promptTokens = try tokenize(rendered, addSpecial: true)
        guard !promptTokens.isEmpty else {
            return ""
        }

        // Prefill — feed the full prompt through the context in one
        // batch. `llama_batch_get_one` is marked "avoid using" in the
        // header but is still the simplest way to build a
        // contiguous-token batch. The newer API wants you to fill
        // `token` / `pos` / `n_seq_id` / `seq_id` / `logits` buffers
        // manually; for the linear chat use case that's extra code
        // for no semantic difference.
        var mutablePrompt = promptTokens
        let prefillRc = mutablePrompt.withUnsafeMutableBufferPointer { bp -> Int32 in
            let batch = llama_batch_get_one(bp.baseAddress, Int32(bp.count))
            return llama_decode(ctxPtr, batch)
        }
        if prefillRc != 0 {
            throw LlamaRuntimeError.decodeFailed(code: prefillRc, phase: "prefill")
        }

        // Extend — sample one token, decode, repeat. The sampler
        // samples from the last logit column of the most recent
        // decode, which is exactly what we want after prefill (or
        // after the previous extend step).
        let eos = model.eosToken
        var generatedPieces: [String] = []
        var generatedCount = 0

        while generatedCount < maxNewTokens {
            let tok = llama_sampler_sample(samplerPtr, ctxPtr, /* idx */ -1)
            if tok == eos {
                break
            }

            // Streaming callers would hook in here — grab `piece`
            // before `generatedPieces.append` to emit it live.
            let piece = try pieceForToken(tok)
            generatedPieces.append(piece)
            generatedCount += 1

            // Single-token extend batch
            var tokenArr: [llama_token] = [tok]
            let rc = tokenArr.withUnsafeMutableBufferPointer { bp -> Int32 in
                let batch = llama_batch_get_one(bp.baseAddress, 1)
                return llama_decode(ctxPtr, batch)
            }
            if rc != 0 {
                throw LlamaRuntimeError.decodeFailed(code: rc, phase: "extend[\(generatedCount)]")
            }
        }

        return generatedPieces
            .joined()
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

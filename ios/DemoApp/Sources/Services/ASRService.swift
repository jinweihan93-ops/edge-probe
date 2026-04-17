import Foundation
import AVFoundation
import Speech

/// On-device ASR via Apple's Speech framework. No network, no OpenAI,
/// no third party — the mic input goes straight into `SFSpeechRecognizer`
/// with `requiresOnDeviceRecognition = true` and produces a transcript.
///
/// Why on-device only:
///   • The whole product pitch is observability for AI that runs on the
///     user's hardware. Demoing with a cloud ASR would be a lie.
///   • Speech framework's on-device path is surprisingly good for en-US
///     since iOS 16, and it ships with every phone. Zero model download,
///     zero extra frameworks. Whisper.cpp would be more accurate but
///     bigger and off-topic for the SDK demo.
///
/// This service is purposely single-turn: you call `recognize(_:)`, it
/// starts the engine, streams partials for UI, and resolves with the
/// final transcript when you call `stop()`. Multi-turn session handling
/// is app-level concern, not here.
@MainActor
final class ASRService: NSObject, ObservableObject {

    enum ASRError: Error, LocalizedError {
        case permissionDenied
        case recognizerUnavailable
        case onDeviceRecognitionUnavailable
        case audioEngineFailed(String)
        case noSpeechDetected

        var errorDescription: String? {
            switch self {
            case .permissionDenied:
                return "Microphone or Speech Recognition permission denied. Enable both in Settings → VoiceProbe."
            case .recognizerUnavailable:
                return "Speech recognizer is not available on this device for the current locale."
            case .onDeviceRecognitionUnavailable:
                return "On-device recognition is not available. The demo refuses to fall back to cloud — that would defeat the point."
            case .audioEngineFailed(let msg):
                return "Audio engine failed: \(msg)"
            case .noSpeechDetected:
                return "Couldn't hear anything. Try tapping and holding while you talk."
            }
        }
    }

    // Published state so ContentView can redraw live.
    @Published private(set) var partialTranscript: String = ""
    @Published private(set) var isRecording: Bool = false

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finalContinuation: CheckedContinuation<String, Error>?

    /// Permission gauntlet. Run once on app start or on first mic tap.
    /// Both permissions are required; either denial means we can't demo.
    ///
    /// `nonisolated` because the TCC/Speech framework callbacks fire on a
    /// background XPC-reply queue. Without this, the inner `{ granted in ... }`
    /// and `{ status in ... }` closures inherit `@MainActor` isolation from
    /// the enclosing class, and Swift 6 runtime trips a
    /// `dispatch_assert_queue_fail` SIGTRAP the moment iOS posts the
    /// authorization result — which looks exactly like the app crashing on
    /// first launch when the permission prompt returns.
    ///
    /// Mic permission API split: iOS 17 moved to `AVAudioApplication.requestRecordPermission`.
    /// Deployment target is 16.4, so we branch — the old
    /// `AVAudioSession.requestRecordPermission` is deprecated-but-available on 17
    /// and still the only option on 16.x.
    nonisolated static func requestPermissions() async -> Bool {
        let mic = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            if #available(iOS 17.0, *) {
                AVAudioApplication.requestRecordPermission { granted in c.resume(returning: granted) }
            } else {
                AVAudioSession.sharedInstance().requestRecordPermission { granted in c.resume(returning: granted) }
            }
        }
        guard mic else { return false }
        let speech = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { status in
                c.resume(returning: status == .authorized)
            }
        }
        return speech
    }

    /// Begin recording + recognition. Streams partials via `partialTranscript`.
    /// Call `stop()` to end the utterance and resolve with the final string.
    func start() throws {
        guard let recognizer, recognizer.isAvailable else {
            throw ASRError.recognizerUnavailable
        }
        guard recognizer.supportsOnDeviceRecognition else {
            throw ASRError.onDeviceRecognitionUnavailable
        }

        // Tear down any prior session.
        task?.cancel()
        task = nil
        request = nil

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            throw ASRError.audioEngineFailed(error.localizedDescription)
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true
        req.shouldReportPartialResults = true
        request = req

        let input = audioEngine.inputNode
        let recordingFormat = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak req] buffer, _ in
            req?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            throw ASRError.audioEngineFailed(error.localizedDescription)
        }

        partialTranscript = ""
        isRecording = true

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                Task { @MainActor in
                    self.partialTranscript = text
                    if result.isFinal {
                        self.finalContinuation?.resume(returning: text)
                        self.finalContinuation = nil
                    }
                }
                return
            }
            if let error {
                Task { @MainActor in
                    // The Speech framework emits one "cancelled" error if we
                    // tear down before the final result lands. Treat that as
                    // an empty transcript so the caller can decide whether to
                    // surface `noSpeechDetected` or proceed.
                    if self.finalContinuation != nil {
                        self.finalContinuation?.resume(throwing: ASRError.audioEngineFailed(error.localizedDescription))
                        self.finalContinuation = nil
                    }
                }
            }
        }
    }

    /// Stop recording and return the final transcript. Awaits the Speech
    /// framework's final result callback rather than polling `task.state`.
    func stop() async throws -> String {
        guard isRecording, let request else {
            throw ASRError.audioEngineFailed("stop() called without an active session")
        }
        isRecording = false

        let final: String = try await withCheckedThrowingContinuation { c in
            self.finalContinuation = c
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
            request.endAudio() // triggers the final-result callback
        }

        self.task = nil
        self.request = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        guard !final.isEmpty else {
            throw ASRError.noSpeechDetected
        }
        return final
    }
}

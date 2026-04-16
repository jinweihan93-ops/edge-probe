import Foundation
import AVFoundation

/// TTS via `AVSpeechSynthesizer`. Built-in, on-device, zero setup.
/// The demo's point isn't TTS quality — it's showing a real span duration
/// in the waterfall between the LLM finishing and the user hearing the
/// reply. So we use the simplest thing that speaks out loud.
@MainActor
final class TTSService: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {

    @Published private(set) var isSpeaking: Bool = false

    private let synth = AVSpeechSynthesizer()
    private var finishContinuation: CheckedContinuation<Void, Never>?

    override init() {
        super.init()
        synth.delegate = self
    }

    /// Speak `text` and return when the utterance finishes (or is interrupted).
    /// Honest duration — the span timing includes the full audible playback.
    func speak(_ text: String) async {
        guard !text.isEmpty else { return }

        // Route to speaker, not earpiece.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)

        let utt = AVSpeechUtterance(string: text)
        utt.rate = AVSpeechUtteranceDefaultSpeechRate
        utt.voice = AVSpeechSynthesisVoice(language: "en-US")

        isSpeaking = true
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            self.finishContinuation = c
            self.synth.speak(utt)
        }
        isSpeaking = false
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - AVSpeechSynthesizerDelegate

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.finishContinuation?.resume()
            self.finishContinuation = nil
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.finishContinuation?.resume()
            self.finishContinuation = nil
        }
    }
}

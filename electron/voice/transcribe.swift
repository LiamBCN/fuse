// On-device speech-to-text helper for Fuse. Captures the microphone with
// AVAudioEngine and transcribes live with Apple's Speech framework, printing
// JSON lines to stdout: {"ready":true}, {"text":"..."} (cumulative), {"error":..}.
//
// macOS Speech finalizes a "segment" after a pause and then resets the live
// transcription to the next phrase. To keep dictation continuous (so earlier
// text is never lost), we accumulate finalized segments and start a fresh
// recognition request after each one.
import Foundation
import Speech
import AVFoundation

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       var s = String(data: data, encoding: .utf8) {
        s += "\n"
        FileHandle.standardOutput.write(s.data(using: .utf8)!)
    }
}

let engine = AVAudioEngine()
var recognizer: SFSpeechRecognizer?
var currentRequest: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
var finalized = ""   // text committed from earlier segments this session
var restarts = 0     // guard against runaway restart loops

func beginSegment() {
    guard let recognizer = recognizer else { return }
    restarts += 1
    if restarts > 300 { return } // safety: don't loop forever on persistent errors
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if #available(macOS 10.15, *), recognizer.supportsOnDeviceRecognition {
        req.requiresOnDeviceRecognition = true
    }
    currentRequest = req
    task = recognizer.recognitionTask(with: req) { result, error in
        if let result = result {
            restarts = 0 // healthy output - reset the guard
            let seg = result.bestTranscription.formattedString
            let combined = finalized.isEmpty ? seg : finalized + " " + seg
            emit(["text": combined])
            if result.isFinal {
                finalized = combined
                beginSegment() // keep listening; earlier text preserved
            }
        } else if error != nil {
            // Segment ended (usually a pause/timeout). Continue listening.
            beginSegment()
        }
    }
}

func startEngine() {
    guard let r = SFSpeechRecognizer(locale: Locale.current)
        ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else {
        emit(["error": "No speech recognizer available for this locale."]); exit(1)
    }
    if !r.isAvailable {
        emit(["error": "Speech recognizer is not available right now."]); exit(1)
    }
    recognizer = r
    let node = engine.inputNode
    let format = node.outputFormat(forBus: 0)
    node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        currentRequest?.append(buffer)
    }
    engine.prepare()
    do {
        try engine.start()
    } catch {
        emit(["error": "Could not start audio: \(error.localizedDescription)"]); exit(1)
    }
    emit(["ready": true])
    beginSegment()
}

func requestMicThenStart() {
    if #available(macOS 10.14, *) {
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            if granted {
                DispatchQueue.main.async { startEngine() }
            } else {
                emit(["error": "Microphone permission denied. Enable it in System Settings ▸ Privacy & Security ▸ Microphone."]); exit(1)
            }
        }
    } else {
        DispatchQueue.main.async { startEngine() }
    }
}

typealias SigHandler = @convention(c) (Int32) -> Void
let stopHandler: SigHandler = { _ in exit(0) }
signal(SIGTERM, stopHandler)
signal(SIGINT, stopHandler)

SFSpeechRecognizer.requestAuthorization { status in
    switch status {
    case .authorized:
        requestMicThenStart()
    case .denied:
        emit(["error": "Speech Recognition permission denied. Enable it in System Settings ▸ Privacy & Security ▸ Speech Recognition."]); exit(1)
    case .restricted:
        emit(["error": "Speech Recognition is restricted on this Mac."]); exit(1)
    case .notDetermined:
        emit(["error": "Speech Recognition was not authorized."]); exit(1)
    @unknown default:
        exit(1)
    }
}

RunLoop.main.run()

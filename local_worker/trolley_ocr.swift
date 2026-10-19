import Foundation
import Vision
import ImageIO

// Local evidence only. Images and OCR are never sent to an external service.
guard CommandLine.arguments.count == 2,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(2) }
let textRequest = VNRecognizeTextRequest()
textRequest.recognitionLevel = .accurate
textRequest.usesLanguageCorrection = false
textRequest.recognitionLanguages = ["en-US"]
let barcodeRequest = VNDetectBarcodesRequest()
barcodeRequest.symbologies = [.qr, .code128, .code39]
do {
    try VNImageRequestHandler(cgImage: image).perform([textRequest, barcodeRequest])
    let texts = (textRequest.results ?? []).compactMap { observation -> [String: Any]? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return ["text": candidate.string, "confidence": candidate.confidence,
                "x": box.midX, "y": box.midY, "width": box.width, "height": box.height]
    }
    let codes = (barcodeRequest.results ?? []).compactMap { observation -> [String: Any]? in
        guard let payload = observation.payloadStringValue else { return nil }
        let box = observation.boundingBox
        return ["text": payload, "confidence": observation.confidence,
                "x": box.midX, "y": box.midY, "width": box.width, "height": box.height]
    }
    let data = try JSONSerialization.data(withJSONObject: ["texts": texts, "barcodes": codes])
    FileHandle.standardOutput.write(data)
} catch { exit(3) }

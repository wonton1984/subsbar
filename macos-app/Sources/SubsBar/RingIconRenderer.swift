import AppKit
import SubsCore

@MainActor enum RingIconRenderer {
    static func draw(_ fraction: Double?, name: String, hasKnownAmount: Bool = false, appearance: NSAppearance) -> NSImage {
        let gauge = RingGauge(fraction, hasKnownAmount: hasKnownAmount)
        let image = NSImage(size: NSSize(width: 20, height: 20))
        appearance.performAsCurrentDrawingAppearance {
            for scale in [1, 2] {
                let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 20 * scale, pixelsHigh: 20 * scale, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
                NSGraphicsContext.saveGraphicsState()
                let context = NSGraphicsContext(bitmapImageRep: rep)!
                NSGraphicsContext.current = context
                context.cgContext.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
                context.shouldAntialias = true
                let track = NSBezierPath(ovalIn: NSRect(x: 1.25, y: 1.25, width: 17.5, height: 17.5))
                track.lineWidth = 1.5
                if gauge.dashed {
                    track.setLineDash([2, 1.5], count: 2, phase: 0)
                    NSColor.secondaryLabelColor.setStroke()
                } else { NSColor.secondaryLabelColor.withAlphaComponent(0.24).setStroke() }
                track.stroke()
                if gauge.sweepDegrees > 0 {
                    let arc = NSBezierPath()
                    arc.lineWidth = 1.5; arc.lineCapStyle = .butt
                    arc.appendArc(withCenter: NSPoint(x: 10, y: 10), radius: 8.75, startAngle: 90, endAngle: gauge.endDegrees, clockwise: true)
                    quotaColor(gauge.fraction).setStroke(); arc.stroke()
                }
                if gauge.fraction == 0 {
                    // Empty quota has no arc; a red origin marker distinguishes it from unknown.
                    quotaColor(0).setFill()
                    NSBezierPath(ovalIn: NSRect(x: 9.25, y: 18, width: 1.5, height: 1.5)).fill()
                }
                let label = String(name.prefix(3)) as NSString
                var font = NSFont.systemFont(ofSize: 7, weight: .bold)
                while label.size(withAttributes: [.font: font]).width > 14 && font.pointSize > 5 {
                    font = NSFont.systemFont(ofSize: font.pointSize - 0.25, weight: .bold)
                }
                let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.labelColor]
                let size = label.size(withAttributes: attributes)
                label.draw(at: NSPoint(x: (20 - size.width) / 2, y: (20 - size.height) / 2), withAttributes: attributes)
                NSGraphicsContext.restoreGraphicsState()
                rep.size = image.size; image.addRepresentation(rep)
            }
        }
        image.isTemplate = false
        return image
    }
    static func verify(at directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for mode in [NSAppearance.Name.aqua, .darkAqua] {
            for (name, fraction) in [("unknown", nil), ("zero", 0.0), ("red", 0.07), ("orange", 0.2), ("half", 0.5), ("green", 0.83), ("full", 1.0)] as [(String, Double?)] {
                let image = draw(fraction, name: "Cod", appearance: NSAppearance(named: mode)!)
                precondition(!image.isTemplate && image.size == NSSize(width: 20, height: 20))
                for (index, representation) in image.representations.enumerated() {
                    let rep = representation as! NSBitmapImageRep
                    precondition(rep.pixelsWide == 20 * (index + 1) && rep.pixelsHigh == 20 * (index + 1))
                    try rep.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("\(mode.rawValue)-\(name)-\(index + 1)x.png"))
                }
            }
        }
        print("PASS: 28 ring PNGs, 20/40px, 20pt, light/dark, non-template")
    }
}

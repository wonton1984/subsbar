import AppKit
import SubsCore

@MainActor enum PieIconRenderer {
    static func verify(at directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for mode in [NSAppearance.Name.aqua, .darkAqua] {
            for (name, fraction) in [("unknown", nil), ("zero", 0.0), ("kimi", 0.07), ("orange", 0.2), ("half", 0.5), ("opencode", 0.83), ("full", 1.0)] as [(String, Double?)] {
                let image = draw(fraction, appearance: NSAppearance(named: mode)!)
                precondition(!image.isTemplate && image.size == NSSize(width: 18, height: 18))
                for (index, representation) in image.representations.enumerated() {
                    let rep = representation as! NSBitmapImageRep
                    precondition(rep.pixelsWide == 18 * (index + 1) && rep.pixelsHigh == 18 * (index + 1))
                    let png = rep.representation(using: .png, properties: [:])!
                    try png.write(to: directory.appendingPathComponent("\(mode.rawValue)-\(name)-\(index + 1)x.png"))
                }
            }
        }
        print("PASS: 28 icon PNGs, 18/36px, 18pt, light/dark, non-template")
    }

    static func draw(_ fraction: Double?, appearance: NSAppearance) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18))
        appearance.performAsCurrentDrawingAppearance {
            for scale in [1, 2] {
                let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 18 * scale, pixelsHigh: 18 * scale, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
                // Keep pixel size during drawing; assign logical size after rasterization.
                NSGraphicsContext.saveGraphicsState()
                let context = NSGraphicsContext(bitmapImageRep: rep)!
                NSGraphicsContext.current = context
                context.cgContext.scaleBy(x: CGFloat(scale), y: CGFloat(scale)); context.shouldAntialias = true
                let disk = NSBezierPath(ovalIn: NSRect(x: 1, y: 1, width: 16, height: 16))
                quotaColor(fraction).withAlphaComponent(0.20).setFill(); disk.fill()
                quotaColor(fraction).setStroke(); disk.lineWidth = 1; disk.stroke()
                quotaColor(fraction).setFill()
                if let f = fraction {
                    if f >= 1 { disk.fill() }
                    else if f > 0 {
                        let sector = NSBezierPath(); sector.move(to: NSPoint(x: 9, y: 9))
                        sector.appendArc(withCenter: NSPoint(x: 9, y: 9), radius: 8, startAngle: 90, endAngle: 90 - f * 360, clockwise: true)
                        sector.close(); sector.fill()
                    }
                } else {
                    let dash = NSBezierPath(); dash.move(to: NSPoint(x: 6, y: 9)); dash.line(to: NSPoint(x: 12, y: 9)); dash.lineWidth = 1.5; dash.stroke()
                }
                NSGraphicsContext.restoreGraphicsState(); rep.size = image.size; image.addRepresentation(rep)
            }
        }
        image.isTemplate = false
        return image
    }
}

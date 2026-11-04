import AppKit

func writePNG(
    size: NSSize,
    scale: CGFloat,
    background: NSColor?,
    glyphRect: NSRect,
    to path: String
) throws {
    let width = Int(size.width * scale)
    let height = Int(size.height * scale)
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: rep) else { return }
    rep.size = size

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    let transform = NSAffineTransform()
    transform.translateX(by: 0, yBy: size.height * scale)
    transform.scaleX(by: scale, yBy: -scale)
    transform.concat()

    if let background {
        background.setFill()
        NSRect(origin: .zero, size: size).fill()
    }
    MenuBarIcon.drawGlyph(in: glyphRect)

    NSGraphicsContext.restoreGraphicsState()
    guard let data = rep.representation(using: .png, properties: [:]) else { return }
    try data.write(to: URL(fileURLWithPath: path))
}

@main
struct Preview {
    static func main() throws {
        try writePNG(
            size: NSSize(width: 216, height: 216),
            scale: 1,
            background: NSColor.white,
            glyphRect: NSRect(x: 0, y: 0, width: 216, height: 216),
            to: "/tmp/qieji-menubar-large.png"
        )
        try writePNG(
            size: NSSize(width: 72, height: 72),
            scale: 1,
            background: NSColor.white,
            glyphRect: NSRect(x: 0, y: 0, width: 72, height: 72),
            to: "/tmp/qieji-menubar-72.png"
        )
        for (name, x) in [("left", 12.0), ("right", 330.0)] {
            try writePNG(
                size: NSSize(width: 360, height: 40),
                scale: 2,
                background: NSColor(srgbRed: 0.93, green: 0.93, blue: 0.93, alpha: 1),
                glyphRect: NSRect(x: x, y: 11, width: 18, height: 18),
                to: "/tmp/qieji-menubar-bar-\(name).png"
            )
        }
        print("ok")
    }
}

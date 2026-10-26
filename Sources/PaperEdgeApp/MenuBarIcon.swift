import AppKit

enum MenuBarIcon {
    static let size = NSSize(width: 18, height: 18)

    static func make() -> NSImage {
        let image = NSImage(size: size, flipped: true) { _ in
            drawGlyph(in: NSRect(origin: .zero, size: size))
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "且记"
        return image
    }

    // Coordinates use a top-left origin inside an 18 x 18 box.
    static func drawGlyph(in bounds: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState()
        context.translateBy(x: bounds.origin.x, y: bounds.origin.y)
        context.scaleBy(x: bounds.width / size.width, y: bounds.height / size.height)

        NSColor.black.setStroke()
        NSColor.black.setFill()

        let page = NSBezierPath()
        page.lineWidth = 1.35
        page.lineCapStyle = .round
        page.lineJoinStyle = .round
        page.move(to: NSPoint(x: 4.4, y: 2.7))
        page.curve(
            to: NSPoint(x: 8.7, y: 2.9),
            controlPoint1: NSPoint(x: 6.0, y: 2.4),
            controlPoint2: NSPoint(x: 7.4, y: 3.0)
        )
        page.curve(
            to: NSPoint(x: 12.8, y: 2.5),
            controlPoint1: NSPoint(x: 10.2, y: 2.8),
            controlPoint2: NSPoint(x: 11.6, y: 2.4)
        )
        page.curve(
            to: NSPoint(x: 13.2, y: 11.6),
            controlPoint1: NSPoint(x: 13.3, y: 4.8),
            controlPoint2: NSPoint(x: 13.4, y: 8.4)
        )
        page.line(to: NSPoint(x: 12.0, y: 15.0))
        page.curve(
            to: NSPoint(x: 8.1, y: 15.3),
            controlPoint1: NSPoint(x: 10.4, y: 15.1),
            controlPoint2: NSPoint(x: 9.2, y: 15.4)
        )
        page.curve(
            to: NSPoint(x: 4.2, y: 15.0),
            controlPoint1: NSPoint(x: 6.9, y: 15.2),
            controlPoint2: NSPoint(x: 5.6, y: 14.9)
        )
        page.curve(
            to: NSPoint(x: 4.4, y: 2.7),
            controlPoint1: NSPoint(x: 3.4, y: 11.8),
            controlPoint2: NSPoint(x: 5.2, y: 6.2)
        )
        page.stroke()

        let fold = NSBezierPath()
        fold.move(to: NSPoint(x: 13.2, y: 11.6))
        fold.curve(
            to: NSPoint(x: 14.9, y: 14.4),
            controlPoint1: NSPoint(x: 14.2, y: 12.3),
            controlPoint2: NSPoint(x: 14.7, y: 13.4)
        )
        fold.curve(
            to: NSPoint(x: 12.0, y: 15.0),
            controlPoint1: NSPoint(x: 14.3, y: 14.9),
            controlPoint2: NSPoint(x: 13.2, y: 15.1)
        )
        fold.close()
        fold.fill()

        let rules = NSBezierPath()
        rules.lineWidth = 1.35
        rules.lineCapStyle = .round
        rules.move(to: NSPoint(x: 6.5, y: 7.1))
        rules.line(to: NSPoint(x: 11.3, y: 6.8))
        rules.move(to: NSPoint(x: 6.5, y: 10.6))
        rules.line(to: NSPoint(x: 10.9, y: 10.3))
        rules.stroke()

        context.restoreGState()
    }
}

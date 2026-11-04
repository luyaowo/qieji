import AppKit

/// WKWebView needs its main run loop free while the printing thread requests PDF data.
final class WebPrintSession: NSObject {
    private var operation: NSPrintOperation?
    private var completion: ((Bool) -> Void)?

    @discardableResult
    func run(
        _ operation: NSPrintOperation,
        for window: NSWindow,
        completion: ((Bool) -> Void)? = nil
    ) -> Bool {
        precondition(Thread.isMainThread)
        guard self.operation == nil else { return false }
        self.operation = operation
        self.completion = completion
        operation.canSpawnSeparateThread = true
        operation.runModal(
            for: window,
            delegate: self,
            didRun: #selector(didFinish(_:success:contextInfo:)),
            contextInfo: nil
        )
        return true
    }

    @objc private func didFinish(
        _ operation: NSPrintOperation,
        success: Bool,
        contextInfo: UnsafeMutableRawPointer?
    ) {
        // AppKit may call this on its printing thread. Release state on the main thread.
        DispatchQueue.main.async { [self] in
            guard self.operation === operation else { return }
            self.operation = nil
            let callback = completion
            completion = nil
            callback?(success)
        }
    }
}

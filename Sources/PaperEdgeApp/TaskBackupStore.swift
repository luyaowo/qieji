import Foundation
import WebKit

final class TaskBackupStore {
    enum StoreError: LocalizedError {
        case invalidWorkspace
        var errorDescription: String? { "任务数据不完整，无法创建备份" }
    }
    private let fileManager: FileManager
    private let directoryURL: URL
    private let currentURL: URL
    private let previousURL: URL
    private var workspaceURL: URL { directoryURL.appendingPathComponent("workspace.json") }
    private var previousWorkspaceURL: URL { directoryURL.appendingPathComponent("workspace-previous.json") }
    var backupDirectoryURL: URL { directoryURL.appendingPathComponent("Backups", isDirectory: true) }

    init(fileManager: FileManager = .default, directoryURL: URL? = nil) {
        self.fileManager = fileManager
        let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        self.directoryURL = directoryURL ?? applicationSupport.appendingPathComponent("且记", isDirectory: true)
        currentURL = self.directoryURL.appendingPathComponent("tasks.json")
        previousURL = self.directoryURL.appendingPathComponent("tasks-previous.json")
    }

    func readWorkspace() -> [String: Any]? {
        guard let data = validWorkspaceData(at: workspaceURL) ?? validWorkspaceData(at: previousWorkspaceURL) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func checkpoint(_ workspace: Any) throws -> URL {
        guard isValidWorkspace(workspace) else { throw StoreError.invalidWorkspace }
        let data = try JSONSerialization.data(withJSONObject: workspace, options: [.prettyPrinted, .sortedKeys])
        try fileManager.createDirectory(at: backupDirectoryURL, withIntermediateDirectories: true)
        let timestamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let url = backupDirectoryURL.appendingPathComponent("workspace-before-import-\(timestamp)-\(UUID().uuidString).json")
        try data.write(to: url, options: .atomic)
        return url
    }

    func bootstrapUserScript() -> WKUserScript {
        let payload = currentTasksData()
            .flatMap { String(data: $0, encoding: .utf8) }
            ?? "null"
        let workspace = (validWorkspaceData(at: workspaceURL) ?? validWorkspaceData(at: previousWorkspaceURL))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        return WKUserScript(
            source: "window.__QIEJI_NATIVE_BACKUP__ = \(payload); window.__QIEJI_NATIVE_WORKSPACE__ = \(workspace);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }

    @discardableResult
    func saveWorkspace(_ value: Any?) -> Bool {
        guard let value, let workspace = value as? [String: Any], isValidWorkspace(workspace) else { return false }
        if let current = validWorkspaceData(at: workspaceURL), hasSameContent(workspace, as: current) {
            return true
        }
        guard let data = try? JSONSerialization.data(withJSONObject: stamp(workspace), options: [.sortedKeys]) else {
            return false
        }
        do {
            try fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
            if let current = validWorkspaceData(at: workspaceURL) {
                try current.write(to: previousWorkspaceURL, options: .atomic)
            }
            try data.write(to: workspaceURL, options: .atomic)
            return true
        } catch {
            NSLog("且记工作区备份失败：%@", error.localizedDescription)
            return false
        }
    }

    private func hasSameContent(_ workspace: [String: Any], as data: Data) -> Bool {
        guard let current = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        var incoming = workspace
        var previous = current
        incoming.removeValue(forKey: "updatedAt")
        previous.removeValue(forKey: "updatedAt")
        guard let left = try? JSONSerialization.data(withJSONObject: incoming, options: [.sortedKeys]),
              let right = try? JSONSerialization.data(withJSONObject: previous, options: [.sortedKeys]) else {
            return false
        }
        return left == right
    }

    private func stamp(_ workspace: [String: Any]) -> [String: Any] {
        var stamped = workspace
        let rawIncoming = (workspace["updatedAt"] as? NSNumber)?.int64Value ?? 0
        let rawCurrent = (try? Data(contentsOf: workspaceURL))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            .flatMap { ($0["updatedAt"] as? NSNumber)?.int64Value } ?? 0
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let ceiling = now + 86_400_000
        let incoming = min(max(rawIncoming, 0), ceiling)
        let current = min(max(rawCurrent, 0), ceiling)
        stamped["updatedAt"] = max(now, incoming + 1, current + 1)
        return stamped
    }

    private func validWorkspaceData(at url: URL) -> Data? {
        guard let data = try? Data(contentsOf: url),
              let value = try? JSONSerialization.jsonObject(with: data), isValidWorkspace(value) else { return nil }
        return data
    }

    private func isValidWorkspace(_ value: Any) -> Bool {
        guard let workspace = value as? [String: Any],
              let tasks = workspace["tasks"], isValidTaskList(tasks),
              let trash = workspace["trash"] as? [[String: Any]] else { return false }
        return trash.allSatisfy { entry in
            guard let task = entry["task"], entry["id"] is String,
                  entry["index"] is NSNumber, entry["deletedAt"] is NSNumber else { return false }
            return isValidTaskList([task])
        }
    }

    private func currentTasksData() -> Data? {
        validTasksData(at: currentURL) ?? validTasksData(at: previousURL)
    }

    private func validTasksData(at url: URL) -> Data? {
        guard
            let data = try? Data(contentsOf: url),
            let value = try? JSONSerialization.jsonObject(with: data),
            isValidTaskList(value)
        else { return nil }
        return data
    }

    private func isValidTaskList(_ value: Any) -> Bool {
        guard let tasks = value as? [Any] else { return false }
        return tasks.allSatisfy { item in
            guard let task = item as? [String: Any] else { return false }
            return task["id"] is String
                && task["text"] is String
                && task["group"] is String
                && task["done"] is Bool
        }
    }
}


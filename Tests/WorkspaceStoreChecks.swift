import Foundation

// Real file behavior, compiled with the production store. No XCTest or Testing
// macro plugin is required; every failing case contributes to a nonzero exit.
@main struct WorkspaceStoreChecks {
    enum Failure: Error { case failed(String) }
    static func expect(_ value: Bool, _ message: String) throws {
        if !value { throw Failure.failed(message) }
    }
    static func workspace(_ text: String = "合成任务") -> [String: Any] {
        ["version": 2, "tasks": [["id": "a", "text": text, "group": "today", "done": false,
            "html": "<strong>合成任务</strong>", "remindAt": "2030-01-01T08:00:00Z"]],
         "trash": [["id": "r", "task": ["id": "b", "text": "已删除的合成任务", "group": "upcoming", "done": true],
                    "index": 1, "deletedAt": 100]]]
    }
    static func canonical(_ object: Any) throws -> Data {
        var value = object
        if var workspace = value as? [String: Any] {
            workspace.removeValue(forKey: "updatedAt")
            value = workspace
        }
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
    static func read(_ store: TaskBackupStore) throws -> Data {
        guard let value = store.readWorkspace() else { throw Failure.failed("工作区为空或不可读取") }
        return try canonical(value)
    }
    static func fileCanonical(_ url: URL) throws -> Data {
        try canonical(JSONSerialization.jsonObject(with: Data(contentsOf: url)))
    }
    static func main() {
        let checks: [(String, (TaskBackupStore, URL) throws -> Void)] = [
            ("保存重载保留任务、格式、提醒和回收记录", { store, directory in
                let value = workspace(); try expect(store.saveWorkspace(value), "保存失败")
                try expect(read(TaskBackupStore(directoryURL: directory)) == canonical(value), "重载内容改变")
            }),
            ("保存写入递增的更新时间", { store, directory in
                try expect(store.saveWorkspace(workspace("第一版")), "第一次保存失败")
                let first = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("workspace.json"))) as? [String: Any]
                try expect(store.saveWorkspace(workspace("第二版")), "第二次保存失败")
                let second = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("workspace.json"))) as? [String: Any]
                let one = (first?["updatedAt"] as? NSNumber)?.int64Value ?? 0
                let two = (second?["updatedAt"] as? NSNumber)?.int64Value ?? 0
                try expect(one > 0 && two > one, "更新时间没有递增")
            }),
            ("内容相同时不刷新时间也不覆盖上一版", { store, directory in
                let value = workspace()
                try expect(store.saveWorkspace(value), "保存失败")
                let before = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("workspace.json"))) as? [String: Any]
                try expect(store.saveWorkspace(value), "重复保存失败")
                let after = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("workspace.json"))) as? [String: Any]
                try expect((before?["updatedAt"] as? NSNumber)?.int64Value == (after?["updatedAt"] as? NSNumber)?.int64Value, "时间被刷新")
            }),
            ("第二次保存保留上一版", { store, directory in
                let first = workspace("第一版"), second = workspace("第二版")
                try expect(store.saveWorkspace(first) && store.saveWorkspace(second), "保存失败")
                try expect(fileCanonical(directory.appendingPathComponent("workspace-previous.json")) == canonical(first), "上一版丢失")
                try expect(read(store) == canonical(second), "当前版错误")
            }),
            ("当前文件损坏时回退上一版", { store, directory in
                let first = workspace("可恢复版本")
                try expect(store.saveWorkspace(first) && store.saveWorkspace(workspace("新版本")), "准备失败")
                try Data("not-json".utf8).write(to: directory.appendingPathComponent("workspace.json"))
                try expect(read(store) == canonical(first), "未恢复上一版")
            }),
            ("非法数据不会覆盖当前工作区", { store, _ in
                let value = workspace(); try expect(store.saveWorkspace(value), "准备失败")
                try expect(!store.saveWorkspace(["tasks": "invalid", "trash": []]), "接受非法数据")
                try expect(read(store) == canonical(value), "合法数据被覆盖")
            }),
            ("空工作区不会变回示例", { store, _ in
                let empty: [String: Any] = ["version": 2, "tasks": [], "trash": []]
                try expect(store.saveWorkspace(empty), "保存失败")
                try expect(read(store) == canonical(empty), "空工作区改变")
            }),
            ("写盘失败返回失败状态", { store, directory in
                try FileManager.default.createDirectory(at: directory.appendingPathComponent("workspace.json"), withIntermediateDirectories: true)
                try expect(!store.saveWorkspace(workspace()), "隐藏了写盘失败")
            }),
            ("导入前备份唯一且不随当前工作区改变", { store, _ in
                let before = workspace("导入前")
                let first = try store.checkpoint(before), second = try store.checkpoint(before)
                try expect(first != second && first.deletingLastPathComponent() == store.backupDirectoryURL, "备份路径错误")
                try expect(store.saveWorkspace(workspace("导入后")), "后续保存失败")
                try expect(canonical(JSONSerialization.jsonObject(with: Data(contentsOf: first))) == canonical(before), "备份被覆盖")
                try expect(canonical(JSONSerialization.jsonObject(with: Data(contentsOf: second))) == canonical(before), "第二份备份被覆盖")
            }),
            ("非法备份被拒绝且不创建目录", { store, _ in
                var rejected = false
                do { _ = try store.checkpoint(["tasks": [], "trash": "invalid"]) } catch { rejected = true }
                try expect(rejected && !FileManager.default.fileExists(atPath: store.backupDirectoryURL.path), "错误数据产生了备份")
            })
        ]
        var failures = 0
        for (name, check) in checks {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("qieji-store-test-" + UUID().uuidString)
            do { try check(TaskBackupStore(directoryURL: directory), directory); print("PASS: " + name) }
            catch { failures += 1; print("FAIL: \(name): \(error)") }
            if FileManager.default.fileExists(atPath: directory.path) { try? FileManager.default.removeItem(at: directory) }
        }
        print("Workspace store: \(checks.count - failures)/\(checks.count) passed")
        exit(failures == 0 ? 0 : 1)
    }
}

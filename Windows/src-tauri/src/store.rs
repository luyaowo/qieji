use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::NamedTempFile;

pub const MAX_IMPORT_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_IMPORT_RECORDS: usize = 20_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedWorkspace {
    pub workspace: Option<Value>,
    pub recovered: bool,
}

pub struct Store {
    directory: PathBuf,
}

pub fn validate(workspace: &Value) -> Result<(), String> {
    let invalid = || "文件不是有效的且记工作区，原始文件未修改。".to_string();
    if workspace.get("version").and_then(Value::as_u64) != Some(2)
        || workspace
            .get("format")
            .is_some_and(|v| v != "qieji-workspace")
    {
        return Err(invalid());
    }
    let tasks = workspace
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let trash = workspace
        .get("trash")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let mut task_ids = HashSet::new();
    let mut entry_ids = HashSet::new();
    for task in tasks {
        validate_task(task, &mut task_ids)?;
    }
    for entry in trash {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(invalid)?;
        if !entry_ids.insert(id.to_string())
            || entry.get("index").and_then(Value::as_u64).is_none()
            || entry.get("deletedAt").and_then(Value::as_u64).is_none()
        {
            return Err(invalid());
        }
        validate_task(entry.get("task").ok_or_else(invalid)?, &mut task_ids)?;
    }
    Ok(())
}

fn validate_task(task: &Value, ids: &mut HashSet<String>) -> Result<(), String> {
    let invalid = || "任务记录不完整或存在重复标识，未写入文件。".to_string();
    let id = task
        .get("id")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(invalid)?;
    if !ids.insert(id.to_string())
        || task.get("text").and_then(Value::as_str).is_none()
        || task.get("done").and_then(Value::as_bool).is_none()
        || !matches!(
            task.get("group").and_then(Value::as_str),
            Some("today" | "tomorrow" | "upcoming")
        )
    {
        return Err(invalid());
    }
    for field in ["html", "remindAt", "snoozedUntil"] {
        if task
            .get(field)
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return Err(invalid());
        }
    }
    if task.get("repeat").is_some_and(|v| {
        !v.is_null() && !matches!(v.as_str(), Some("daily" | "weekdays" | "weekly"))
    }) {
        return Err(invalid());
    }
    Ok(())
}

pub fn same_content(a: &Value, b: &Value) -> bool {
    fn content(value: &Value) -> Value {
        let mut value = value.clone();
        if let Some(obj) = value.as_object_mut() {
            for key in ["updatedAt", "format", "exportedAt"] {
                obj.remove(key);
            }
        }
        value
    }
    content(a) == content(b)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("保存位置无效。")?;
    fs::create_dir_all(directory).map_err(|_| "无法创建保存目录，请检查文件权限和磁盘空间。")?;
    let mut temporary = NamedTempFile::new_in(directory)
        .map_err(|_| "无法创建临时文件，请检查文件权限和磁盘空间。")?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "写入文件失败，原始文件未替换。")?;
    temporary
        .persist(path)
        .map_err(|_| "无法替换文件，请检查权限或文件是否被其他程序占用。")?;
    Ok(())
}

impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }
    pub fn directory(&self) -> &Path {
        &self.directory
    }
    fn current(&self) -> PathBuf {
        self.directory.join("workspace.json")
    }
    fn previous(&self) -> PathBuf {
        self.directory.join("workspace-previous.json")
    }

    fn read_valid(path: &Path) -> Option<Value> {
        let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
        validate(&value).ok()?;
        Some(value)
    }

    pub fn load(&self) -> Result<LoadedWorkspace, String> {
        if let Some(workspace) = Self::read_valid(&self.current()) {
            return Ok(LoadedWorkspace {
                workspace: Some(workspace),
                recovered: false,
            });
        }
        if let Some(workspace) = Self::read_valid(&self.previous()) {
            return Ok(LoadedWorkspace {
                workspace: Some(workspace),
                recovered: true,
            });
        }
        if self.current().exists() || self.previous().exists() {
            return Err(
                "当前工作区和上一版都无法读取。已保留原始文件，请先恢复备份，再重新读取。".into(),
            );
        }
        Ok(LoadedWorkspace {
            workspace: None,
            recovered: false,
        })
    }

    pub fn save(&self, mut workspace: Value) -> Result<Value, String> {
        validate(&workspace)?;
        let loaded = self.load()?;
        if let Some(current) = &loaded.workspace {
            if !loaded.recovered && same_content(current, &workspace) {
                return Ok(current.clone());
            }
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "系统时间无效。")?
            .as_millis() as u64;
        let stamp = |w: &Value| {
            w.get("updatedAt")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(now.saturating_add(86_400_000))
        };
        let previous_stamp = loaded.workspace.as_ref().map(stamp).unwrap_or(0);
        let next_stamp = now
            .max(stamp(&workspace))
            .max(previous_stamp)
            .saturating_add(1);
        let object = workspace.as_object_mut().ok_or("任务数据无效。")?;
        object.remove("format");
        object.remove("exportedAt");
        object.insert("updatedAt".into(), json!(next_stamp));
        if let Some(previous) = loaded.workspace {
            atomic_write(
                &self.previous(),
                &serde_json::to_vec(&previous).map_err(|_| "工作区编码失败。")?,
            )?;
        }
        atomic_write(
            &self.current(),
            &serde_json::to_vec(&workspace).map_err(|_| "工作区编码失败。")?,
        )?;
        Ok(workspace)
    }

    pub fn import(&self, before: &Value, next: Value) -> Result<Value, String> {
        validate(before)?;
        validate(&next)?;
        let current = self
            .load()?
            .workspace
            .ok_or("请先保存当前工作区，再导入任务。")?;
        if !same_content(&current, before) {
            return Err("当前工作区已变化，请重新预览导入。".into());
        }
        let directory = self.directory.join("Backups");
        fs::create_dir_all(&directory).map_err(|_| "无法创建导入前备份，已取消导入。")?;
        let mut checkpoint = tempfile::Builder::new()
            .prefix("workspace-before-import-")
            .suffix(".json")
            .tempfile_in(&directory)
            .map_err(|_| "无法创建导入前备份，已取消导入。")?;
        checkpoint
            .write_all(&serde_json::to_vec_pretty(&current).map_err(|_| "备份编码失败。")?)
            .and_then(|_| checkpoint.as_file().sync_all())
            .map_err(|_| "导入前备份写入失败，已取消导入。")?;
        checkpoint
            .keep()
            .map_err(|_| "导入前备份保存失败，已取消导入。")?;
        self.save(next)
    }
}

pub fn read_import(path: &Path) -> Result<Value, String> {
    let size = fs::metadata(path).map_err(|_| "无法读取所选文件。")?.len();
    if size > MAX_IMPORT_BYTES {
        return Err("导入文件超过 20 MB，未导入。".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "无法读取所选文件。")?
        .take(MAX_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取所选文件。")?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err("导入文件超过 20 MB，未导入。".into());
    }
    let incoming: Value =
        serde_json::from_slice(&bytes).map_err(|_| "所选文件不是有效 JSON，未导入。")?;
    validate(&incoming)?;
    let count =
        incoming["tasks"].as_array().unwrap().len() + incoming["trash"].as_array().unwrap().len();
    if count > MAX_IMPORT_RECORDS {
        return Err("导入记录超过 20,000 条，未导入。".into());
    }
    Ok(incoming)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace(text: &str) -> Value {
        json!({"version":2,"tasks":[{"id":"task-1","text":text,"group":"today","done":false,"html":"<b>格式</b>","repeat":"weekdays","remindAt":"2026-11-05T01:00:00Z"}],"trash":[]})
    }
    #[test]
    fn fresh_workspace_is_not_seeded_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        assert!(store.load().unwrap().workspace.is_none());
        assert!(!store.current().exists());
    }
    #[test]
    fn save_reload_preserves_complete_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let mut w = workspace("合成任务");
        w["trash"] = json!([{"id":"trash-1","task":{"id":"deleted-1","text":"合成回收记录","group":"upcoming","done":true},"index":0,"deletedAt":123}]);
        let saved = store.save(w.clone()).unwrap();
        assert!(same_content(&w, &saved));
        assert_eq!(
            Store::new(dir.path().to_path_buf())
                .load()
                .unwrap()
                .workspace
                .unwrap(),
            saved
        );
    }
    #[test]
    fn previous_version_and_recovery_repair() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let original = store.save(workspace("上一版")).unwrap();
        store.save(workspace("当前版")).unwrap();
        fs::write(store.current(), b"{broken").unwrap();
        let loaded = store.load().unwrap();
        assert!(loaded.recovered);
        assert_eq!(loaded.workspace.unwrap(), original);
        store.save(original.clone()).unwrap();
        assert!(!store.load().unwrap().recovered);
        assert!(same_content(
            &store.load().unwrap().workspace.unwrap(),
            &original
        ));
    }
    #[test]
    fn both_corrupt_are_not_overwritten_with_samples() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        fs::write(store.current(), b"broken-a").unwrap();
        fs::write(store.previous(), b"broken-b").unwrap();
        assert!(store.load().is_err());
        assert!(store.save(workspace("示例")).is_err());
        assert_eq!(fs::read(store.current()).unwrap(), b"broken-a");
        assert_eq!(fs::read(store.previous()).unwrap(), b"broken-b");
    }
    #[test]
    fn identical_content_does_not_rotate_backup() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        store.save(workspace("第一版")).unwrap();
        let saved = store.save(workspace("第二版")).unwrap();
        let previous = fs::read(store.previous()).unwrap();
        let mut stamped = saved.clone();
        stamped["updatedAt"] = json!(0);
        assert_eq!(store.save(stamped).unwrap(), saved);
        assert_eq!(fs::read(store.previous()).unwrap(), previous);
    }
    #[test]
    fn write_failure_preserves_current_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        store.save(workspace("不能丢失")).unwrap();
        let original = fs::read(store.current()).unwrap();
        fs::create_dir(store.previous()).unwrap();
        assert!(store.save(workspace("写入失败")).is_err());
        assert_eq!(fs::read(store.current()).unwrap(), original);
    }
    #[test]
    fn import_checkpoint_contains_exact_previous_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let before = store.save(workspace("导入前")).unwrap();
        let mut next = before.clone();
        next["tasks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"imported","text":"导入合成任务","group":"tomorrow","done":false}));
        let saved = store.import(&before, next).unwrap();
        assert_eq!(saved["tasks"].as_array().unwrap().len(), 2);
        let files: Vec<_> = fs::read_dir(store.directory.join("Backups"))
            .unwrap()
            .collect();
        assert_eq!(files.len(), 1);
        let backup: Value =
            serde_json::from_slice(&fs::read(files[0].as_ref().unwrap().path()).unwrap()).unwrap();
        assert_eq!(backup, before);
    }
    #[test]
    fn import_backup_failure_does_not_change_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let before = store.save(workspace("导入前")).unwrap();
        fs::write(store.directory.join("Backups"), b"not a directory").unwrap();
        assert!(store.import(&before, workspace("新版本")).is_err());
        assert_eq!(store.load().unwrap().workspace.unwrap(), before);
    }
    #[test]
    fn stale_import_preview_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let before = store.save(workspace("旧版")).unwrap();
        let current = store.save(workspace("其他更改")).unwrap();
        assert!(store.import(&before, workspace("导入")).is_err());
        assert_eq!(store.load().unwrap().workspace.unwrap(), current);
    }
    #[test]
    fn malformed_import_and_duplicate_ids_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("incoming.json");
        fs::write(&file, "not JSON").unwrap();
        assert!(read_import(&file).is_err());
        let mut w = workspace("合成任务");
        let duplicate = w["tasks"][0].clone();
        w["tasks"].as_array_mut().unwrap().push(duplicate);
        assert!(validate(&w).is_err());
    }
    #[test]
    fn import_size_and_count_limits_are_enforced() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("incoming.json");
        fs::File::create(&file)
            .unwrap()
            .set_len(MAX_IMPORT_BYTES + 1)
            .unwrap();
        assert!(read_import(&file).is_err());
        let tasks: Vec<_> = (0..=MAX_IMPORT_RECORDS)
            .map(|i| json!({"id":format!("t-{i}"),"text":"合成","done":false,"group":"today"}))
            .collect();
        fs::write(
            &file,
            serde_json::to_vec(&json!({"version":2,"tasks":tasks,"trash":[]})).unwrap(),
        )
        .unwrap();
        assert!(read_import(&file).is_err());
    }
    #[test]
    fn import_export_round_trip_keeps_formatting_and_reminders() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("export.json");
        let w = workspace("往返合成任务");
        atomic_write(&file, &serde_json::to_vec(&w).unwrap()).unwrap();
        assert_eq!(read_import(&file).unwrap(), w);
    }
}

(() => {
  const QieJi = window.QieJi = window.QieJi || {};
  const { GROUP_ORDER } = QieJi.dateGroups;
  const STORAGE_KEY = "paper-edge-tasks-v1";
  const PANEL_KEY = "paper-edge-panel-v1";
  const WORKSPACE_KEY = "paper-edge-workspace-v2";
  const DRAFT_KEY = "paper-edge-draft-v1";
  // Keep in sync with AppDelegate.maxBackupRecords.
  const MAX_IMPORT_RECORDS = 20000;
  let localWorkspaceStamp = 0;

  const INITIAL_TASKS = [
    { id: "sample-1", text: "完成今天最重要的一件事", group: "today", done: false, createdAt: 1 },
    { id: "sample-2", text: "整理桌面上散落的资料", group: "today", done: false, createdAt: 2 },
    { id: "sample-3", text: "回复需要认真回答的消息", group: "tomorrow", done: false, createdAt: 3 },
    { id: "sample-4", text: "确认本周要打印的内容", group: "tomorrow", done: false, createdAt: 4 },
    { id: "sample-5", text: "留一段不被打扰的时间", group: "upcoming", done: false, createdAt: 5 }
  ];

  function uid() {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function isComposing(event) {
    return Boolean(
      event.isComposing
      || event.nativeEvent?.isComposing
      || event.keyCode === 229
      || event.nativeEvent?.keyCode === 229
    );
  }

  function isValidTaskList(value) {
    return Array.isArray(value) && value.every((task) => (
      task
      && typeof task.id === "string"
      && typeof task.text === "string"
      && GROUP_ORDER.includes(task.group)
      && typeof task.done === "boolean"
    ));
  }

  function readNativeBackup() {
    const backup = window.__QIEJI_NATIVE_BACKUP__;
    return isValidTaskList(backup) ? backup.map((task) => ({ ...task })) : null;
  }

  function preserveCorruptStorage(raw) {
    if (!raw) return;
    try {
      localStorage.setItem(`${STORAGE_KEY}-corrupt-${Date.now()}`, raw);
    } catch {
      // 原生 JSON 备份仍可用于恢复，不让浏览器存储异常阻断启动。
    }
  }

  function readTasks() {
    const nativeBackup = readNativeBackup();
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return nativeBackup || INITIAL_TASKS;
      const saved = JSON.parse(raw);
      if (isValidTaskList(saved)) return saved;
    } catch {
      preserveCorruptStorage(raw);
      return nativeBackup || INITIAL_TASKS;
    }
    preserveCorruptStorage(raw);
    return nativeBackup || INITIAL_TASKS;
  }

  function readPanelOpen() {
    if (typeof window.__QIEJI_PANEL_OPEN__ === "boolean") return window.__QIEJI_PANEL_OPEN__;
    try {
      return localStorage.getItem(PANEL_KEY) !== "closed";
    } catch {
      return true;
    }
  }

  function persistPanelOpen(isOpen, isNative) {
    try {
      localStorage.setItem(PANEL_KEY, isOpen ? "open" : "closed");
    } catch {
      // 面板仍可在本次运行中正常展开和收起。
    }
    if (isNative) {
      window.webkit?.messageHandlers?.paperEdge?.postMessage({ type: "panel", open: isOpen });
    }
  }

  function isValidWorkspace(value) {
    return Boolean(value && isValidTaskList(value.tasks) && Array.isArray(value.trash)
      && value.trash.every((entry) => entry && typeof entry.id === "string"
        && isValidTaskList([entry.task]) && Number.isFinite(entry.index)
        && Number.isFinite(entry.deletedAt)));
  }

  function readWorkspace() {
    let raw = null;
    let saved = null;
    try {
      raw = localStorage.getItem(WORKSPACE_KEY);
      if (raw !== null) {
        saved = JSON.parse(raw);
        if (!isValidWorkspace(saved)) { saved = null; throw new Error("Invalid workspace"); }
      }
    } catch {
      try {
        if (raw) localStorage.setItem(`${WORKSPACE_KEY}-corrupt-${Date.now()}`, raw);
      } catch { /* 原生工作区备份仍可恢复。 */ }
    }
    const native = window.__QIEJI_NATIVE_WORKSPACE__;
    const nativeValid = isValidWorkspace(native);
    const stampOf = (value) => Math.min(Math.max(Number(value?.updatedAt) || 0, 0), Date.now() + 86400000);
    const savedStamp = saved ? stampOf(saved) : -1;
    const nativeStamp = nativeValid ? stampOf(native) : -1;
    // 原生和网页副本都可能因为崩溃、写盘失败或配额而落后；更新时间较新的副本优先。
    if (savedStamp > nativeStamp) return saved;
    if (nativeValid) return native;
    if (saved) return saved;
    const tasks = readTasks();
    return { version: 2, tasks, trash: [], ...(tasks === INITIAL_TASKS ? { sampleNoticePending: true } : {}) };
  }

  function nextWorkspaceStamp(workspace) {
    const ceiling = Date.now() + 86400000;
    const previous = Math.min(Math.max(Number(workspace?.updatedAt) || 0, 0), ceiling);
    localWorkspaceStamp = Math.max(Date.now(), localWorkspaceStamp + 1, previous + 1);
    return localWorkspaceStamp;
  }

  function persistWorkspace(workspace, isNative) {
    const stamped = { ...workspace, updatedAt: nextWorkspaceStamp(workspace) };
    try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify(stamped)); } catch { /* 保留原生备份。 */ }
    if (isNative) window.webkit?.messageHandlers?.paperEdge?.postMessage({ type: "workspace", workspace: stamped });
  }

  // 一次状态变更同时更新清单和回收记录，避免先删后存造成内容丢失。
  function moveTasksToTrash(workspace, ids, reason = "删除", batchId = uid()) {
    const selected = new Set(ids);
    const removed = workspace.tasks.flatMap((task, index) => selected.has(task.id)
      ? [{ id: uid(), batchId, task: { ...task }, index, deletedAt: Date.now(), reason }] : []);
    return { ...workspace, tasks: workspace.tasks.filter((task) => !selected.has(task.id)), trash: [...removed, ...workspace.trash] };
  }

  function restoreTrashEntries(workspace, ids) {
    const selected = new Set(ids);
    const tasks = [...workspace.tasks];
    workspace.trash.filter((entry) => selected.has(entry.id))
      .sort((a, b) => a.index - b.index)
      .forEach(({ task, index }) => {
        if (!tasks.some((current) => current.id === task.id)) {
          tasks.splice(Math.max(0, Math.min(index, tasks.length)), 0, { ...task });
        }
      });
    return { ...workspace, tasks, trash: workspace.trash.filter((entry) => !selected.has(entry.id)) };
  }

  function exportWorkspace(workspace) {
    if (!isValidWorkspace(workspace)) throw new Error("当前任务数据不完整，无法导出");
    return { format: "qieji-workspace", version: 2, exportedAt: new Date().toISOString(),
      tasks: workspace.tasks, trash: workspace.trash };
  }

  function prepareImport(current, incoming) {
    const validTask = (task) => isValidTaskList([task]) && task.id.trim() && task.text.trim()
      && (task.html === undefined || typeof task.html === "string")
      && (task.createdAt === undefined || Number.isFinite(task.createdAt))
      && (task.remindAt == null || (typeof task.remindAt === "string" && Number.isFinite(new Date(task.remindAt).getTime())))
      && (task.repeat == null || ["daily", "weekdays", "weekly"].includes(task.repeat))
      && (task.snoozedUntil == null || (typeof task.snoozedUntil === "string" && Number.isFinite(new Date(task.snoozedUntil).getTime())));
    if (!incoming || incoming.version !== 2
      || (incoming.format !== undefined && incoming.format !== "qieji-workspace")
      || !isValidWorkspace(incoming) || !incoming.tasks.every(validTask)
      || !incoming.trash.every((entry) => entry.id.trim() && validTask(entry.task)
        && Number.isInteger(entry.index) && entry.index >= 0 && entry.deletedAt >= 0)) {
      throw new Error("文件不是有效的且记任务备份，或版本暂不支持");
    }
    if (incoming.tasks.length + incoming.trash.length > MAX_IMPORT_RECORDS) {
      throw new Error(`备份记录超过 ${MAX_IMPORT_RECORDS} 条，请先清理已删除记录或分拆备份`);
    }
    const tasks = [...current.tasks], trash = [...current.trash];
    const taskIDs = new Set([...tasks.map((task) => task.id), ...trash.map((entry) => entry.task.id)]);
    const entryIDs = new Set(trash.map((entry) => entry.id));
    const summary = { tasks: 0, trash: 0, conflicts: 0 };
    incoming.tasks.forEach((task) => {
      if (taskIDs.has(task.id)) { summary.conflicts += 1; return; }
      tasks.push({ ...task }); taskIDs.add(task.id); summary.tasks += 1;
    });
    incoming.trash.forEach((entry) => {
      if (taskIDs.has(entry.task.id) || entryIDs.has(entry.id)) { summary.conflicts += 1; return; }
      trash.push({ ...entry, task: { ...entry.task } });
      taskIDs.add(entry.task.id); entryIDs.add(entry.id); summary.trash += 1;
    });
    return { workspace: { ...current, version: 2, tasks, trash }, summary };
  }

  function purgeTrashEntries(workspace, ids) {
    const selected = new Set(ids);
    return { ...workspace, trash: workspace.trash.filter((entry) => !selected.has(entry.id)) };
  }

  function clearSampleTasks(workspace) {
    const tasks = workspace.tasks.filter((task) => !INITIAL_TASKS.some((sample) =>
      task.id === sample.id && task.text === sample.text && task.group === sample.group
      && task.done === false && !task.html && !task.remindAt));
    return { ...workspace, tasks, sampleNoticePending: false };
  }

  function readDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (draft && typeof draft.text === "string" && GROUP_ORDER.includes(draft.group)) return draft;
    } catch { /* 草稿损坏不影响任务加载。 */ }
    return { text: "", group: "today" };
  }

  function persistDraft(text, group) {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ text, group })); } catch { /* 本次输入仍保留在内存。 */ }
  }

  QieJi.isComposing = isComposing;
  QieJi.taskStorage = {
    STORAGE_KEY,
    PANEL_KEY,
    MAX_IMPORT_RECORDS,
    uid,
    isComposing,
    isValidTaskList,
    readTasks,
    readPanelOpen,
    persistPanelOpen,
    WORKSPACE_KEY,
    readWorkspace,
    persistWorkspace,
    isValidWorkspace,
    moveTasksToTrash,
    restoreTrashEntries,
    exportWorkspace,
    prepareImport,
    purgeTrashEntries,
    clearSampleTasks,
    readDraft,
    persistDraft
  };
})();

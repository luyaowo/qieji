(() => {
  const QieJi = window.QieJi = window.QieJi || {};
  const doc = typeof document === "undefined" ? null : document;
  let tail = Promise.resolve();
  let pending = 0;
  let saveState = { status: "loading", message: "正在读取" };
  let busy = false;
  let closing = false;
  let mounted = false;
  let recovered = false;

  function invoke(command, args = {}) {
    if (typeof window.__TAURI__?.core?.invoke !== "function") {
      return Promise.reject(new Error("请从且记开发工程启动应用。"));
    }
    return window.__TAURI__.core.invoke(command, args);
  }
  const messageOf = error => error?.message || String(error || "操作失败，请重试。");
  function notice(message) { window.paperEdgeShowNotice?.(message); }
  function updateSave(status, message) {
    saveState = { status, message };
    if (doc) doc.documentElement.dataset.saveState = status;
    if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("qieji-save-state", { detail: saveState }));
    }
  }
  function enqueueSave(workspace) {
    const snapshot = JSON.parse(JSON.stringify(workspace));
    pending += 1;
    updateSave("saving", "保存中");
    tail = tail.catch(() => {}).then(() => invoke("qieji_save", { workspace: snapshot }))
      .then(saved => {
        pending -= 1;
        window.__QIEJI_NATIVE_WORKSPACE__ = saved;
        if (!pending) updateSave("saved", "已保存");
        return saved;
      }, error => {
        pending -= 1;
        updateSave("error", "保存失败");
        notice(`保存失败：${messageOf(error)} 当前窗口内容仍保留，可以重试保存或导出。`);
        throw new Error(messageOf(error));
      });
    return tail;
  }
  function currentWorkspace() {
    if (typeof window.paperEdgePrepareToQuit !== "function") throw new Error("清单尚未准备好，请稍后重试。");
    return window.paperEdgePrepareToQuit();
  }
  function saveCurrent() { return enqueueSave(currentWorkspace()); }
  async function withOperation(action) {
    if (busy || closing) return false;
    busy = true;
    const root = doc?.getElementById("root");
    if (root) root.inert = true;
    try { return await action(); }
    catch (error) { notice(messageOf(error)); return false; }
    finally { busy = false; if (root) root.inert = false; }
  }
  async function exportWorkspace() {
    return withOperation(async () => {
      // Export remains available when the regular workspace cannot be saved.
      const workspace = window.paperEdgeExportWorkspace();
      const saved = await invoke("qieji_export", { workspace });
      if (saved) notice("任务和回收记录已导出。");
      return saved;
    });
  }
  async function importWorkspace() {
    return withOperation(async () => {
      await saveCurrent();
      const incoming = await invoke("qieji_pick_import");
      if (incoming === null) return false;
      const preview = window.paperEdgePreviewImport(incoming);
      if (!await invoke("qieji_confirm_import", { summary: preview.summary })) return false;
      const workspace = await invoke("qieji_import", { before: preview.before, workspace: preview.workspace });
      window.__QIEJI_NATIVE_WORKSPACE__ = workspace;
      window.paperEdgeApplyWorkspace(workspace);
      await tail;
      notice(`已导入 ${preview.summary.tasks} 条任务、${preview.summary.trash} 条回收记录，跳过 ${preview.summary.conflicts} 条冲突记录。导入前备份已保存。`);
      return true;
    });
  }
  async function requestClose() {
    if (closing || busy) return false;
    if (!mounted) { await invoke("qieji_exit", { workspace: null }); return true; }
    closing = true;
    const root = doc?.getElementById("root");
    if (root) root.inert = true;
    try {
      await saveCurrent();
      await invoke("qieji_exit", { workspace: currentWorkspace() });
      return true;
    } catch (error) {
      notice(`保存未完成，已取消退出。${messageOf(error)}`);
      return false;
    } finally {
      closing = false;
      if (root) root.inert = false;
    }
  }
  function postMessage(message) {
    if (message.type === "workspace") { enqueueSave(message.workspace).catch(() => {}); return; }
    if (message.type === "ready") {
      invoke("qieji_ready").catch(error => notice(messageOf(error)));
      if (recovered) notice("已从上一版工作区恢复，任务和回收记录已保留。");
    }
  }
  async function bootstrap() {
    const loaded = await invoke("qieji_bootstrap");
    window.__QIEJI_NATIVE_WORKSPACE__ = loaded.workspace;
    window.__QIEJI_DISPLAY_MODE__ = "paper";
    window.__QIEJI_PANEL_OPEN__ = true;
    recovered = loaded.recovered;
    if (doc) doc.documentElement.dataset.platform = "windows";
    return loaded;
  }
  function showStartupError(error, mount) {
    const root = doc?.getElementById("root");
    if (!root) return;
    root.innerHTML = '<section class="startup-error" role="alert"><h1>暂时无法读取清单</h1><p class="startup-message"></p><p>原始文件仍保留，不会用示例任务覆盖。</p><button type="button" class="retry-start">重新读取</button><button type="button" class="exit-start">退出</button></section>';
    root.querySelector(".startup-message").textContent = messageOf(error);
    root.querySelector(".retry-start").onclick = () => start(mount);
    root.querySelector(".exit-start").onclick = () => requestClose();
  }
  async function start(mount) {
    try {
      await bootstrap();
      const root = doc?.getElementById("root");
      if (root) root.replaceChildren();
      mounted = true;
      mount();
    } catch (error) { showStartupError(error, mount); }
  }
  if (typeof window.addEventListener === "function") {
    window.addEventListener("keydown", event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      if (key === "p") { event.preventDefault(); return; }
      if (key === "k") { event.preventDefault(); doc?.querySelector(".task-input")?.focus(); }
      if (key === "s") { event.preventDefault(); saveCurrent().catch(() => {}); }
    });
  }
  QieJi.platform = {
    isNative: true,
    isTauri: true,
    features: { windowModes: false, print: false, reminders: false },
    bootstrap, start, postMessage, saveCurrent, exportWorkspace, importWorkspace, requestClose,
    flush: () => tail,
    getSaveState: () => ({ ...saveState }),
  };
})();

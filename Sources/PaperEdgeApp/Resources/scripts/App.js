(() => {
  const QieJi = window.QieJi = window.QieJi || {};
  const IS_NATIVE = new URLSearchParams(window.location.search).get("native") === "1";
  document.documentElement.classList.toggle("native-shell", IS_NATIVE);
  const {
    useEffect,
    useMemo,
    useRef,
    useState
  } = React;
  const {
    GROUP_ORDER,
    startOfDay,
    formatMonthDay,
    formatWeekday,
    formatClock,
    groupMeta
  } = QieJi.dateGroups;
  const {
    uid,
    readPanelOpen,
    persistPanelOpen,
    readWorkspace,
    persistWorkspace,
    moveTasksToTrash,
    restoreTrashEntries,
    exportWorkspace,
    prepareImport,
    purgeTrashEntries,
    clearSampleTasks,
    readDraft,
    persistDraft
  } = QieJi.taskStorage;
  const {
    reorderTask,
    resolveTaskDrop,
    moveTaskByKeyboard
  } = QieJi.taskDrag;
  const {
    taskRichHtml
  } = QieJi.richText;
  const {
    TaskItem
  } = QieJi;
  function App() {
    const [today, setToday] = useState(() => startOfDay(new Date()));
    const groups = useMemo(() => {
      const meta = groupMeta(today);
      return {
        ...meta,
        tomorrow: {
          ...meta.tomorrow,
          date: "接下来几天"
        }
      };
    }, [today]);
    const [workspace, setWorkspace] = useState(readWorkspace);
    const tasks = workspace.tasks;
    const setTasks = update => setWorkspace(current => ({
      ...current,
      tasks: typeof update === "function" ? update(current.tasks) : update
    }));
    const [displayMode, setDisplayMode] = useState(() => {
      if (window.__QIEJI_DISPLAY_MODE__) return window.__QIEJI_DISPLAY_MODE__;
      try {
        return localStorage.getItem("qieji-display-mode-v1") === "paper" ? "paper" : "side";
      } catch {
        return "side";
      }
    });
    const [isOpen, setIsOpen] = useState(() => window.__QIEJI_DISPLAY_MODE__ === "paper" || readPanelOpen());
    const [newTask, setNewTask] = useState(() => readDraft().text);
    const [newGroup, setNewGroup] = useState(() => readDraft().group);
    const [recoveryOpen, setRecoveryOpen] = useState(false);
    const [missedOpen, setMissedOpen] = useState(false);
    const [pendingPurge, setPendingPurge] = useState(null);
    const [deleted, setDeleted] = useState(null);
    const [notificationNotice, setNotificationNotice] = useState(null);
    const [notificationDenied, setNotificationDenied] = useState(false);
    const [highlightedTaskID, setHighlightedTaskID] = useState(null);
    const [a11yMessage, setA11yMessage] = useState("");
    const [clock, setClock] = useState(new Date());
    const [dragState, setDragState] = useState(null);
    const addInputRef = useRef(null);
    const composerRef = useRef(null);
    const workspaceRef = useRef(workspace);
    workspaceRef.current = workspace;
    const reminderHighlightTimerRef = useRef(null);
    const a11yTimerRef = useRef(null);
    const lastPermissionStatusRef = useRef(null);
    const deleteTimerRef = useRef(null);
    const notificationTimerRef = useRef(null);
    const panelOpenRef = useRef(isOpen);
    panelOpenRef.current = isOpen;
    const dragStateRef = useRef(null);
    const dragPointerRef = useRef(null);
    const dragScrollFrameRef = useRef(null);
    const tabDragRef = useRef(null);
    const suppressTabClickRef = useRef(false);
    useEffect(() => {
      persistWorkspace(workspace, IS_NATIVE);
    }, [workspace]);
    useEffect(() => {
      persistDraft(newTask, newGroup);
    }, [newTask, newGroup]);
    useEffect(() => {
      document.documentElement.dataset.displayMode = displayMode;
      try {
        localStorage.setItem("qieji-display-mode-v1", displayMode);
      } catch {/* 本次切换仍有效。 */}
    }, [displayMode]);
    const requestDisplayMode = (mode, open = true) => {
      setRecoveryOpen(false);
      setDisplayMode(mode);
      setIsOpen(open);
      if (IS_NATIVE) window.webkit?.messageHandlers?.paperEdge?.postMessage({
        type: "displayMode",
        mode,
        open
      });
    };
    useEffect(() => {
      persistPanelOpen(isOpen, IS_NATIVE);
    }, [isOpen]);
    useEffect(() => {
      window.paperEdgeSetOpen = open => setIsOpen(Boolean(open));
      window.paperEdgeSetMode = mode => {
        if (mode === "paper" || mode === "side") setDisplayMode(mode);
      };
      window.paperEdgePrepareToQuit = () => {
        ReactDOM.flushSync(() => window.dispatchEvent(new Event("qieji-commit-edit")));
        return workspaceRef.current;
      };
      window.paperEdgeExportWorkspace = () => exportWorkspace(window.paperEdgePrepareToQuit());
      window.paperEdgePreviewImport = payload => {
        const before = window.paperEdgePrepareToQuit();
        return {
          ...prepareImport(before, payload),
          before
        };
      };
      window.paperEdgeApplyWorkspace = next => {
        if (!QieJi.taskStorage.isValidWorkspace(next)) throw new Error("任务数据不完整");
        ReactDOM.flushSync(() => {
          setWorkspace(next);
          setPendingPurge(null);
          setDeleted(null);
        });
        window.clearTimeout(deleteTimerRef.current);
        return true;
      };
      window.paperEdgeShowNotice = message => {
        setIsOpen(true);
        setNotificationNotice({
          status: "info",
          message
        });
      };
      window.paperEdgeOpenTask = id => {
        setRecoveryOpen(false);
        setIsOpen(true);
        setHighlightedTaskID(id);
        window.clearTimeout(reminderHighlightTimerRef.current);
        reminderHighlightTimerRef.current = window.setTimeout(() => setHighlightedTaskID(null), 3000);
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          const row = [...document.querySelectorAll("[data-task-id]")].find(element => element.dataset.taskId === id);
          if (row) {
            row.scrollIntoView({
              block: "center",
              behavior: "instant"
            });
            row.querySelector(".task-copy")?.focus({
              preventScroll: true
            });
          } else {
            setNotificationNotice({
              status: "missingTask",
              message: "这条任务已不在当前清单中"
            });
          }
        }));
      };
      window.paperEdgeCompleteTask = id => {
        setWorkspace(current => ({
          ...current,
          tasks: current.tasks.map(task => task.id === id ? {
            ...task,
            done: true,
            snoozedUntil: null
          } : task)
        }));
      };
      window.paperEdgeSnoozeTask = (id, minutes) => {
        const remindAt = QieJi.reminderTime.snoozeDate(Number(minutes) || 15);
        setWorkspace(current => ({
          ...current,
          tasks: current.tasks.map(task => task.id === id && !task.done ? {
            ...task,
            ...(QieJi.reminderTime.repeatLabel(task.repeat) ? {
              snoozedUntil: remindAt
            } : {
              remindAt,
              snoozedUntil: null
            })
          } : task)
        }));
      };
      if (IS_NATIVE) window.webkit?.messageHandlers?.paperEdge?.postMessage({
        type: "ready"
      });
      return () => {
        delete window.paperEdgeSetOpen;
        delete window.paperEdgeSetMode;
        delete window.paperEdgePrepareToQuit;
        delete window.paperEdgeOpenTask;
        delete window.paperEdgeCompleteTask;
        delete window.paperEdgeSnoozeTask;
        delete window.paperEdgeExportWorkspace;
        delete window.paperEdgePreviewImport;
        delete window.paperEdgeApplyWorkspace;
        delete window.paperEdgeShowNotice;
        window.clearTimeout(reminderHighlightTimerRef.current);
      };
    }, []);
    useEffect(() => {
      if (!recoveryOpen) setPendingPurge(null);
    }, [recoveryOpen]);
    useEffect(() => {
      const composer = composerRef.current;
      if (!composer) return;
      const measure = () => composer.closest(".side-panel")?.style.setProperty("--composer-height", `${composer.getBoundingClientRect().height}px`);
      const observer = new ResizeObserver(measure);
      observer.observe(composer);
      measure();
      return () => observer.disconnect();
    }, []);
    useEffect(() => {
      if (!IS_NATIVE) return;
      // WKWebView can restore focus while moving between native windows.
      // Keep pointer-restored task focus distinct from keyboard navigation.
      const root = document.documentElement;
      root.dataset.inputMethod = "pointer";
      const onPointerDown = () => {
        root.dataset.inputMethod = "pointer";
      };
      const onKeyDown = event => {
        if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
        root.dataset.inputMethod = "keyboard";
      };
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      return () => {
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        delete root.dataset.inputMethod;
      };
    }, []);
    const pauseNotificationNotice = () => window.clearTimeout(notificationTimerRef.current);
    const resumeNotificationNotice = () => {
      pauseNotificationNotice();
      const notice = document.querySelector(".notification-notice");
      if (notice && (notice.matches(":hover") || notice.contains(document.activeElement))) return;
      notificationTimerRef.current = window.setTimeout(() => setNotificationNotice(null), 5000);
    };
    useEffect(() => {
      // Transient permission notices belong to the open panel, not the edge tab.
      if (!isOpen) {
        pauseNotificationNotice();
        setNotificationNotice(null);
        return;
      }
      if (notificationNotice) resumeNotificationNotice();
      return pauseNotificationNotice;
    }, [notificationNotice, isOpen]);
    useEffect(() => {
      const onNotificationStatus = event => {
        if (!IS_NATIVE) return;
        const status = event.detail?.status;
        if (status === "authorized") setNotificationDenied(false);
        if (status === "denied") setNotificationDenied(true);
        if (status === "authorized" || status === "denied") {
          if (lastPermissionStatusRef.current === status) return;
          lastPermissionStatusRef.current = status;
        }
        if (status === "authorized") {
          setNotificationNotice(current => current?.status === "denied" ? null : current);
          return;
        }
        if (status === "limitCleared") {
          setNotificationNotice(current => current?.status === "limit" ? null : current);
          return;
        }
        const messages = {
          denied: "请在系统设置中允许且记通知",
          failed: "提醒设置失败，请稍后重试",
          settingsUnavailable: "无法打开设置，请前往系统设置中的通知",
          saveFailed: "任务未能保存，请保留应用并稍后重试",
          interfaceRecovered: "已恢复最近保存的任务，未提交的编辑可能未保留",
          limit: "仅安排最近 60 条提醒；重复提醒按每个触发日各占一条，更晚的要等应用再次打开后才可能排入"
        };
        if (!messages[status]) return;
        // Native permission callbacks may arrive after the panel was collapsed.
        if (!panelOpenRef.current) return;
        setNotificationNotice({
          status,
          message: messages[status]
        });
      };
      window.addEventListener("qieji-notification-status", onNotificationStatus);
      return () => {
        window.removeEventListener("qieji-notification-status", onNotificationStatus);
        pauseNotificationNotice();
      };
    }, []);
    useEffect(() => {
      let midnightTimer = null;
      const syncSystemDate = () => {
        const now = new Date();
        const currentDay = startOfDay(now);
        setClock(now);
        setToday(previousDay => previousDay.getTime() === currentDay.getTime() ? previousDay : currentDay);
      };
      const scheduleNextMidnight = () => {
        window.clearTimeout(midnightTimer);
        const now = new Date();
        const nextMidnight = new Date(now);
        nextMidnight.setHours(24, 0, 0, 250);
        midnightTimer = window.setTimeout(() => {
          syncSystemDate();
          scheduleNextMidnight();
        }, Math.max(1000, nextMidnight.getTime() - now.getTime()));
      };
      const syncAndReschedule = () => {
        syncSystemDate();
        scheduleNextMidnight();
      };
      syncAndReschedule();
      const clockTimer = window.setInterval(() => setClock(new Date()), 60000);
      window.addEventListener("focus", syncAndReschedule);
      document.addEventListener("visibilitychange", syncAndReschedule);
      return () => {
        window.clearTimeout(midnightTimer);
        window.clearInterval(clockTimer);
        window.removeEventListener("focus", syncAndReschedule);
        document.removeEventListener("visibilitychange", syncAndReschedule);
      };
    }, []);
    useEffect(() => {
      const onKeyDown = event => {
        if (event.defaultPrevented || event.target.closest?.('[contenteditable="true"]') || event.target.closest?.(".task-editor-wrap")) return;
        if (event.key === "Escape") {
          if (pendingPurge) setPendingPurge(null);else if (recoveryOpen) setRecoveryOpen(false);else if (displayMode === "side") setIsOpen(false);
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
          event.preventDefault();
          setRecoveryOpen(false);
          setIsOpen(true);
          window.setTimeout(() => addInputRef.current?.focus(), 180);
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [displayMode, recoveryOpen, pendingPurge]);
    const stopDragAutoScroll = () => {
      if (dragScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(dragScrollFrameRef.current);
        dragScrollFrameRef.current = null;
      }
    };
    useEffect(() => () => {
      window.clearTimeout(deleteTimerRef.current);
      window.clearTimeout(notificationTimerRef.current);
      window.clearTimeout(a11yTimerRef.current);
      stopDragAutoScroll();
    }, []);
    useEffect(() => {
      document.body.classList.toggle("is-task-dragging", Boolean(dragState));
      return () => document.body.classList.remove("is-task-dragging");
    }, [Boolean(dragState)]);
    const openTasks = tasks.filter(task => !task.done);
    const doneTasks = tasks.filter(task => task.done);
    const tasksByGroup = useMemo(() => {
      return GROUP_ORDER.reduce((result, group) => {
        result[group] = tasks.filter(task => task.group === group);
        return result;
      }, {});
    }, [tasks]);
    const missedTasks = useMemo(() => tasks.filter(task => {
      if (task.done || !task.remindAt || task.repeat) return false;
      const time = new Date(task.remindAt).getTime();
      return Number.isFinite(time) && time <= clock.getTime();
    }), [tasks, clock]);
    const addTask = () => {
      const text = newTask.trim();
      if (!text) return;
      setTasks(current => [...current, {
        id: uid(),
        text,
        group: newGroup,
        done: false,
        createdAt: Date.now()
      }]);
      setNewTask("");
      window.setTimeout(() => addInputRef.current?.focus(), 0);
    };
    const sendTabDrag = (phase, screenY) => {
      window.webkit?.messageHandlers?.paperEdge?.postMessage({
        type: "tabDrag",
        phase,
        screenY
      });
    };
    const beginTabDrag = event => {
      if (!IS_NATIVE || isOpen || event.button !== 0) return;
      tabDragRef.current = {
        pointerId: event.pointerId,
        startScreenY: event.screenY,
        moved: false,
        element: event.currentTarget
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        tabDragRef.current = null;
        return;
      }
      sendTabDrag("start", event.screenY);
    };
    const moveTabDrag = event => {
      const drag = tabDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if ((event.buttons & 1) === 0) {
        finishTabDrag(event, true);
        return;
      }
      if (!drag.moved && Math.abs(event.screenY - drag.startScreenY) < 5) return;
      drag.moved = true;
      event.preventDefault();
      event.currentTarget.classList.add("is-dragging");
      sendTabDrag("move", event.screenY);
    };
    const finishTabDrag = (event, cancelled = false) => {
      const drag = tabDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      tabDragRef.current = null;
      drag.element.classList.remove("is-dragging");
      if (drag.element.hasPointerCapture?.(drag.pointerId)) {
        drag.element.releasePointerCapture(drag.pointerId);
      }
      sendTabDrag(!cancelled && drag.moved ? "end" : "cancel", event.screenY);
      if (drag.moved) {
        suppressTabClickRef.current = true;
        window.setTimeout(() => {
          suppressTabClickRef.current = false;
        }, 0);
      }
    };
    useEffect(() => {
      const cancelTabDrag = () => {
        const drag = tabDragRef.current;
        if (drag) finishTabDrag({
          pointerId: drag.pointerId,
          screenY: drag.startScreenY
        }, true);
      };
      window.addEventListener("blur", cancelTabDrag);
      return () => {
        window.removeEventListener("blur", cancelTabDrag);
        cancelTabDrag();
      };
    }, []);
    const patchTask = (id, patch) => {
      setTasks(current => current.map(task => task.id === id ? {
        ...task,
        ...patch,
        ...(patch.done === true || Object.hasOwn(patch, "remindAt") || Object.hasOwn(patch, "repeat") ? {
          snoozedUntil: null
        } : {})
      } : task));
    };
    const announceMove = (task, group) => {
      window.clearTimeout(a11yTimerRef.current);
      setA11yMessage(`已将「${task.text}」移到${groups[group].label}`);
      a11yTimerRef.current = window.setTimeout(() => setA11yMessage(""), 2000);
    };
    const moveTask = (id, direction) => {
      const next = moveTaskByKeyboard(tasks, id, direction);
      if (next === tasks) return;
      const moved = next.find(task => task.id === id);
      setTasks(next);
      if (moved) announceMove(moved, moved.group);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const row = [...document.querySelectorAll("[data-task-id]")].find(element => element.dataset.taskId === id);
        row?.querySelector(".task-copy")?.focus({
          preventScroll: true
        });
      }));
    };
    const commitDragState = next => {
      dragStateRef.current = next;
      setDragState(next);
    };
    const beginTaskDrag = id => {
      const scroll = document.querySelector(".task-scroll");
      stopDragAutoScroll();
      dragPointerRef.current = null;
      commitDragState({
        id,
        offsetY: 0,
        startScrollTop: scroll?.scrollTop || 0,
        targetGroup: null,
        targetId: null,
        position: null
      });
    };
    const updateDragPosition = (id, clientY, pointerOffsetY) => {
      const current = dragStateRef.current;
      if (!current || current.id !== id) return;
      const scroll = document.querySelector(".task-scroll");
      const target = resolveTaskDrop(clientY, id);
      commitDragState({
        ...current,
        offsetY: pointerOffsetY + ((scroll?.scrollTop || 0) - current.startScrollTop),
        targetGroup: target?.targetGroup || null,
        targetId: target?.targetId || null,
        position: target?.position || null
      });
    };
    const runDragAutoScroll = () => {
      dragScrollFrameRef.current = null;
      const pointer = dragPointerRef.current;
      const current = dragStateRef.current;
      const scroll = document.querySelector(".task-scroll");
      if (!pointer || !current || current.id !== pointer.id || !scroll) return;
      const rect = scroll.getBoundingClientRect();
      const edgeSize = 52;
      let delta = 0;
      if (pointer.clientY < rect.top + edgeSize) {
        delta = -Math.min(14, Math.max(3, (rect.top + edgeSize - pointer.clientY) / 3));
      } else if (pointer.clientY > rect.bottom - edgeSize) {
        delta = Math.min(14, Math.max(3, (pointer.clientY - (rect.bottom - edgeSize)) / 3));
      }
      if (!delta) return;
      const previousScrollTop = scroll.scrollTop;
      scroll.scrollTop += delta;
      if (scroll.scrollTop !== previousScrollTop) {
        updateDragPosition(pointer.id, pointer.clientY, pointer.offsetY);
        dragScrollFrameRef.current = window.requestAnimationFrame(runDragAutoScroll);
      }
    };
    const updateTaskDrag = (id, clientY, pointerOffsetY) => {
      dragPointerRef.current = {
        id,
        clientY,
        offsetY: pointerOffsetY
      };
      updateDragPosition(id, clientY, pointerOffsetY);
      if (dragScrollFrameRef.current === null) {
        dragScrollFrameRef.current = window.requestAnimationFrame(runDragAutoScroll);
      }
    };
    const finishTaskDrag = id => {
      const current = dragStateRef.current;
      if (current?.id === id && current.targetGroup) {
        setTasks(tasks => reorderTask(tasks, id, current.targetGroup, current.targetId, current.position));
      }
      stopDragAutoScroll();
      dragPointerRef.current = null;
      commitDragState(null);
    };
    const cancelTaskDrag = () => {
      stopDragAutoScroll();
      dragPointerRef.current = null;
      commitDragState(null);
    };
    const removeTasks = (ids, message, reason = "删除") => {
      if (!ids.length) return;
      const batchId = uid();
      setWorkspace(current => moveTasksToTrash(current, ids, reason, batchId));
      setDeleted({
        batchId,
        message
      });
      window.clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = window.setTimeout(() => setDeleted(null), 4200);
      if (document.documentElement.dataset.inputMethod === "keyboard") {
        window.setTimeout(() => addInputRef.current?.focus(), 0);
      }
    };
    const deleteTask = id => removeTasks([id], "已移至已删除");
    const undoDelete = () => {
      if (!deleted) return;
      setWorkspace(current => restoreTrashEntries(current, current.trash.filter(entry => entry.batchId === deleted.batchId).map(entry => entry.id)));
      setDeleted(null);
      window.clearTimeout(deleteTimerRef.current);
    };
    const cleanCompleted = () => removeTasks(doneTasks.map(task => task.id), `已将 ${doneTasks.length} 条已完成任务移入回收站`, "清理已完成");
    const restoreEntry = id => setWorkspace(current => restoreTrashEntries(current, [id]));
    const confirmPurge = () => {
      if (!pendingPurge) return;
      if (deleted && workspace.trash.some(entry => pendingPurge.includes(entry.id) && entry.batchId === deleted.batchId)) {
        setDeleted(null);
        window.clearTimeout(deleteTimerRef.current);
      }
      setWorkspace(current => purgeTrashEntries(current, pendingPurge));
      setPendingPurge(null);
    };
    const printRange = `${formatMonthDay(today)} · ${formatWeekday(today)}`;
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("main", {
      className: "app-screen",
      "data-open": isOpen ? "true" : "false",
      "data-mode": displayMode,
      "data-screen-label": "\u4E14\u8BB0\u4E3B\u754C\u9762"
    }, /*#__PURE__*/React.createElement("button", {
      className: "edge-tab",
      type: "button",
      tabIndex: isOpen ? -1 : 0,
      "aria-hidden": isOpen,
      "aria-expanded": isOpen,
      "aria-controls": "task-panel",
      onPointerDown: beginTabDrag,
      onPointerMove: moveTabDrag,
      onPointerUp: finishTabDrag,
      onPointerCancel: event => finishTabDrag(event, true),
      onLostPointerCapture: event => finishTabDrag(event, true),
      onClick: event => {
        if (suppressTabClickRef.current) {
          event.preventDefault();
          return;
        }
        setIsOpen(value => !value);
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "edge-tab-label"
    }, "\u4E14\u8BB0"), /*#__PURE__*/React.createElement("span", {
      className: "edge-tab-count"
    }, /*#__PURE__*/React.createElement("span", {
      className: "count-glyph"
    }, openTasks.length))), /*#__PURE__*/React.createElement("aside", {
      id: "task-panel",
      className: "side-panel",
      "aria-hidden": !isOpen,
      inert: isOpen ? undefined : ""
    }, /*#__PURE__*/React.createElement("header", {
      className: "panel-toolbar"
    }, /*#__PURE__*/React.createElement("span", {
      className: "toolbar-brand"
    }, "\u4E14\u8BB0"), /*#__PURE__*/React.createElement("div", {
      className: "mode-switch",
      role: "group",
      "aria-label": "\u7A97\u53E3\u5F62\u6001"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      "aria-pressed": displayMode === "paper",
      onClick: () => requestDisplayMode("paper")
    }, /*#__PURE__*/React.createElement("span", {
      className: "control-glyph"
    }, "\u5B8C\u6574\u7A97\u53E3")), /*#__PURE__*/React.createElement("button", {
      type: "button",
      "aria-pressed": displayMode === "side",
      onClick: () => requestDisplayMode("side")
    }, /*#__PURE__*/React.createElement("span", {
      className: "control-glyph"
    }, "\u4FA7\u8FB9"))), IS_NATIVE && /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "icon-button toolbar-print",
      "aria-label": "\u6253\u5370\u4EFB\u52A1\u7EB8",
      title: "\u6253\u5370\u4EFB\u52A1\u7EB8",
      onClick: () => window.webkit?.messageHandlers?.paperEdge?.postMessage({
        type: "print"
      })
    }, /*#__PURE__*/React.createElement("svg", {
      className: "control-icon",
      viewBox: "0 0 24 24",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M7 8V4h10v4M7 17H4V8h16v9h-3"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M7 14h10v7H7zM17 11h.01"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "toolbar-actions"
    }, IS_NATIVE ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "icon-button toolbar-clean",
      "aria-label": "\u6E05\u7406\u5DF2\u5B8C\u6210",
      title: `清理已完成：${doneTasks.length} 条，可从回收站恢复`,
      disabled: !doneTasks.length,
      onClick: cleanCompleted
    }, /*#__PURE__*/React.createElement("svg", {
      className: "control-icon",
      viewBox: "0 0 24 24",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M10 12V4a2 2 0 0 1 4 0v8M6 12h12l2 10H4l2-10ZM8 22l1-5m3 5v-5m4 5-1-5"
    }))), /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "icon-button recovery-button",
      "aria-label": "\u56DE\u6536\u7AD9",
      title: `回收站：${workspace.trash.length} 条`,
      "aria-pressed": recoveryOpen,
      onClick: () => setRecoveryOpen(value => !value)
    }, /*#__PURE__*/React.createElement("svg", {
      className: "control-icon",
      viewBox: "0 0 24 24",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"
    })))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "toolbar-text recovery-button",
      "aria-pressed": recoveryOpen,
      onClick: () => setRecoveryOpen(value => !value)
    }, "\u5DF2\u5220\u9664", workspace.trash.length ? ` · ${workspace.trash.length}` : ""), /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "icon-button",
      "aria-label": "\u6253\u5370\u4EFB\u52A1\u7EB8",
      title: "\u6253\u5370\u4EFB\u52A1\u7EB8",
      onClick: () => window.print()
    }, /*#__PURE__*/React.createElement("svg", {
      className: "control-icon",
      viewBox: "0 0 24 24",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M7 8V4h10v4M7 17H4V8h16v9h-3"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M7 14h10v7H7zM17 11h.01"
    })))), /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "icon-button",
      "aria-label": "\u6536\u8D77\u5230\u4FA7\u8FB9",
      title: "\u6536\u8D77\u5230\u4FA7\u8FB9",
      onClick: () => displayMode === "paper" ? requestDisplayMode("side", false) : setIsOpen(false)
    }, /*#__PURE__*/React.createElement("svg", {
      className: "control-icon",
      viewBox: "0 0 24 24",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("path", {
      d: "m9 6 6 6-6 6M20 5v14"
    }))))), /*#__PURE__*/React.createElement("div", {
      className: "task-scroll"
    }, /*#__PURE__*/React.createElement("article", {
      className: "task-paper",
      "aria-label": "\u4EFB\u52A1\u63D0\u9192\u5355"
    }, /*#__PURE__*/React.createElement("header", {
      className: "paper-heading"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "panel-title-lockup"
    }, /*#__PURE__*/React.createElement("span", {
      className: "panel-brand-mark",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("img", {
      src: "qieji-logo-v1.png",
      alt: ""
    })), /*#__PURE__*/React.createElement("h1", {
      className: "panel-title"
    }, "\u4E14\u8BB0")), /*#__PURE__*/React.createElement("p", {
      className: "paper-subtitle"
    }, "\u4EFB\u52A1\u63D0\u9192\u5355")), /*#__PURE__*/React.createElement("p", {
      className: "date-range"
    }, printRange)), workspace.sampleNoticePending && /*#__PURE__*/React.createElement("section", {
      className: "sample-notice",
      "aria-label": "\u793A\u4F8B\u4EFB\u52A1\u8BF4\u660E"
    }, /*#__PURE__*/React.createElement("p", null, "\u8FD9\u91CC\u51C6\u5907\u4E86 5 \u6761\u793A\u4F8B\u4EFB\u52A1\u3002\u53EF\u4EE5\u4FDD\u7559\u4F53\u9A8C\uFF0C\u4E5F\u53EF\u4EE5\u6E05\u9664\u672A\u4FEE\u6539\u7684\u793A\u4F8B\u3002"), /*#__PURE__*/React.createElement("p", null, "\u5206\u7EC4\u7531\u4F60\u5B89\u6392\uFF0C\u4E0D\u968F\u65E5\u671F\u81EA\u52A8\u79FB\u52A8\uFF1B\u672A\u5B8C\u6210\u7684\u4E8B\u9879\u4F1A\u4E00\u76F4\u4FDD\u7559\u3002"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "toolbar-text",
      onClick: () => setWorkspace(current => ({
        ...current,
        sampleNoticePending: false
      }))
    }, "\u4FDD\u7559\u793A\u4F8B"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "toolbar-text",
      onClick: () => setWorkspace(clearSampleTasks)
    }, "\u6E05\u9664\u793A\u4F8B"))), missedTasks.length ? /*#__PURE__*/React.createElement("section", {
      className: `missed-notice ${missedOpen ? "is-open" : ""}`,
      "aria-label": "\u5DF2\u9519\u8FC7\u7684\u63D0\u9192"
    }, /*#__PURE__*/React.createElement("button", {
      className: "missed-summary",
      type: "button",
      "aria-expanded": missedOpen,
      onClick: () => setMissedOpen(open => !open)
    }, /*#__PURE__*/React.createElement("span", {
      className: "missed-dot",
      "aria-hidden": "true"
    }), /*#__PURE__*/React.createElement("span", null, "\u5DF2\u9519\u8FC7 ", missedTasks.length, " \u6761\u63D0\u9192"), /*#__PURE__*/React.createElement("svg", {
      viewBox: "0 0 24 24",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("path", {
      d: "m6 9 6 6 6-6"
    }))), missedOpen ? /*#__PURE__*/React.createElement("ul", {
      className: "missed-list"
    }, missedTasks.map(task => /*#__PURE__*/React.createElement("li", {
      className: "missed-row",
      key: task.id
    }, /*#__PURE__*/React.createElement("span", {
      className: "missed-text"
    }, task.text), /*#__PURE__*/React.createElement("span", {
      className: "missed-time"
    }, QieJi.reminderTime.reminderLabel(task.remindAt, clock)), /*#__PURE__*/React.createElement("span", {
      className: "missed-actions"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "missed-action",
      onClick: () => patchTask(task.id, {
        remindAt: QieJi.reminderTime.snoozeDate(15)
      })
    }, "15 \u5206\u949F\u540E"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "missed-action is-primary",
      onClick: () => patchTask(task.id, {
        done: true
      })
    }, "\u5B8C\u6210"))))) : null) : null, /*#__PURE__*/React.createElement("div", {
      className: "paper-groups"
    }, GROUP_ORDER.map(group => /*#__PURE__*/React.createElement("section", {
      className: `task-group ${dragState?.targetGroup === group && !dragState?.targetId ? "is-drop-target" : ""}`,
      "data-group": group,
      key: group
    }, /*#__PURE__*/React.createElement("div", {
      className: "group-header"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "group-name"
    }, groups[group].label)), tasksByGroup[group].length ? /*#__PURE__*/React.createElement("ul", {
      className: "task-list"
    }, tasksByGroup[group].map(task => /*#__PURE__*/React.createElement(TaskItem, {
      key: task.id,
      task: task,
      onToggle: patchTask,
      onDelete: deleteTask,
      onDragStart: beginTaskDrag,
      onDragMove: updateTaskDrag,
      onDragEnd: finishTaskDrag,
      onDragCancel: cancelTaskDrag,
      onMove: moveTask,
      highlighted: highlightedTaskID === task.id,
      isDragging: dragState?.id === task.id ? dragState : null,
      dropPosition: dragState?.targetId === task.id ? dragState.position : null,
      notificationDenied: notificationDenied,
      onOpenNotificationSettings: () => window.webkit?.messageHandlers?.paperEdge?.postMessage({
        type: "openNotificationSettings"
      })
    }))) : /*#__PURE__*/React.createElement("p", {
      className: "empty-group"
    }, "\u8FD9\u91CC\u6682\u65F6\u6CA1\u6709\u8981\u505A\u7684\u4E8B\u3002")))), /*#__PURE__*/React.createElement("footer", {
      className: "paper-footer"
    }, /*#__PURE__*/React.createElement("span", null, openTasks.length, " \u4EF6\u5F85\u5B8C\u6210"), /*#__PURE__*/React.createElement("span", null, doneTasks.length, " \u4EF6\u5DF2\u5B8C\u6210")))), /*#__PURE__*/React.createElement("footer", {
      ref: composerRef,
      className: "composer"
    }, /*#__PURE__*/React.createElement("div", {
      className: "composer-line"
    }, /*#__PURE__*/React.createElement("input", {
      ref: addInputRef,
      className: "task-input",
      value: newTask,
      placeholder: "\u5199\u4E0B\u4E00\u4EF6\u8981\u505A\u7684\u4E8B",
      "aria-label": "\u65B0\u5F85\u529E",
      onChange: event => setNewTask(event.target.value),
      onKeyDown: event => {
        if (event.key === "Enter" && !QieJi.isComposing(event)) {
          event.preventDefault();
          addTask();
        }
      }
    }), /*#__PURE__*/React.createElement("button", {
      className: "add-button",
      type: "button",
      "aria-label": "\u6DFB\u52A0\u5F85\u529E",
      disabled: !newTask.trim(),
      onClick: addTask
    }, /*#__PURE__*/React.createElement("span", {
      className: "add-icon",
      "aria-hidden": "true"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "composer-options"
    }, /*#__PURE__*/React.createElement("div", {
      className: "date-segments",
      "aria-label": "\u9009\u62E9\u5206\u7EC4"
    }, /*#__PURE__*/React.createElement("span", {
      className: "composer-group-label"
    }, "\u65B0\u589E\u5230\uFF1A"), GROUP_ORDER.map(group => /*#__PURE__*/React.createElement("button", {
      key: group,
      className: `segment ${newGroup === group ? "is-active" : ""}`,
      type: "button",
      "aria-pressed": newGroup === group,
      onClick: () => setNewGroup(group)
    }, /*#__PURE__*/React.createElement("span", {
      className: "control-glyph"
    }, groups[group].label)))), !IS_NATIVE && /*#__PURE__*/React.createElement("button", {
      className: "clean-button",
      type: "button",
      disabled: !doneTasks.length,
      onClick: cleanCompleted
    }, "\u6E05\u7406\u5DF2\u5B8C\u6210", doneTasks.length ? ` · ${doneTasks.length}` : ""))), recoveryOpen && /*#__PURE__*/React.createElement("section", {
      className: "recovery-panel",
      "aria-label": "\u5DF2\u5220\u9664\u4EFB\u52A1"
    }, /*#__PURE__*/React.createElement("header", {
      className: "recovery-heading"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", null, "\u56DE\u6536\u7AD9"), /*#__PURE__*/React.createElement("p", null, workspace.trash.length, " \u6761\u8BB0\u5F55\uFF0C\u53EF\u6062\u590D\u6216\u6C38\u4E45\u5220\u9664\u3002")), /*#__PURE__*/React.createElement("div", {
      className: "recovery-heading-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "recovery-action",
      type: "button",
      onClick: () => setRecoveryOpen(false)
    }, /*#__PURE__*/React.createElement("svg", {
      viewBox: "0 0 24 24",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M19 12H5M11 6l-6 6 6 6"
    })), "\u8FD4\u56DE\u4EFB\u52A1"), /*#__PURE__*/React.createElement("button", {
      className: "recovery-action danger-action",
      type: "button",
      disabled: !workspace.trash.length,
      onClick: () => setPendingPurge(workspace.trash.map(entry => entry.id))
    }, "\u6E05\u7A7A\u5DF2\u5220\u9664"))), workspace.trash.length >= 1000 && /*#__PURE__*/React.createElement("p", {
      className: "recovery-capacity",
      role: "status"
    }, "\u5DF2\u5220\u9664\u8BB0\u5F55\u8F83\u591A\uFF0C\u53EF\u4EE5\u5148\u5BFC\u51FA\u5907\u4EFD\uFF0C\u518D\u624B\u52A8\u6E05\u7406\u3002\u7CFB\u7EDF\u4E0D\u4F1A\u81EA\u52A8\u5220\u9664\u3002"), pendingPurge && /*#__PURE__*/React.createElement("div", {
      className: "recovery-confirm",
      role: "group",
      "aria-label": "\u786E\u8BA4\u6C38\u4E45\u5220\u9664"
    }, /*#__PURE__*/React.createElement("p", null, "\u6C38\u4E45\u5220\u9664\u8FD9 ", pendingPurge.length, " \u6761\u8BB0\u5F55\uFF1F\u5220\u9664\u540E\u65E0\u6CD5\u6062\u590D\u3002"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "restore-button",
      autoFocus: true,
      onClick: () => setPendingPurge(null)
    }, "\u53D6\u6D88"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "restore-button danger-action",
      onClick: confirmPurge
    }, "\u786E\u8BA4\u6C38\u4E45\u5220\u9664"))), /*#__PURE__*/React.createElement("div", {
      className: "recovery-scroll"
    }, workspace.trash.length ? workspace.trash.map(entry => /*#__PURE__*/React.createElement("article", {
      className: "recovery-entry",
      key: entry.id
    }, /*#__PURE__*/React.createElement("div", {
      className: "recovery-copy"
    }, /*#__PURE__*/React.createElement("p", null, entry.task.text), /*#__PURE__*/React.createElement("span", null, groups[entry.task.group]?.label, " \xB7 ", entry.task.done ? "已完成" : "未完成", " \xB7 ", formatMonthDay(new Date(entry.deletedAt)), " ", formatClock(new Date(entry.deletedAt)))), /*#__PURE__*/React.createElement("div", {
      className: "recovery-entry-actions"
    }, /*#__PURE__*/React.createElement("button", {
      className: "restore-button",
      type: "button",
      onClick: () => restoreEntry(entry.id),
      "aria-label": `恢复任务：${entry.task.text}`
    }, "\u6062\u590D"), /*#__PURE__*/React.createElement("button", {
      className: "toolbar-text danger-action",
      type: "button",
      onClick: () => setPendingPurge([entry.id]),
      "aria-label": `永久删除任务：${entry.task.text}`
    }, "\u6C38\u4E45\u5220\u9664")))) : /*#__PURE__*/React.createElement("p", {
      className: "recovery-empty"
    }, "\u8FD8\u6CA1\u6709\u5220\u9664\u7684\u4EFB\u52A1\u3002"))), /*#__PURE__*/React.createElement("div", {
      className: "panel-notices"
    }, deleted && (!IS_NATIVE || isOpen) && /*#__PURE__*/React.createElement("div", {
      className: "undo-toast",
      role: "status"
    }, /*#__PURE__*/React.createElement("span", null, deleted.message), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: undoDelete
    }, "\u64A4\u9500")), notificationNotice && isOpen && /*#__PURE__*/React.createElement("div", {
      className: "undo-toast notification-notice",
      role: "alert",
      onPointerEnter: pauseNotificationNotice,
      onPointerLeave: resumeNotificationNotice,
      onFocusCapture: pauseNotificationNotice,
      onBlurCapture: resumeNotificationNotice
    }, /*#__PURE__*/React.createElement("span", null, notificationNotice.message), notificationNotice.status === "denied" && /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "notification-settings-link",
      "aria-label": "\u6253\u5F00\u4E14\u8BB0\u901A\u77E5\u8BBE\u7F6E",
      title: "\u6253\u5F00\u4E14\u8BB0\u901A\u77E5\u8BBE\u7F6E",
      onClick: () => window.webkit?.messageHandlers?.paperEdge?.postMessage({
        type: "openNotificationSettings"
      })
    }, /*#__PURE__*/React.createElement("svg", {
      viewBox: "0 0 24 24",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("path", {
      d: "m7 17 10-10M7 7h10v10"
    })))))), /*#__PURE__*/React.createElement("p", {
      className: "sr-only",
      "aria-live": "polite",
      "aria-atomic": "true"
    }, a11yMessage)));
  }
  QieJi.App = App;
  ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})();

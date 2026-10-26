(() => {
  const QieJi = window.QieJi = window.QieJi || {};
  const {
    useEffect,
    useRef,
    useState
  } = React;
  const {
    GROUP_ORDER
  } = QieJi.dateGroups;
  const {
    TaskEditor
  } = QieJi;
  const {
    taskRichHtml
  } = QieJi.richText;
  function reorderTask(tasks, draggedId, targetGroup, targetId, position) {
    const dragged = tasks.find(task => task.id === draggedId);
    if (!dragged || !targetGroup) return tasks;
    const remaining = tasks.filter(task => task.id !== draggedId);
    const moved = {
      ...dragged,
      group: targetGroup
    };
    let insertAt = remaining.length;
    if (targetId) {
      const targetIndex = remaining.findIndex(task => task.id === targetId);
      if (targetIndex >= 0) insertAt = targetIndex + (position === "after" ? 1 : 0);
    } else {
      const lastInGroup = remaining.reduce((last, task, index) => task.group === targetGroup ? index : last, -1);
      if (lastInGroup >= 0) {
        insertAt = lastInGroup + 1;
      } else {
        const groupIndex = GROUP_ORDER.indexOf(targetGroup);
        const nextGroupIndex = remaining.findIndex(task => GROUP_ORDER.indexOf(task.group) > groupIndex);
        insertAt = nextGroupIndex >= 0 ? nextGroupIndex : remaining.length;
      }
    }
    const next = [...remaining];
    next.splice(insertAt, 0, moved);
    return next;
  }
  function resolveTaskDrop(clientY, draggedId) {
    const scroll = document.querySelector(".task-scroll");
    if (!scroll) return null;
    const scrollRect = scroll.getBoundingClientRect();
    if (clientY < scrollRect.top || clientY > scrollRect.bottom) return null;
    const sections = [...document.querySelectorAll(".task-group")];
    const section = sections.find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    }) || sections.reduce((nearest, candidate) => {
      const rect = candidate.getBoundingClientRect();
      const distance = Math.min(Math.abs(clientY - rect.top), Math.abs(clientY - rect.bottom));
      return !nearest || distance < nearest.distance ? {
        candidate,
        distance
      } : nearest;
    }, null)?.candidate;
    if (!section) return null;
    const targetGroup = section.dataset.group;
    const rows = [...section.querySelectorAll(".task-row")].filter(row => row.dataset.taskId !== draggedId);
    const nextRow = rows.find(row => clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    if (nextRow) {
      return {
        targetGroup,
        targetId: nextRow.dataset.taskId,
        position: "before"
      };
    }
    const lastRow = rows[rows.length - 1];
    return {
      targetGroup,
      targetId: lastRow?.dataset.taskId || null,
      position: lastRow ? "after" : "end"
    };
  }
  function moveTaskByKeyboard(tasks, id, direction) {
    const index = tasks.findIndex(task => task.id === id);
    if (index < 0 || !direction) return tasks;
    const task = tasks[index];
    const groupIndex = GROUP_ORDER.indexOf(task.group);
    const groupTasks = tasks.filter(candidate => candidate.group === task.group);
    const position = groupTasks.findIndex(candidate => candidate.id === id);
    const neighbor = groupTasks[position + direction];
    if (neighbor) {
      const neighborIndex = tasks.findIndex(candidate => candidate.id === neighbor.id);
      const next = [...tasks];
      next[index] = neighbor;
      next[neighborIndex] = task;
      return next;
    }
    if (direction < 0) {
      const previousGroup = GROUP_ORDER[groupIndex - 1];
      if (!previousGroup) return tasks;
      return reorderTask(tasks, id, previousGroup, null, null);
    }
    const nextGroup = GROUP_ORDER[groupIndex + 1];
    if (!nextGroup) return tasks;
    const firstNext = tasks.find(candidate => candidate.group === nextGroup);
    return reorderTask(tasks, id, nextGroup, firstNext?.id || null, "before");
  }
  function TaskItem({
    task,
    onToggle,
    onDelete,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
    onMove,
    isDragging,
    highlighted = false,
    dropPosition,
    notificationDenied = false,
    onOpenNotificationSettings
  }) {
    const [editorMode, setEditorMode] = useState(null);
    const editing = editorMode !== null;
    const rowRef = useRef(null);
    const pointerRef = useRef(null);
    const suppressEditRef = useRef(false);
    const finishPointerRef = useRef(null);
    const clickResetTimerRef = useRef(null);
    const finishPointer = (event, cancelled = false) => {
      const pointer = pointerRef.current;
      if (!pointer || pointer.pointerId !== event.pointerId) return;
      // Clear first: releasing capture can itself dispatch lostpointercapture.
      pointerRef.current = null;
      pointer.cleanup();
      if (pointer.element.hasPointerCapture?.(pointer.pointerId)) {
        pointer.element.releasePointerCapture?.(pointer.pointerId);
      }
      if (pointer.dragging) {
        cancelled ? onDragCancel(task.id) : onDragEnd(task.id);
        clickResetTimerRef.current = window.setTimeout(() => {
          suppressEditRef.current = false;
          clickResetTimerRef.current = null;
        }, 0);
      }
    };
    finishPointerRef.current = finishPointer;
    useEffect(() => () => {
      const pointer = pointerRef.current;
      if (pointer) finishPointerRef.current({
        pointerId: pointer.pointerId
      }, true);
      window.clearTimeout(clickResetTimerRef.current);
    }, []);
    const handlePointerDown = event => {
      if (editing || event.button !== 0 || event.target.closest("button, input")) return;
      const previous = pointerRef.current;
      if (previous) finishPointer({
        pointerId: previous.pointerId
      }, true);
      window.clearTimeout(clickResetTimerRef.current);
      suppressEditRef.current = false;
      const pointer = {
        pointerId: event.pointerId,
        startY: event.clientY,
        dragging: false,
        element: event.currentTarget
      };
      const end = event => finishPointerRef.current(event);
      const cancel = event => finishPointerRef.current(event, true);
      const blur = () => finishPointerRef.current({
        pointerId: pointer.pointerId
      }, true);
      pointer.cleanup = () => {
        window.removeEventListener("pointerup", end, true);
        window.removeEventListener("pointercancel", cancel, true);
        window.removeEventListener("blur", blur);
      };
      pointerRef.current = pointer;
      // Before capture starts, a release outside the row must still end the gesture.
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", cancel, true);
      window.addEventListener("blur", blur);
    };
    const handlePointerMove = event => {
      const pointer = pointerRef.current;
      if (!pointer || pointer.pointerId !== event.pointerId) return;
      if ((event.buttons & 1) === 0) {
        finishPointer(event, true);
        return;
      }
      const offsetY = event.clientY - pointer.startY;
      if (!pointer.dragging && Math.abs(offsetY) < 5) return;
      if (!pointer.dragging) {
        try {
          pointer.element.setPointerCapture?.(event.pointerId);
        } catch {
          finishPointer(event, true);
          return;
        }
        pointer.dragging = true;
        suppressEditRef.current = true;
        onDragStart(task.id);
      }
      event.preventDefault();
      onDragMove(task.id, event.clientY, offsetY);
    };
    return /*#__PURE__*/React.createElement("li", {
      ref: rowRef,
      className: `task-row ${task.done ? "is-done" : ""} ${editing ? "is-editing" : ""} ${isDragging ? "is-dragging" : ""} ${highlighted ? "is-reminder-target" : ""} ${dropPosition ? `drop-${dropPosition}` : ""}`,
      "data-task-id": task.id,
      "data-group": task.group,
      style: isDragging ? {
        transform: `translate3d(0, ${isDragging.offsetY || 0}px, 0) scale(1.012)`
      } : undefined,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: event => finishPointer(event),
      onPointerCancel: event => finishPointer(event, true),
      onLostPointerCapture: event => finishPointer(event, true)
    }, /*#__PURE__*/React.createElement("button", {
      className: "task-check",
      type: "button",
      "aria-label": task.done ? `恢复任务：${task.text}` : `完成任务：${task.text}`,
      onClick: () => onToggle(task.id, {
        done: !task.done
      })
    }), editing ? /*#__PURE__*/React.createElement(TaskEditor, {
      task: task,
      reminderOnly: editorMode === "reminder",
      onSave: patch => onToggle(task.id, patch),
      onCancel: (restoreFocus = false) => {
        setEditorMode(null);
        if (restoreFocus) window.requestAnimationFrame(() => rowRef.current?.querySelector('.row-action.reminder')?.focus({
          preventScroll: true
        }));
      }
    }) : /*#__PURE__*/React.createElement("div", {
      className: "task-main"
    }, /*#__PURE__*/React.createElement("span", {
      className: "task-copy",
      role: "button",
      tabIndex: "0",
      title: "\u70B9\u51FB\u7F16\u8F91\uFF1B\u2325\u2191/\u2325\u2193 \u79FB\u52A8",
      "aria-label": `编辑任务：${task.text}`,
      onClick: () => {
        if (!suppressEditRef.current) setEditorMode("text");
      },
      onKeyDown: event => {
        if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          event.stopPropagation();
          onMove?.(task.id, event.key === "ArrowUp" ? -1 : 1);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setEditorMode("text");
        }
      },
      dangerouslySetInnerHTML: {
        __html: taskRichHtml(task)
      }
    }), task.remindAt && !task.done ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      className: "task-reminder-meta",
      type: "button",
      onClick: () => setEditorMode("reminder")
    }, "\u63D0\u9192 \xB7 ", QieJi.reminderTime.reminderText(task)), notificationDenied && QieJi.reminderTime.hasScheduledReminder(task) ? /*#__PURE__*/React.createElement("button", {
      className: "task-reminder-warning",
      type: "button",
      title: "\u7CFB\u7EDF\u901A\u77E5\u672A\u5F00\u542F\uFF0C\u8FD9\u6761\u63D0\u9192\u4E0D\u4F1A\u9001\u8FBE",
      "aria-label": "\u7CFB\u7EDF\u901A\u77E5\u672A\u5F00\u542F\uFF0C\u6253\u5F00\u901A\u77E5\u8BBE\u7F6E",
      onClick: onOpenNotificationSettings
    }, /*#__PURE__*/React.createElement("svg", {
      viewBox: "0 0 24 24",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M3 3l18 18M18 8a6 6 0 0 0-9.3-5M6 9v5l-2 3h12M10 20a2 2 0 0 0 4 0"
    }))) : null) : null), /*#__PURE__*/React.createElement("div", {
      className: "row-actions",
      "aria-label": "\u4EFB\u52A1\u64CD\u4F5C",
      inert: editing || isDragging ? "" : undefined,
      "aria-hidden": editing || Boolean(isDragging)
    }, !task.done && /*#__PURE__*/React.createElement("button", {
      className: "row-action reminder",
      type: "button",
      title: task.remindAt ? "修改提醒" : "设置提醒",
      "aria-label": `${task.remindAt ? "修改提醒" : "设置提醒"}：${task.text}`,
      onClick: () => setEditorMode("reminder")
    }, /*#__PURE__*/React.createElement("svg", {
      viewBox: "0 0 24 24",
      "aria-hidden": "true"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M18 8a6 6 0 0 0-12 0v6l-2 3h16l-2-3V8ZM10 21h4"
    }))), /*#__PURE__*/React.createElement("button", {
      className: "row-action delete",
      type: "button",
      title: "\u5220\u9664",
      onFocus: event => event.currentTarget.closest(".task-row")?.classList.add("is-action-focused"),
      onBlur: event => event.currentTarget.closest(".task-row")?.classList.remove("is-action-focused"),
      onClick: () => onDelete(task.id)
    }, /*#__PURE__*/React.createElement("span", {
      className: "control-glyph"
    }, "\u5220"))));
  }
  QieJi.taskDrag = {
    reorderTask,
    resolveTaskDrop,
    moveTaskByKeyboard
  };
  QieJi.TaskItem = TaskItem;
})();

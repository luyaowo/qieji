(() => {
  const QieJi = window.QieJi = window.QieJi || {};
  const { useEffect, useRef, useState } = React;
  const HIGHLIGHT_COLORS = {
    sand: "#eadfac",
    sage: "#d9e5d4",
    sky: "#d8e5ec"
  };

  function escapeHtml(value) {
    const span = document.createElement("span");
    span.textContent = value || "";
    return span.innerHTML;
  }

  function highlightTone(value) {
    const color = String(value || "").toLowerCase().replaceAll(" ", "");
    if (color === "#eadfac" || color === "rgb(234,223,172)") return "sand";
    if (color === "#d9e5d4" || color === "rgb(217,229,212)") return "sage";
    if (color === "#d8e5ec" || color === "rgb(216,229,236)") return "sky";
    return null;
  }

  function sanitizeRichText(html) {
    // Template contents are inert: parsing must not load images or run events
    // before the whitelist has a chance to remove them.
    const source = document.createElement("template");
    const output = document.createElement("div");
    source.innerHTML = html || "";

    const copyChildren = (from, to) => {
      [...from.childNodes].forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          to.appendChild(document.createTextNode(node.textContent || ""));
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName.toLowerCase();
        if (["script", "style", "iframe", "object", "embed", "template", "svg", "math"].includes(tag)) return;
        if (tag === "br") {
          to.appendChild(document.createElement("br"));
          return;
        }

        const isBold = tag === "strong" || tag === "b"
          || node.style.fontWeight === "bold"
          || Number(node.style.fontWeight) >= 600;
        const tone = tag === "mark"
          ? (node.dataset.tone || highlightTone(node.style.backgroundColor))
          : highlightTone(node.style.backgroundColor);

        if (isBold || (tone && HIGHLIGHT_COLORS[tone])) {
          let target = to;
          if (tone && HIGHLIGHT_COLORS[tone]) {
            const mark = document.createElement("mark");
            mark.dataset.tone = tone;
            target.appendChild(mark);
            target = mark;
          }
          if (isBold) {
            const strong = document.createElement("strong");
            target.appendChild(strong);
            target = strong;
          }
          copyChildren(node, target);
          return;
        }

        copyChildren(node, to);
      });
    };

    copyChildren(source.content, output);
    return output.innerHTML;
  }

  function taskRichHtml(task) {
    return sanitizeRichText(task.html || escapeHtml(task.text));
  }

  function getSelectionOffsets(root, selection) {
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    return { start, end: start + range.toString().length };
  }

  function rangeFromOffsets(root, offsets) {
    if (!root || !offsets) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let cursor = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    let node = walker.nextNode();

    while (node) {
      const nextCursor = cursor + node.textContent.length;
      if (!startNode && offsets.start <= nextCursor) {
        startNode = node;
        startOffset = Math.max(0, offsets.start - cursor);
      }
      if (offsets.end <= nextCursor) {
        endNode = node;
        endOffset = Math.max(0, offsets.end - cursor);
        break;
      }
      cursor = nextCursor;
      node = walker.nextNode();
    }

    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  function clearFormattingInRange(editor, offsets) {
    if (!editor || !offsets) return;
    const source = document.createElement("div");
    const output = document.createElement("div");
    source.innerHTML = sanitizeRichText(editor.innerHTML);
    const characters = [];

    const collect = (node, format = { bold: false, tone: null }) => {
      if (node.nodeType === Node.TEXT_NODE) {
        for (let index = 0; index < node.textContent.length; index += 1) {
          characters.push({ value: node.textContent[index], ...format });
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (tag === "br") {
        characters.push({ value: "\n", ...format });
        return;
      }
      const nextFormat = {
        bold: format.bold || tag === "strong" || tag === "b",
        tone: tag === "mark" ? node.dataset.tone : format.tone
      };
      [...node.childNodes].forEach((child) => collect(child, nextFormat));
    };

    [...source.childNodes].forEach((node) => collect(node));
    characters.forEach((character, index) => {
      if (index >= offsets.start && index < offsets.end) {
        character.bold = false;
        character.tone = null;
      }
    });

    let current = null;
    characters.forEach((character) => {
      const key = `${character.bold ? "1" : "0"}:${character.tone || ""}`;
      if (!current || current.key !== key) {
        current = { key, bold: character.bold, tone: character.tone, text: "" };
        current.node = document.createTextNode("");
        let target = current.node;
        if (current.bold) {
          const strong = document.createElement("strong");
          strong.appendChild(target);
          target = strong;
        }
        if (current.tone) {
          const mark = document.createElement("mark");
          mark.dataset.tone = current.tone;
          mark.appendChild(target);
          target = mark;
        }
        output.appendChild(target);
      }
      current.text += character.value;
      current.node.textContent = current.text;
    });

    editor.innerHTML = output.innerHTML;
  }

  function TaskEditor({ task, onSave, onCancel, reminderOnly = false }) {
    const [hasSelection, setHasSelection] = useState(false);
    const [toolbarAbove, setToolbarAbove] = useState(false);
    const [reminderOpen, setReminderOpen] = useState(reminderOnly);
    const [reminderInput, setReminderInput] = useState(() => QieJi.reminderTime.toLocalInputValue(
      task.remindAt ? new Date(task.remindAt) : new Date(Date.now() + 60 * 60 * 1000)
    ));
    const [reminderError, setReminderError] = useState("");
    const [repeatTime, setRepeatTime] = useState(() => reminderInput.slice(11, 16));
    const [repeatWeekday, setRepeatWeekday] = useState(() => new Date(reminderInput).getDay());
    const [draftRepeat, setDraftRepeat] = useState(task.repeat || null);
    const [preset, setPreset] = useState(null);
    const reminderOptionsRef = useRef(null);
    const editorRef = useRef(null);
    const wrapRef = useRef(null);
    const finishedRef = useRef(false);
    const selectionOffsetsRef = useRef(null);

    useEffect(() => {
      if (reminderOpen) reminderOptionsRef.current?.scrollIntoView({ block: "nearest" });
    }, [reminderOpen, draftRepeat]);

    useEffect(() => {
      if (reminderOnly) reminderOptionsRef.current?.querySelector('button')?.focus({ preventScroll: true });
    }, [reminderOnly]);

    useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.innerHTML = taskRichHtml(task);
      editor.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, [task.text, task.html]);

    useEffect(() => {
      const updateSelection = () => {
        const editor = editorRef.current;
        const selection = window.getSelection();
        const selected = Boolean(
          editor
          && selection
          && !selection.isCollapsed
          && selection.rangeCount
          && editor.contains(selection.getRangeAt(0).commonAncestorContainer)
        );
        const toolbarFocused = Boolean(wrapRef.current?.querySelector('.format-toolbar')?.contains(document.activeElement));
        const keepSelection = selected || (toolbarFocused && selectionOffsetsRef.current);
        if (selected) selectionOffsetsRef.current = getSelectionOffsets(editor, selection);
        if (keepSelection && editor) {
          const scrollBoundary = editor.closest(".task-scroll")?.getBoundingClientRect();
          const editorRect = editor.getBoundingClientRect();
          const boundaryBottom = scrollBoundary?.bottom || window.innerHeight;
          setToolbarAbove(boundaryBottom - editorRect.bottom < 74);
        } else {
          setToolbarAbove(false);
        }
        setHasSelection(Boolean(keepSelection));
      };

      document.addEventListener("selectionchange", updateSelection);
      const scroll = document.querySelector(".task-scroll");
      scroll?.addEventListener("scroll", updateSelection, { passive: true });
      window.addEventListener("resize", updateSelection);
      return () => {
        document.removeEventListener("selectionchange", updateSelection);
        scroll?.removeEventListener("scroll", updateSelection);
        window.removeEventListener("resize", updateSelection);
      };
    }, []);

    const finish = (saveChanges) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const editor = editorRef.current;
      if (saveChanges && editor && !reminderOnly) {
        const text = (editor.innerText || "").replace(/\s*\n+\s*/g, " ").trim();
        if (text) onSave({ text, html: sanitizeRichText(editor.innerHTML) });
      }
      setHasSelection(false);
      setToolbarAbove(false);
      selectionOffsetsRef.current = null;
      onCancel();
    };

    useEffect(() => {
      const finishWhenOutside = (event) => {
        if (!wrapRef.current?.contains(event.target)) finish(true);
      };
      document.addEventListener("pointerdown", finishWhenOutside, true);
      return () => document.removeEventListener("pointerdown", finishWhenOutside, true);
    });

    useEffect(() => {
      const commit = () => finish(true);
      window.addEventListener("qieji-commit-edit", commit);
      return () => window.removeEventListener("qieji-commit-edit", commit);
    });

    const applyFormat = (command, value = null) => {
      if (!editorRef.current) return;
      editorRef.current.focus({ preventScroll: true });
      const selection = window.getSelection();
      const storedRange = rangeFromOffsets(editorRef.current, selectionOffsetsRef.current);
      if (storedRange && selection) {
        selection.removeAllRanges();
        selection.addRange(storedRange);
      }
      if (command === "highlight") {
        document.execCommand("styleWithCSS", false, true);
        document.execCommand("backColor", false, value);
      } else if (command === "removeFormat") {
        clearFormattingInRange(editorRef.current, selectionOffsetsRef.current);
        const clearedRange = rangeFromOffsets(editorRef.current, selectionOffsetsRef.current);
        if (clearedRange && selection) {
          selection.removeAllRanges();
          selection.addRange(clearedRange);
        }
      } else {
        document.execCommand("styleWithCSS", false, false);
        document.execCommand(command, false, value);
      }
      editorRef.current.focus({ preventScroll: true });
    };

    const preserveFormatSelection = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const closeReminder = () => {
      setReminderOpen(false);
      setReminderError("");
      if (reminderOnly) onCancel(true);
      else wrapRef.current?.querySelector('.task-reminder-toggle')?.focus({ preventScroll: true });
    };

    const openReminder = () => {
      const date = task.remindAt ? new Date(task.remindAt) : new Date(Date.now() + 3600000);
      const input = QieJi.reminderTime.toLocalInputValue(date);
      setReminderInput(input);
      setRepeatTime(input.slice(11, 16));
      setRepeatWeekday(date.getDay());
      setDraftRepeat(task.repeat || null);
      setPreset(null);
      setReminderError("");
      setReminderOpen(true);
    };

    const selectRepeat = (value) => {
      if (!value && draftRepeat) {
        // Keep the next occurrence of the draft rule when switching to one shot.
        const next = QieJi.reminderTime.parseRepeatInput(repeatTime, repeatWeekday, draftRepeat);
        if (next) setReminderInput(QieJi.reminderTime.toLocalInputValue(new Date(next)));
      }
      setDraftRepeat(value);
      setPreset(null);
      setReminderError("");
    };

    const selectPreset = (kind) => {
      const value = QieJi.reminderTime.reminderPreset(kind);
      const date = new Date(value);
      setReminderInput(QieJi.reminderTime.toLocalInputValue(date));
      setRepeatTime(QieJi.reminderTime.toLocalInputValue(date).slice(11, 16));
      setRepeatWeekday(date.getDay());
      setPreset({ kind, value });
      setReminderError("");
    };

    const draftValue = draftRepeat
      ? QieJi.reminderTime.parseRepeatInput(repeatTime, repeatWeekday, draftRepeat)
      : QieJi.reminderTime.parseReminderInput(preset?.value || reminderInput);
    const saveReminder = () => {
      if (!draftValue) {
        setReminderError(draftRepeat ? "请选择有效的重复时间" : "请选择将来的时间");
        return;
      }
      onSave({ remindAt: draftValue, repeat: draftRepeat, snoozedUntil: null });
      closeReminder();
    };
    const cancelReminder = () => {
      onSave({ remindAt: null, repeat: null, snoozedUntil: null });
      closeReminder();
    };

    return (
      <div ref={wrapRef} className="task-editor-wrap" onKeyDown={(event) => {
        if (event.key !== "Escape" || QieJi.isComposing(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (reminderOpen) {
          closeReminder();
        } else finish(false);
      }}>
        {reminderOnly ? <div className="task-copy" dangerouslySetInnerHTML={{ __html: taskRichHtml(task) }} /> : <div
          ref={editorRef}
          className="task-edit rich-task-editor"
          contentEditable="true"
          role="textbox"
          aria-label="编辑任务"
          aria-multiline="false"
          suppressContentEditableWarning="true"
          onBlur={(event) => {
            if (event.relatedTarget && !wrapRef.current?.contains(event.relatedTarget)) finish(true);
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain").replace(/\s*\n+\s*/g, " ");
            document.execCommand("insertText", false, text);
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab" && !event.shiftKey && hasSelection) {
              const button = wrapRef.current?.querySelector(".format-button");
              if (button) {
                event.preventDefault();
                selectionOffsetsRef.current = getSelectionOffsets(editorRef.current, window.getSelection())
                  || selectionOffsetsRef.current;
                button.focus({ preventScroll: true });
                return;
              }
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
              event.preventDefault();
              applyFormat("bold");
            }
            if (event.key === "Enter" && !QieJi.isComposing(event)) {
              event.preventDefault();
              finish(true);
            }
          }}
        ></div>}
        <div className="task-reminder-controls">
          {reminderOnly ? <p className="task-reminder-current">当前：{task.remindAt ? QieJi.reminderTime.reminderText(task) : "尚未设置提醒"}</p> : <button
            className="task-reminder-toggle"
            type="button"
            aria-expanded={reminderOpen}
            onClick={() => reminderOpen ? closeReminder() : openReminder()}
          >{task.remindAt ? `提醒 · ${QieJi.reminderTime.reminderText(task)}` : "提醒我"}</button>}
          {reminderOpen ? (
            <div className="task-reminder-options" ref={reminderOptionsRef} role="group" aria-label="提醒设置">
              <div className="task-reminder-presets">
                {!draftRepeat && <>
                  <button type="button" aria-pressed={preset?.kind === "hour"} onClick={() => selectPreset("hour")}>1 小时后</button>
                  <button type="button" aria-pressed={preset?.kind === "tomorrow"} onClick={() => selectPreset("tomorrow")}>明天 9 点</button>
                </>}
                {task.remindAt ? <button type="button" onClick={cancelReminder}>取消提醒</button> : null}
              </div>
              <div className="task-reminder-repeat" role="group" aria-label="提醒频率">
                <span className="task-reminder-repeat-label">提醒频率</span>
                <button type="button" aria-pressed={!draftRepeat}
                  onClick={() => selectRepeat(null)}>不重复</button>
                {QieJi.reminderTime.REPEAT_VALUES.map((value) => (
                  <button key={value} type="button" aria-pressed={draftRepeat === value}
                    onClick={() => selectRepeat(value)}>{QieJi.reminderTime.repeatLabel(value)}</button>
                ))}
              </div>
              <div className="task-reminder-custom">
                <label htmlFor={`task-reminder-${task.id}`}>{draftRepeat ? "重复时间" : "自定时间"}</label>
                {draftRepeat ? <>
                  {draftRepeat === "weekly" && <select aria-label="每周提醒星期" value={repeatWeekday}
                    onChange={(event) => setRepeatWeekday(Number(event.target.value))}>
                    {QieJi.reminderTime.WEEKDAY_LABELS.map((label, day) => <option key={day} value={day}>{label}</option>)}
                  </select>}
                  <input id={`task-reminder-${task.id}`} type="time" aria-label="重复提醒时间"
                    value={repeatTime} onChange={(event) => { setRepeatTime(event.target.value); setPreset(null); }} />
                </> :
                <input
                  id={`task-reminder-${task.id}`}
                  type="datetime-local"
                  aria-label="自定提醒时间"
                  min={QieJi.reminderTime.toLocalInputValue(new Date())}
                  value={reminderInput}
                  onChange={(event) => {
                    setReminderInput(event.target.value);
                    setPreset(null);
                    setRepeatTime(event.target.value.slice(11, 16));
                    setRepeatWeekday(new Date(event.target.value).getDay());
                  }}
                />}
              </div>
              <span className="task-reminder-next" aria-live="polite">{draftValue ? `待保存 · 下次提醒：${QieJi.reminderTime.reminderLabel(draftValue)}` : "待保存 · 请选择有效时间"}</span>
              {draftRepeat && <span className="task-reminder-rule">从最近一次匹配时间开始，完成任务后停止提醒。</span>}
              {reminderError ? <span className="task-reminder-error" role="alert">{reminderError}</span> : null}
              <div className="task-reminder-footer">
                <button type="button" onClick={closeReminder}>取消修改</button>
                <button type="button" className="task-reminder-save" onClick={saveReminder}>设置提醒</button>
              </div>
            </div>
          ) : null}
        </div>
        {hasSelection ? (
          <div className={`format-toolbar ${toolbarAbove ? "is-above" : ""}`} role="toolbar" aria-label="文字格式">
            <button
              className="format-button"
              type="button"
              title="加粗 · ⌘ B"
              aria-label="加粗"
              onMouseDown={preserveFormatSelection}
              onClick={() => applyFormat("bold")}
            ><strong>B</strong></button>
            {Object.entries(HIGHLIGHT_COLORS).map(([tone, color]) => (
              <button
                className={`format-button format-swatch ${tone}`}
                type="button"
                key={tone}
                title={`添加${tone === "sand" ? "米黄" : tone === "sage" ? "浅绿" : "淡蓝"}底色`}
                aria-label={`添加${tone === "sand" ? "米黄" : tone === "sage" ? "浅绿" : "淡蓝"}底色`}
                onMouseDown={preserveFormatSelection}
                onClick={() => applyFormat("highlight", color)}
              ></button>
            ))}
            <button
              className="format-button"
              type="button"
              title="清除格式"
              aria-label="清除格式"
              onMouseDown={preserveFormatSelection}
              onClick={() => applyFormat("removeFormat")}
            >清</button>
          </div>
        ) : null}
      </div>
    );
  }

  QieJi.richText = {
    sanitizeRichText,
    taskRichHtml,
    getSelectionOffsets,
    rangeFromOffsets,
    clearFormattingInRange
  };
  QieJi.TaskEditor = TaskEditor;
})();

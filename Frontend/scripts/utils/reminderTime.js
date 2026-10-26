(() => {
  const QieJi = window.QieJi = window.QieJi || {};
  const pad = (number) => String(number).padStart(2, "0");

  function toLocalInputValue(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function reminderPreset(kind, now = new Date()) {
    const date = new Date(now);
    if (kind === "hour") date.setHours(date.getHours() + 1);
    if (kind === "tomorrow") {
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
    }
    return date.toISOString();
  }

  function parseReminderInput(value, now = new Date()) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.getTime() > now.getTime()
      ? date.toISOString()
      : null;
  }

  function reminderLabel(value, now = new Date()) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const today = now;
    const sameDay = today.toDateString() === date.toDateString();
    const prefix = sameDay ? "今天" : `${date.getMonth() + 1}月${date.getDate()}日`;
    return `${date <= now ? "已错过 · " : ""}${prefix} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  const REPEAT_VALUES = ["daily", "weekdays", "weekly"];
  const REPEAT_LABELS = { daily: "每天", weekdays: "工作日", weekly: "每周" };

  function repeatLabel(value) {
    return REPEAT_LABELS[value] || "";
  }

  const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  // Repeats are wall-clock rules, not a future start date. Keep this aligned
  // with TaskReminderScheduler.repeatingReminders (including DST gap handling).
  function nextRepeatDate(task, now = new Date()) {
    const anchor = new Date(task?.remindAt);
    if (!repeatLabel(task?.repeat) || !Number.isFinite(anchor.getTime())) return null;
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + offset);
      candidate.setHours(anchor.getHours(), anchor.getMinutes(), 0, 0);
      const weekday = candidate.getDay();
      const matches = task.repeat === "daily"
        || (task.repeat === "weekdays" && weekday >= 1 && weekday <= 5)
        || (task.repeat === "weekly" && weekday === anchor.getDay());
      if (matches && candidate > now) return candidate;
    }
    return null;
  }

  function parseRepeatInput(time, weekday, repeat, now = new Date()) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !repeatLabel(repeat)
      || (repeat === "weekly" && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6))) return null;
    const [hour, minute] = time.split(":").map(Number);
    const anchor = new Date(now);
    if (repeat === "weekly") anchor.setDate(anchor.getDate() + weekday - anchor.getDay());
    anchor.setHours(hour, minute, 0, 0);
    return nextRepeatDate({ remindAt: anchor.toISOString(), repeat }, now)?.toISOString() || null;
  }

  function nextReminderDate(task, now = new Date()) {
    if (!task || task.done) return null;
    const regular = repeatLabel(task.repeat) ? nextRepeatDate(task, now) : new Date(task.remindAt);
    const snooze = new Date(task.snoozedUntil);
    const dates = [regular, snooze].filter(date => date && Number.isFinite(date.getTime()) && date > now);
    return dates.length ? new Date(Math.min(...dates.map(date => date.getTime()))) : null;
  }

  function hasScheduledReminder(task, now = new Date()) {
    return Boolean(nextReminderDate(task, now));
  }

  function reminderText(task, now = new Date()) {
    const date = new Date(task?.remindAt);
    if (!Number.isFinite(date.getTime())) return "";
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const repeat = repeatLabel(task.repeat);
    if (repeat) {
      const rule = task.repeat === "weekly" ? `每${WEEKDAY_LABELS[date.getDay()]}` : repeat;
      const next = nextReminderDate(task, now);
      return `${rule} ${time}${next ? ` · 下次 ${reminderLabel(next, now)}` : ""}`;
    }
    return reminderLabel(task.remindAt, now);
  }

  function snoozeDate(minutes = 15, now = new Date()) {
    return new Date(now.getTime() + minutes * 60000).toISOString();
  }

  QieJi.reminderTime = {
    toLocalInputValue,
    reminderPreset,
    parseReminderInput,
    reminderLabel,
    reminderText,
    repeatLabel,
    nextRepeatDate,
    parseRepeatInput,
    nextReminderDate,
    hasScheduledReminder,
    WEEKDAY_LABELS,
    snoozeDate,
    REPEAT_VALUES
  };
})();

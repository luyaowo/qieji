(() => {
  const QieJi = window.QieJi = window.QieJi || {};
  const GROUP_ORDER = ["today", "tomorrow", "upcoming"];
  const pad2 = (value) => String(value).padStart(2, "0");

  function startOfDay(date) {
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    return next;
  }

  function addDays(date, amount) {
    const next = new Date(date);
    next.setDate(next.getDate() + amount);
    return next;
  }

  function formatMonthDay(date) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function formatWeekday(date) {
    return new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(date);
  }

  function formatClock(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function groupMeta(today) {
    const tomorrow = addDays(today, 1);
    return {
      today: { label: "今天", date: `${formatMonthDay(today)} · ${formatWeekday(today)}` },
      tomorrow: { label: "最近", date: `${formatMonthDay(tomorrow)} 至 ${formatMonthDay(addDays(today, 6))}` },
      upcoming: { label: "长远", date: "不设日期" }
    };
  }

  QieJi.dateGroups = {
    GROUP_ORDER,
    startOfDay,
    addDays,
    formatMonthDay,
    formatWeekday,
    formatClock,
    groupMeta
  };
})();

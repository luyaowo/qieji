const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const context = { window: {}, Date };
vm.runInNewContext(fs.readFileSync(path.join(root, 'Frontend/scripts/utils/reminderTime.js'), 'utf8'), context);
const api = context.window.QieJi.reminderTime;
const local = (day, hour = 9, minute = 0) => new Date(2026, 9, day, hour, minute);
const repeating = (repeat = 'daily') => ({ id: 'r', text: '合成提醒', done: false,
  repeat, remindAt: new Date(2026, 10, 10, 9).toISOString() });

test('重复只取时间和星期，从最近一次匹配开始，不使用未来首日', () => {
  const now = local(23, 8);
  assert.equal(api.nextRepeatDate(repeating(), now).getTime(), local(23).getTime());
  assert.equal(api.nextRepeatDate(repeating('weekly'), now).getTime(), local(27).getTime());
  assert.equal(api.nextRepeatDate(repeating('weekdays'), local(23, 10)).getTime(), local(26).getTime());
  assert.equal(api.nextRepeatDate(repeating(), local(23)).getTime(), local(24).getTime());
});

test('重复输入只接受时分和合法星期，允许选择今天已过的时刻', () => {
  assert.equal(api.parseRepeatInput('09:00', 2, 'daily', local(23, 10)), local(24).toISOString());
  assert.equal(api.parseRepeatInput('09:00', 2, 'weekly', local(23, 10)), local(27).toISOString());
  for (const value of ['25:00', '12:60', '', 'abc']) {
    assert.equal(api.parseRepeatInput(value, 2, 'daily', local(23)), null);
  }
  assert.equal(api.parseRepeatInput('09:00', 7, 'weekly', local(23)), null);
});

test('通知稍后入口保留重复规则及原时间，一次性提醒仍延后原时间', () => {
  const source = fs.readFileSync(path.join(root, 'Frontend/scripts/App.jsx'), 'utf8');
  const handler = source.match(/window\.paperEdgeSnoozeTask = [\s\S]*?\n      };/)[0];
  const task = repeating('weekdays');
  let workspace = { tasks: [task, { ...task, id: 'one', repeat: null }] };
  vm.runInNewContext(handler, { window: context.window, QieJi: context.window.QieJi,
    setWorkspace: update => { workspace = update(workspace); } });
  const before = Date.now();
  context.window.paperEdgeSnoozeTask('r');
  assert.equal(workspace.tasks[0].remindAt, task.remindAt);
  assert.equal(workspace.tasks[0].repeat, 'weekdays');
  assert.ok(Math.abs(new Date(workspace.tasks[0].snoozedUntil).getTime() - before - 900000) < 1000);
  context.window.paperEdgeSnoozeTask('one');
  assert.ok(Math.abs(new Date(workspace.tasks[1].remindAt).getTime() - before - 900000) < 1000);
});

test('重复首日过去后仍有未来排期，延后时间单独参与下次提醒展示', () => {
  const now = local(23, 10);
  const task = { ...repeating(), remindAt: local(1).toISOString(), snoozedUntil: local(23, 10, 15).toISOString() };
  assert.equal(api.nextReminderDate(task, now).getTime(), local(23, 10, 15).getTime());
  assert.match(api.reminderText(task, now), /每天 09:00/);
  assert.match(api.reminderText(task, now), /下次.*10:15/);
  assert.equal(api.hasScheduledReminder(task, now), true);
  assert.equal(api.hasScheduledReminder({ ...task, done: true }, now), false);
  assert.equal(api.hasScheduledReminder({ remindAt: local(1).toISOString() }, now), false);
  assert.equal(api.nextRepeatDate({ ...task, repeat: 'unknown' }, now), null);
});

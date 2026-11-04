const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../Frontend/scripts/utils/reminderTime.js'), 'utf8'
);
const context = { window: {} };
vm.runInNewContext(source, context);
const { reminderPreset, parseReminderInput, toLocalInputValue, reminderLabel, reminderText, repeatLabel, snoozeDate } = context.window.QieJi.reminderTime;

const now = new Date(2026, 9, 14, 16, 30);
const hour = new Date(reminderPreset('hour', now));
assert.equal(hour.getTime() - now.getTime(), 60 * 60 * 1000);

const tomorrow = new Date(reminderPreset('tomorrow', now));
assert.equal(tomorrow.getDate(), 15);
assert.equal(tomorrow.getHours(), 9);
assert.equal(tomorrow.getMinutes(), 0);

assert.equal(parseReminderInput(toLocalInputValue(now), now), null);
assert.equal(parseReminderInput('not-a-date', now), null);
assert.equal(
  parseReminderInput(toLocalInputValue(hour), now),
  hour.toISOString()
);

assert.equal(reminderLabel(now.toISOString(), hour), '已错过 · 今天 16:30');
assert.equal(reminderLabel(hour.toISOString(), now), '今天 17:30');
assert.equal(reminderLabel('invalid', now), '');

assert.equal(repeatLabel('daily'), '每天');
assert.equal(repeatLabel('weekdays'), '工作日');
assert.equal(repeatLabel('weekly'), '每周');
assert.equal(repeatLabel('yearly'), '');

assert.equal(
  reminderText({ remindAt: hour.toISOString() }, now),
  '今天 17:30'
);
assert.equal(
  reminderText({ remindAt: now.toISOString(), repeat: 'daily' }, hour),
  '每天 16:30 · 下次 10月15日 16:30'
);
assert.equal(
  reminderText({ remindAt: now.toISOString(), repeat: 'weekly' }, hour),
  '每周三 16:30 · 下次 10月21日 16:30'
);
assert.equal(reminderText({ remindAt: 'invalid' }, now), '');

const snoozed = new Date(snoozeDate(15, now));
assert.equal(snoozed.getTime() - now.getTime(), 15 * 60 * 1000);
assert.equal(new Date(snoozeDate(undefined, now)).getTime() - now.getTime(), 15 * 60 * 1000);

console.log('提醒时间规则测试通过');

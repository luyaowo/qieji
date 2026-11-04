// Executed in isolated WebKit by verify-reliability.swift, never in the installed app.
const cases = [];
const check = (name, valid, detail = {}) => cases.push({ name, valid: Boolean(valid), ...detail });
// A resized/background native window may pause animation frames. The timer
// keeps the check bounded; assertions still inspect the actual rendered state.
const frame = () => Promise.race([
  new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  new Promise(resolve => setTimeout(resolve, 100))
]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const focusNative = () => new Promise(resolve => {
  window.addEventListener('qieji-window-focused', resolve, { once: true });
  window.webkit.messageHandlers.paperEdge.postMessage({ type: 'focus' });
});
const snapshot = async name => new Promise(resolve => {
  window.addEventListener('qieji-snapshot-done', resolve, { once: true });
  window.webkit.messageHandlers.paperEdge.postMessage({ type: 'snapshot', name });
});
if (location.pathname.endsWith('/help.html')) {
  await document.fonts.load('16px QieJiPaper'); await document.fonts.ready;
  check('help-title', document.title === '且记 · 使用说明');
  check('help-local-font', document.fonts.check('16px QieJiPaper'));
  check('help-explains-product-rules', document.body.textContent.includes('完成任务后停止')
    && document.body.textContent.includes('不随日期自动移动') && document.body.textContent.includes('合并，不是整份覆盖'));
  check('help-has-no-feedback-placeholder', !/mailto:|反馈地址|待填写/.test(document.body.innerHTML));
  check('help-offline-only', !document.querySelector('script,link[href^="http"],img[src^="http"]')
    && !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'));
  check('help-navigation-targets', [...document.querySelectorAll('nav a')].every(a => document.querySelector(a.getAttribute('href'))));
  check('help-fits-width', document.documentElement.scrollWidth <= innerWidth + 1);
  await snapshot('offline-help');
  return { cases, valid: cases.every(c => c.valid) };
}
for (let i = 0; i < 100 && !window.paperEdgeApplyWorkspace; i++) await wait(30);
const stored = () => JSON.parse(localStorage.getItem('paper-edge-workspace-v2'));
const task = id => stored().tasks.find(t => t.id === id);
const row = id => document.querySelector(`[data-task-id="${id}"]`);
const clickText = async text => {
  [...document.querySelectorAll('.task-reminder-options button')].find(b => b.textContent === text)?.click();
  await frame();
};
const setInput = async (input, value) => {
  if (!input) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await frame();
};
const outside = async () => {
  document.querySelector('.paper-heading').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await frame();
};
let serial = 0;
const reset = async extra => {
  await outside();
  const id = 'ux-' + (++serial);
  window.paperEdgeApplyWorkspace({ version: 2, sampleNoticePending: false, tasks: [
    { id, text: '合成测试任务', group: 'today', done: false, ...extra }
  ], trash: [] });
  window.paperEdgeSetOpen(true); await frame();
  return id;
};
const open = async id => {
  const bell = row(id)?.querySelector('.row-action.reminder');
  if (bell) bell.click();
  else { row(id)?.querySelector('.task-copy')?.click(); await frame(); document.querySelector('.task-reminder-toggle')?.click(); }
  await frame();
};
const save = async () => {
  (document.querySelector('.task-reminder-save') || document.querySelector('.task-reminder-custom button'))?.click();
  await frame();
};
window.paperEdgeSetMode('side'); await frame();
check('composer-group-label', document.querySelector('.composer-group-label')?.textContent === '新增到：');
let id = await reset({ remindAt: '2031-06-12T08:30:00.000Z' });
check('bell-present-for-open-task', !!row(id)?.querySelector('.row-action.reminder'));
await open(id);
check('bell-opens-panel-without-text-edit', !!document.querySelector('.task-reminder-options')
  && !document.querySelector('[contenteditable="true"]') && row(id).querySelector('.row-actions').inert);
let before = JSON.stringify(task(id));
await clickText('1 小时后');
check('preset-is-draft', JSON.stringify(task(id)) === before);
check('preset-keeps-panel-open', !!document.querySelector('.task-reminder-options'));
check('preview-distinguishes-unsaved', document.querySelector('.task-reminder-next')?.textContent.includes('待保存'));
document.querySelector('.task-reminder-options')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
await frame();
check('escape-discards-reminder-draft', JSON.stringify(task(id)) === before && !document.querySelector('.task-reminder-options'));
check('escape-restores-bell-focus', document.activeElement === row(id)?.querySelector('.row-action.reminder'));
await open(id); await clickText('每天');
check('repeat-is-draft', JSON.stringify(task(id)) === before);
await setInput(document.querySelector('input[type="time"]'), '07:45');
await save();
const saved = task(id), date = new Date(saved.remindAt);
check('save-applies-rule-and-time-together', saved.repeat === 'daily' && date.getHours() === 7 && date.getMinutes() === 45);
check('save-retains-manual-group', saved.group === 'today' && !saved.done);
check('save-closes-panel', !document.querySelector('.task-reminder-options'));
row(id).querySelector('.task-reminder-meta')?.click(); await frame();
check('saved-time-directly-opens-panel', !!document.querySelector('.task-reminder-options') && !document.querySelector('[contenteditable="true"]'));
await clickText('每周'); before = JSON.stringify(task(id));
await outside();
check('outside-discards-draft', JSON.stringify(task(id)) === before && !document.querySelector('.task-reminder-options'));
row(id).querySelector('.task-check').click(); await frame();
check('complete-stops-task-not-next-cycle', task(id).done && task(id).repeat === 'daily' && !row(id).querySelector('.row-action.reminder'));

id = await reset({ remindAt: '2031-06-12T08:30:00.000Z' }); await open(id);
before = JSON.stringify(task(id));
await setInput(document.querySelector('input[type="datetime-local"]'), '2020-01-01T08:00');
await save();
check('invalid-time-keeps-existing-reminder', task(id).remindAt === '2031-06-12T08:30:00.000Z' && !!document.querySelector('.task-reminder-error'));
check('invalid-time-keeps-panel-open', !!document.querySelector('.task-reminder-options'));
await clickText('取消修改');
check('cancel-modification-keeps-reminder', JSON.stringify(task(id)) === before && !document.querySelector('.task-reminder-options'));
await open(id); const chosenAt = Date.now(); await clickText('1 小时后'); await save();
check('preset-applies-only-on-save', Math.abs(new Date(task(id).remindAt).getTime() - chosenAt - 3600000) < 2000 && !task(id).repeat);

id = await reset({ remindAt: '2031-06-12T08:30:00.000Z', repeat: 'weekly', snoozedUntil: '2031-06-12T09:00:00.000Z' });
await open(id); await clickText('不重复');
const once = document.querySelector('input[type="datetime-local"]')?.value;
check('switch-to-once-is-draft', task(id).repeat === 'weekly');
await save();
check('switch-to-once-keeps-next-occurrence', !task(id).repeat && QieJi.reminderTime.toLocalInputValue(new Date(task(id).remindAt)) === once && new Date(task(id).remindAt) > new Date());
await open(id); await clickText('取消提醒');
check('cancel-reminder-clears-rule-and-snooze', !task(id).remindAt && !task(id).repeat && !task(id).snoozedUntil);

await setInput(document.querySelector('.task-input'), '新增归属合成任务');
document.querySelectorAll('.date-segments button')[1].click(); await frame();
check('group-switch-retains-draft-and-list', document.querySelector('.task-input').value === '新增归属合成任务' && task(id).group === 'today');
document.querySelector('.add-button').click(); await frame();
check('new-group-only-affects-new-task', stored().tasks.find(t => t.text === '新增归属合成任务')?.group === 'tomorrow' && task(id).group === 'today');
row(id).querySelector('.task-check').click(); await frame();
check('clean-tooltip-explains-recovery', document.querySelector('.toolbar-clean').title === '清理已完成：1 条，可从回收站恢复');
document.querySelector('.toolbar-clean').click(); await frame();
check('clean-feedback-and-recovery', document.querySelector('.undo-toast[role="status"]')?.textContent.includes('已将 1 条已完成任务移入回收站') && stored().trash.length === 1);
check('recovery-tooltip-count', document.querySelector('.recovery-button').title === '回收站：1 条');
document.querySelector('.recovery-button').click(); await frame();
check('recovery-title-consistent', document.querySelector('.recovery-heading h2')?.textContent === '回收站');
document.querySelector('.restore-button')?.click(); await frame();
check('recovery-preserves-task', task(id)?.group === 'today' && task(id)?.done && stored().trash.length === 0);
document.querySelector('.recovery-heading-actions button').click(); await frame();

for (const [mode, width, height] of [['side', 430, 720], ['side', 430, 540], ['paper', 680, 860], ['paper', 520, 540]]) {
  await outside();
  window.webkit.messageHandlers.paperEdge.postMessage({ type: 'resize', width, height });
  window.paperEdgeSetMode(mode); window.paperEdgeSetOpen(true); await frame(); await wait(300);
  const name = `${mode}-${width}x${height}`;
  const long = '多行任务需要完整显示，铃铛与删除入口不能覆盖正文。'.repeat(3);
  window.paperEdgeApplyWorkspace({ version: 2, sampleNoticePending: false, trash: [], tasks: [
    { id: 'layout-long', text: long, group: 'today', done: false },
    { id: 'layout-repeat', text: '保留原时刻的重复提醒', group: 'today', done: false, remindAt: '2031-01-01T01:00:00.000Z', repeat: 'daily' },
    { id: 'layout-done', text: '已完成任务', group: 'today', done: true },
    ...Array.from({ length: 14 }, (_, i) => ({ id: 'layout-' + i, text: '合成占位任务 ' + i, group: 'tomorrow', done: false })),
    { id: 'layout-bottom', text: '底部任务的提醒设置', group: 'upcoming', done: false }
  ] }); await frame();
  const scroll = document.querySelector('.task-scroll'); scroll.scrollTop = 0; await frame();
  const copy = row('layout-long').querySelector('.task-copy'), actions = row('layout-long').querySelector('.row-actions');
  check(name + '-long-text-and-actions-fit', copy.scrollWidth <= copy.clientWidth + 1 && copy.getBoundingClientRect().right <= actions.getBoundingClientRect().left);
  await focusNative(); copy.focus(); await frame(); await wait(160);
  check(name + '-keyboard-reveals-reminder', Number(getComputedStyle(actions).opacity) > .99);
  const composer = document.querySelector('.composer');
  check(name + '-composer-fits', composer.getBoundingClientRect().right <= innerWidth + 1 && composer.scrollWidth <= composer.clientWidth + 1);
  await snapshot(name + '-mixed');
  await open('layout-bottom'); await wait(160);
  const panel = document.querySelector('.task-reminder-options');
  if (panel) {
    panel.scrollTop = panel.scrollHeight; await frame();
    const pr = panel.getBoundingClientRect(), sr = scroll.getBoundingClientRect();
    const button = panel.querySelector('.task-reminder-save')?.getBoundingClientRect();
    check(name + '-reminder-panel-within-scroll', pr.top >= sr.top - 2 && pr.bottom <= sr.bottom + 2, { panelTop: pr.top, panelBottom: pr.bottom, scrollTop: sr.top, scrollBottom: sr.bottom });
    check(name + '-save-reachable', button && button.bottom <= Math.min(pr.bottom, sr.bottom) + 1);
    await snapshot(name + '-reminder');
  } else check(name + '-reminder-panel-within-scroll', false);
  await clickText('取消修改');
  await outside();
  row('layout-bottom').querySelector('.task-copy').click(); await frame();
  const editor = document.querySelector('.task-edit'); editor?.scrollIntoView({ block: 'nearest' }); await frame();
  if (editor) {
    editor.focus(); const range = document.createRange(); range.selectNodeContents(editor);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange')); await frame();
    const toolbar = document.querySelector('.format-toolbar')?.getBoundingClientRect(), sr = scroll.getBoundingClientRect();
    check(name + '-format-toolbar-within-scroll', toolbar && toolbar.top >= sr.top - 1 && toolbar.bottom <= sr.bottom + 1);
    await snapshot(name + '-format');
  } else check(name + '-format-toolbar-within-scroll', false);
}
return { cases, valid: cases.length > 0 && cases.every(c => c.valid) };

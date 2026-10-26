const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.QIEJI_STORAGE_SOURCE || path.join(__dirname, '../Frontend/scripts/services/taskStorage.js'), 'utf8');
const task = (id, extra = {}) => ({ id, text: id, group: 'today', done: false, ...extra });
function storage(initial = {}, native = null) {
  const values = new Map(Object.entries(initial)), messages = [];
  const context = { window: { QieJi: { dateGroups: { GROUP_ORDER: ['today', 'tomorrow', 'upcoming'] } },
    __QIEJI_NATIVE_WORKSPACE__: native, webkit: { messageHandlers: { paperEdge: { postMessage: message => messages.push(message) } } } },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    Date, Math, Set, JSON };
  vm.runInNewContext(source, context);
  return { api: context.window.QieJi.taskStorage, values, messages };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('导入导出保留重复规则与独立延后，拒绝非法规则和延后时间', () => {
  const { api } = storage();
  const current = { version: 2, tasks: [], trash: [] };
  const repeated = task('repeat', { repeat: 'weekdays', remindAt: '2026-10-23T01:00:00Z', snoozedUntil: '2026-10-23T01:15:00Z' });
  const incoming = { version: 2, tasks: [repeated], trash: [] };
  assert.deepEqual(plain(api.prepareImport(current, api.exportWorkspace(incoming)).workspace.tasks), [repeated]);
  for (const extra of [{ repeat: 'monthly' }, { snoozedUntil: 'invalid' }, { snoozedUntil: 123 }]) {
    assert.throws(() => api.prepareImport(current, { ...incoming, tasks: [{ ...repeated, ...extra }] }));
  }
});

test('旧任务迁移为工作区，不改变任务内容、分组或提醒', () => {
  const old = [task('old', { group: 'tomorrow', remindAt: '2026-10-21T08:00:00Z', html: '<b>old</b>' })];
  const { api } = storage({ 'paper-edge-tasks-v1': JSON.stringify(old) });
  assert.deepEqual(plain(api.readWorkspace()), { version: 2, tasks: old, trash: [] });
});
test('删除后持久化、重载、恢复，保留位置、富文本和提醒', () => {
  const { api, values } = storage();
  const original = { version: 2, tasks: [task('a'), task('b', { html: '<mark>b</mark>', remindAt: '2026-10-21T08:00:00Z' }), task('c')], trash: [] };
  const deleted = api.moveTasksToTrash(original, ['b']);
  assert.deepEqual(plain(deleted.tasks).map(t => t.id), ['a', 'c']);
  api.persistWorkspace(deleted, false);
  const reloaded = storage(Object.fromEntries(values)).api;
  const saved = reloaded.readWorkspace();
  assert.equal(saved.trash.length, 1);
  const restored = reloaded.restoreTrashEntries(saved, [saved.trash[0].id]);
  assert.deepEqual(plain(restored.tasks), original.tasks);
  assert.equal(restored.trash.length, 0);
});
test('批量清理已完成任务可按原位置恢复，不遗漏未完成任务', () => {
  const { api } = storage();
  const original = { version: 2, tasks: [task('a', { done: true }), task('b'), task('c', { done: true })], trash: [] };
  const deleted = api.moveTasksToTrash(original, ['a', 'c'], '清理已完成', 'batch');
  assert.equal(deleted.tasks[0].id, 'b');
  assert.ok(deleted.trash.every(e => e.batchId === 'batch' && e.task.done));
  const restored = api.restoreTrashEntries(deleted, deleted.trash.map(e => e.id));
  assert.deepEqual(plain(restored.tasks), original.tasks);
});
test('恢复不重复插入，也不覆盖同 ID 的当前任务', () => {
  const { api } = storage();
  const deleted = api.moveTasksToTrash({ tasks: [task('a')], trash: [] }, ['a']);
  deleted.tasks.push(task('a', { text: 'newer' }));
  const restored = api.restoreTrashEntries(deleted, [deleted.trash[0].id]);
  assert.equal(restored.tasks.length, 1);
  assert.equal(restored.tasks[0].text, 'newer');
  assert.deepEqual(plain(api.restoreTrashEntries(restored, ['missing'])), plain(restored));
});
test('本地工作区损坏时保留损坏副本，并从原生备份恢复清单与回收记录', () => {
  const native = { tasks: [], trash: [{ id: 'r', task: task('recover'), index: 0, deletedAt: 100 }] };
  const { api, values } = storage({ 'paper-edge-workspace-v2': '{broken' }, native);
  assert.deepEqual(plain(api.readWorkspace()), native);
  assert.ok([...values.keys()].some(key => key.startsWith('paper-edge-workspace-v2-corrupt-')));
});
test('工作区作为一个完整消息发送原生备份，任务与回收站不会拆开提交', () => {
  const { api, messages, values } = storage();
  const workspace = api.moveTasksToTrash({ tasks: [task('a')], trash: [] }, ['a']);
  api.persistWorkspace(workspace, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'workspace');
  assert.deepEqual(JSON.parse(values.get(api.WORKSPACE_KEY)), plain(messages[0].workspace));
});
test('草稿文字和所选分组跨重载保留，非法分组回退到今天', () => {
  const { api, values } = storage();
  api.persistDraft('还未提交', 'upcoming');
  assert.deepEqual(plain(storage(Object.fromEntries(values)).api.readDraft()), { text: '还未提交', group: 'upcoming' });
  api.persistDraft('wrong group', 'unknown');
  assert.deepEqual(plain(storage(Object.fromEntries(values)).api.readDraft()), { text: '', group: 'today' });
});
test('中文输入法确认阶段不被误认为提交', () => {
  const { api } = storage();
  assert.equal(api.isComposing({ nativeEvent: { isComposing: true } }), true);
  assert.equal(api.isComposing({ keyCode: 229 }), true);
  assert.equal(api.isComposing({ key: 'Enter' }), false);
});

test('原生工作区优先于合法但过时的浏览器缓存，包括空清单', () => {
  const old = { version: 2, tasks: [task('old')], trash: [] };
  for (const native of [{ version: 2, tasks: [task('latest')], trash: [] }, { version: 2, tasks: [], trash: [] }]) {
    const { api } = storage({ 'paper-edge-workspace-v2': JSON.stringify(old) }, native);
    assert.deepEqual(plain(api.readWorkspace()), native);
  }
});

test('浏览器配额耗尽后重启仍使用原生最新任务和回收记录', () => {
  const old = { version: 2, tasks: [task('old')], trash: [] };
  const latest = { version: 2, tasks: [task('latest')], trash: [{ id: 'deleted', task: task('recover'), index: 0, deletedAt: 100 }] };
  const values = new Map([['paper-edge-workspace-v2', JSON.stringify(old)]]);
  let native = old;
  const mount = () => {
    const context = {
      window: { QieJi: { dateGroups: { GROUP_ORDER: ['today', 'tomorrow', 'upcoming'] } },
        __QIEJI_NATIVE_WORKSPACE__: native,
        webkit: { messageHandlers: { paperEdge: { postMessage: message => { native = plain(message.workspace); } } } } },
      localStorage: { getItem: key => values.get(key) ?? null, setItem() { throw new Error('QuotaExceededError'); } }
    };
    vm.runInNewContext(source, context);
    return context.window.QieJi.taskStorage;
  };
  mount().persistWorkspace(latest, true);
  const withoutStamp = ({ updatedAt, ...rest }) => rest;
  assert.deepEqual(withoutStamp(native), latest);
  assert.ok(Number.isFinite(native.updatedAt));
  const restarted = mount();
  restarted.persistWorkspace(restarted.readWorkspace(), true);
  assert.deepEqual(withoutStamp(native), latest);
});

test('更新时间较新的副本优先，旧副本不会覆盖新任务', () => {
  const local = { version: 2, updatedAt: 200, tasks: [task('local')], trash: [] };
  const native = { version: 2, updatedAt: 100, tasks: [task('native')], trash: [] };
  const { api } = storage({ 'paper-edge-workspace-v2': JSON.stringify(local) }, native);
  assert.equal(api.readWorkspace().tasks[0].id, 'local');

  const olderLocal = { ...local, updatedAt: 50 };
  const newerNative = { ...native, updatedAt: 300 };
  const second = storage({ 'paper-edge-workspace-v2': JSON.stringify(olderLocal) }, newerNative);
  assert.equal(second.api.readWorkspace().tasks[0].id, 'native');
});

test('保存工作区会写入递增的时间戳', () => {
  const { api, values } = storage();
  const first = { version: 2, tasks: [task('a')], trash: [] };
  api.persistWorkspace(first, false);
  const one = JSON.parse(values.get(api.WORKSPACE_KEY)).updatedAt;
  api.persistWorkspace(first, false);
  const two = JSON.parse(values.get(api.WORKSPACE_KEY)).updatedAt;
  assert.ok(Number.isFinite(one) && Number.isFinite(two) && two > one);
});

test('导入记录超过上限时拒绝且不修改当前工作区', () => {
  const { api } = storage();
  const current = { version: 2, tasks: [], trash: [] };
  const tasks = Array.from({ length: api.MAX_IMPORT_RECORDS + 1 }, (_, i) => task('too-many-' + i));
  assert.throws(() => api.prepareImport(current, { version: 2, tasks, trash: [] }), /20000/);
  assert.deepEqual(plain(current), { version: 2, tasks: [], trash: [] });
});

test('导出再导入保留顺序、分组、富文本、提醒和回收记录', () => {
  const { api } = storage();
  const original = { version: 2, tasks: [task('b', { group: 'tomorrow', html: '<strong>b</strong>', remindAt: '2030-01-01T08:00:00Z' }), task('a')],
    trash: [{ id: 'deleted', task: task('c'), index: 1, deletedAt: 100 }] };
  const exported = api.exportWorkspace(original);
  assert.equal(exported.format, 'qieji-workspace');
  assert.ok(Number.isFinite(new Date(exported.exportedAt).getTime()));
  const imported = api.prepareImport({ version: 2, tasks: [], trash: [] }, JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(plain(imported.workspace), original);
  assert.deepEqual(plain(imported.summary), { tasks: 2, trash: 1, conflicts: 0 });
});

test('合并同时检查任务和回收站冲突，保留当前版本且不修改输入', () => {
  const { api } = storage();
  const current = { version: 2, tasks: [task('a', { text: 'current' })], trash: [{ id: 'r', task: task('b'), index: 0, deletedAt: 1 }] };
  const before = JSON.stringify(current);
  const incoming = { version: 2, tasks: [task('a'), task('b'), task('new')],
    trash: [{ id: 'r', task: task('c'), index: 0, deletedAt: 2 }, { id: 'r2', task: task('d'), index: 0, deletedAt: 2 }] };
  const result = api.prepareImport(current, incoming);
  assert.equal(result.workspace.tasks[0].text, 'current');
  assert.deepEqual(plain(result.workspace.tasks).map(t => t.id), ['a', 'new']);
  assert.deepEqual(plain(result.summary), { tasks: 1, trash: 1, conflicts: 3 });
  assert.equal(JSON.stringify(current), before);
  const twice = api.prepareImport(result.workspace, incoming);
  assert.equal(twice.summary.tasks, 0); assert.equal(twice.summary.trash, 0);
});

test('拒绝错误版本、非法分组、无效提醒、空内容和非法回收索引', () => {
  const { api } = storage(); const current = { version: 2, tasks: [], trash: [] };
  for (const bad of [null, { version: 3, tasks: [], trash: [] }, { version: 2, format: 'other', tasks: [], trash: [] },
    { version: 2, tasks: [task('bad', { group: 'unknown' })], trash: [] },
    { version: 2, tasks: [task('bad', { remindAt: 'invalid' })], trash: [] },
    { version: 2, tasks: [task('bad', { text: ' ' })], trash: [] },
    { version: 2, tasks: [], trash: [{ id: 'r', task: task('a'), index: -1, deletedAt: 1 }] }]) {
    assert.throws(() => api.prepareImport(current, bad));
  }
  assert.equal(api.prepareImport(current, current).summary.tasks, 0);
});

test('永久删除只处理确认时选择的回收记录，不删除当前任务或后加入记录', () => {
  const { api } = storage();
  const current = { version: 2, tasks: [task('keep')], trash: [
    { id: 'r1', task: task('a'), index: 0, deletedAt: 1 },
    { id: 'r2', task: task('b'), index: 0, deletedAt: 2 }] };
  const result = api.purgeTrashEntries(current, ['r1']);
  assert.deepEqual(plain(result.tasks), current.tasks);
  assert.deepEqual(plain(result.trash).map(e => e.id), ['r2']);
  assert.equal(current.trash.length, 2);
});

test('仅首次无数据时提示示例，清除示例保留用户修改和新增内容', () => {
  const { api } = storage();
  const first = api.readWorkspace(); assert.equal(first.sampleNoticePending, true);
  first.tasks = first.tasks.map((t, i) => i === 0 ? { ...t, text: '用户修改了示例' } : t);
  first.tasks.push(task('user-created'));
  const cleared = api.clearSampleTasks(first);
  assert.deepEqual(plain(cleared.tasks).map(t => t.id), ['sample-1', 'user-created']);
  assert.equal(cleared.sampleNoticePending, false);
  const existing = storage({ 'paper-edge-tasks-v1': JSON.stringify([task('existing')]) }).api.readWorkspace();
  assert.equal(existing.sampleNoticePending, undefined);
});

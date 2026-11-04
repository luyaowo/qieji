const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Babel = require('../Frontend/vendor/babel.min.js');

const sourcePath = process.env.QIEJI_TASK_ITEM_SOURCE
  || path.join(__dirname, '../Frontend/scripts/components/TaskItem.jsx');
const code = Babel.transform(fs.readFileSync(sourcePath, 'utf8'), {
  presets: ['react'], sourceType: 'script'
}).code;

// Execute the actual component handlers with event/capture boundaries controlled
// by each test. All task content is synthetic; no user's workspace is loaded.
function mount({ loseCaptureOnRelease = false, captureThrows = false } = {}) {
  const trace = [], cleanups = [], listeners = new Map(), timers = new Map();
  const capture = new Set();
  let timerId = 0;
  const host = {
    QieJi: {
      dateGroups: { GROUP_ORDER: ['today', 'tomorrow', 'upcoming'] },
      richText: { taskRichHtml: () => 'sample' }, TaskEditor: () => null
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  };
  const context = { window: host, React: {
    useRef: value => ({ current: value }),
    useState: value => [value, next => trace.push(['edit', next])],
    useEffect: callback => { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children })
  } };
  vm.runInNewContext(code, context);
  const tree = host.QieJi.TaskItem({
    task: { id: 'sample', text: 'sample', group: 'today', done: false },
    onToggle() {}, onDelete() {},
    onDragStart: id => trace.push(['start', id]),
    onDragMove: (id, y, dy) => trace.push(['move', y, dy]),
    onDragEnd: id => trace.push(['end', id]),
    onDragCancel: id => trace.push(['cancel', id])
  });
  const walk = node => !node || typeof node !== 'object' ? []
    : [node, ...node.children.flatMap(walk)];
  const text = walk(tree).find(node => node.props.className === 'task-copy').props;
  const element = {
    setPointerCapture(id) {
      if (captureThrows) throw new Error('Pointer is no longer active');
      capture.add(id);
    },
    hasPointerCapture: id => capture.has(id),
    releasePointerCapture(id) {
      capture.delete(id);
      if (loseCaptureOnRelease) tree.props.onLostPointerCapture?.(event(110, 0, id));
    }
  };
  const event = (y, buttons = 1, id = 1) => ({
    clientY: y, buttons, button: 0, pointerId: id,
    currentTarget: element, target: { closest: () => null }, preventDefault() {}
  });
  return {
    row: tree.props, text, event, trace, drag: host.QieJi.taskDrag,
    emit(type, value) { for (const callback of [...(listeners.get(type) || [])]) callback(value); },
    unmount() { cleanups.forEach(cleanup => cleanup()); },
    count: type => trace.filter(entry => entry[0] === type).length,
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
  };
}

test('单击松开后编辑，不开始拖动', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.row.onPointerUp(h.event(100, 0)); h.text.onClick();
  assert.deepEqual(h.trace, [['edit', 'text']]);
});

test('按下时的轻微抖动不触发拖动', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.row.onPointerMove(h.event(103));
  h.row.onPointerUp(h.event(103, 0)); h.text.onClick();
  assert.deepEqual(h.trace, [['edit', 'text']]);
});

test('按住移动后松开只结束排序，不误进入编辑', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.row.onPointerMove(h.event(110));
  h.row.onPointerUp(h.event(110, 0)); h.text.onClick();
  assert.equal(h.count('start'), 1); assert.equal(h.count('end'), 1);
  assert.equal(h.count('edit'), 0);
});

test('漏掉松开后，无按键的悬停不能开启拖动，仍可点击编辑', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.row.onPointerMove(h.event(110, 0)); h.text.onClick();
  assert.equal(h.count('start'), 0); assert.equal(h.count('edit'), 1);
});

test('拖动中发现左键已松开时取消浮起状态', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.row.onPointerMove(h.event(110));
  h.row.onPointerMove(h.event(120, 0));
  assert.equal(h.count('cancel'), 1); assert.equal(h.count('end'), 0);
});

test('行外松开会清除待拖动手势', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.emit('pointerup', h.event(100, 0));
  h.row.onPointerMove(h.event(110));
  assert.equal(h.count('start'), 0); assert.equal(h.listenerCount(), 0);
});

test('窗口和行内重复收到松开时只提交一次排序', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.row.onPointerMove(h.event(110));
  h.emit('pointerup', h.event(110, 0)); h.row.onPointerUp(h.event(110, 0));
  assert.equal(h.count('end'), 1); assert.equal(h.count('cancel'), 0);
  assert.equal(h.listenerCount(), 0);
});

test('丢失指针捕获时立即取消拖动', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.row.onPointerMove(h.event(110));
  h.row.onLostPointerCapture?.(h.event(110, 0));
  assert.equal(h.count('cancel'), 1); assert.equal(h.count('end'), 0);
});

test('正常释放触发捕获丢失时不会重复取消或提交', () => {
  const h = mount({ loseCaptureOnRelease: true });
  h.row.onPointerDown(h.event(100)); h.row.onPointerMove(h.event(110));
  h.row.onPointerUp(h.event(110, 0));
  assert.equal(h.count('end'), 1); assert.equal(h.count('cancel'), 0);
});

test('窗口失焦时取消拖动并移除临时监听', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.row.onPointerMove(h.event(110)); h.emit('blur');
  assert.equal(h.count('cancel'), 1); assert.equal(h.listenerCount(), 0);
});

test('指针取消后不会在随后的松开事件中再次提交', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.row.onPointerMove(h.event(110));
  h.row.onPointerCancel(h.event(110, 0)); h.row.onPointerUp(h.event(110, 0));
  assert.equal(h.count('cancel'), 1); assert.equal(h.count('end'), 0);
});

test('不属于当前指针的移动不会启动拖动', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.row.onPointerMove(h.event(110, 1, 2));
  assert.equal(h.count('start'), 0);
});

test('捕获失败时不会留下拖动状态或阻止下次编辑', () => {
  const h = mount({ captureThrows: true });
  h.row.onPointerDown(h.event(100));
  assert.doesNotThrow(() => h.row.onPointerMove(h.event(110)));
  h.text.onClick();
  assert.equal(h.count('start'), 0); assert.equal(h.count('edit'), 1);
  assert.equal(h.listenerCount(), 0);
});

test('卸载任务时取消尚未结束的拖动并清理监听', () => {
  const h = mount();
  h.row.onPointerDown(h.event(100)); h.row.onPointerMove(h.event(110)); h.unmount();
  assert.equal(h.count('cancel'), 1); assert.equal(h.listenerCount(), 0);
});

const keyboardTask = (id, group = 'today') => ({ id, text: id, group, done: false });
const ids = value => JSON.parse(JSON.stringify(value)).map(task => task.id);

test('键盘上下移动在同组内交换位置', () => {
  const { drag } = mount();
  const tasks = [keyboardTask('a'), keyboardTask('b'), keyboardTask('c')];
  assert.deepEqual(ids(drag.moveTaskByKeyboard(tasks, 'b', -1)), ['b', 'a', 'c']);
  assert.deepEqual(ids(drag.moveTaskByKeyboard(tasks, 'b', 1)), ['a', 'c', 'b']);
});

test('键盘上移越过组顶进入前一组末尾', () => {
  const { drag } = mount();
  const tasks = [keyboardTask('a'), keyboardTask('b'), keyboardTask('c', 'tomorrow')];
  const next = drag.moveTaskByKeyboard(tasks, 'c', -1);
  assert.equal(next.find(t => t.id === 'c').group, 'today');
  assert.deepEqual(ids(next), ['a', 'b', 'c']);
});

test('键盘下移越过组底进入后一组开头', () => {
  const { drag } = mount();
  const tasks = [keyboardTask('a'), keyboardTask('b', 'tomorrow'), keyboardTask('c', 'tomorrow')];
  const next = drag.moveTaskByKeyboard(tasks, 'a', 1);
  assert.equal(next.find(t => t.id === 'a').group, 'tomorrow');
  assert.deepEqual(ids(next), ['a', 'b', 'c']);
});

test('键盘移动到首尾边界时保持不变', () => {
  const { drag } = mount();
  const tasks = [keyboardTask('a'), keyboardTask('b', 'upcoming')];
  assert.equal(drag.moveTaskByKeyboard(tasks, 'a', -1), tasks);
  assert.equal(drag.moveTaskByKeyboard(tasks, 'b', 1), tasks);
  assert.equal(drag.moveTaskByKeyboard(tasks, 'missing', 1), tasks);
});

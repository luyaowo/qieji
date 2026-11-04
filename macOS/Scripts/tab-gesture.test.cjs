const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const sourcePath = process.env.QIEJI_APP_SOURCE || path.join(__dirname, '../Frontend/scripts/App.jsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.indexOf('    const sendTabDrag =');
const end = source.indexOf('    const patchTask =', start);
assert.ok(start >= 0 && end > start);
const handlers = source.slice(start, end);

function mount() {
  const messages = [], listeners = new Map(), capture = new Set(), classes = new Set();
  const context = { window: {
    webkit: { messageHandlers: { paperEdge: { postMessage: value => messages.push(value) } } },
    setTimeout() {},
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); }
  } };
  const api = vm.runInNewContext(`(() => {
    const IS_NATIVE = true, isOpen = false;
    const tabDragRef = {current: null}, suppressTabClickRef = {current: false};
    const useEffect = callback => callback();
    ${handlers}
    return {beginTabDrag, moveTabDrag, finishTabDrag};
  })()`, context);
  const element = {
    classList: { add: key => classes.add(key), remove: key => classes.delete(key) },
    setPointerCapture: id => capture.add(id),
    hasPointerCapture: id => capture.has(id),
    releasePointerCapture: id => capture.delete(id)
  };
  const event = (y, buttons = 1, id = 1) => ({
    screenY: y, buttons, button: 0, pointerId: id, currentTarget: element, preventDefault() {}
  });
  return { api, event, messages, capture, classes,
    emit(type) { listeners.get(type)?.(); },
    phases: () => messages.map(message => message.phase)
  };
}

test('侧边标签按下即捕获，实际移动后正常结束', () => {
  const h = mount(); h.api.beginTabDrag(h.event(100));
  assert.equal(h.capture.size, 1);
  h.api.moveTabDrag(h.event(110)); h.api.finishTabDrag(h.event(110, 0));
  assert.deepEqual(h.phases(), ['start', 'move', 'end']);
});

test('标签发现鼠标已松开时取消，不把悬停当作移动', () => {
  const h = mount(); h.api.beginTabDrag(h.event(100)); h.api.moveTabDrag(h.event(110, 0));
  assert.deepEqual(h.phases(), ['start', 'cancel']);
  assert.equal(h.classes.size, 0);
});

test('取消标签拖动时不提交最终位置', () => {
  const h = mount(); h.api.beginTabDrag(h.event(100)); h.api.moveTabDrag(h.event(110));
  h.api.finishTabDrag(h.event(110, 0), true);
  assert.deepEqual(h.phases(), ['start', 'move', 'cancel']);
});

test('其他指针的松开不会提前结束标签拖动', () => {
  const h = mount(); h.api.beginTabDrag(h.event(100));
  h.api.finishTabDrag(h.event(110, 0, 2)); h.api.moveTabDrag(h.event(110));
  assert.deepEqual(h.phases(), ['start', 'move']);
});

test('标签拖动中失焦会取消并释放捕获', () => {
  const h = mount(); h.api.beginTabDrag(h.event(100)); h.api.moveTabDrag(h.event(110)); h.emit('blur');
  assert.deepEqual(h.phases(), ['start', 'move', 'cancel']);
  assert.equal(h.capture.size, 0); assert.equal(h.classes.size, 0);
});

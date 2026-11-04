const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../Frontend/scripts/services/platformBridge.js'), 'utf8');
const workspace = text => ({ version: 2, tasks: [{id:'synthetic',text,group:'today',done:false}], trash: [] });
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(handler) {
  const calls = [], notices = [], listeners = new Map();
  const window = { __TAURI__: { core: { invoke(command, args) {
    calls.push({ command, args: plain(args || {}) });
    return Promise.resolve().then(() => handler(command, args || {}));
  } } }, paperEdgePrepareToQuit: () => workspace('current'), paperEdgeShowNotice: text => notices.push(text),
  paperEdgeExportWorkspace: () => ({...workspace('export'),format:'qieji-workspace'}),
  addEventListener: (name, fn) => listeners.set(name, fn) };
  vm.runInNewContext(source, { window, Promise, JSON, Error });
  return { window, api: window.QieJi.platform, calls, notices, emit: name => listeners.get(name)?.() };
}
test('React mount waits for native bootstrap, including empty workspaces', async () => {
  let release; const wait = new Promise(r => { release = r; }); let mounted = false;
  const h = harness(() => wait); const starting = h.api.start(() => { mounted = true; });
  await tick(); assert.equal(mounted, false);
  release({ workspace: {version:2,tasks:[],trash:[]}, recovered:false }); await starting;
  assert.equal(mounted, true); assert.deepEqual(plain(h.window.__QIEJI_NATIVE_WORKSPACE__.tasks), []);
});
test('failed native bootstrap never mounts sample tasks or writes a workspace', async () => {
  const h = harness(() => { throw new Error('corrupt workspace'); }); let mounted = false;
  await h.api.start(() => { mounted = true; });
  assert.equal(mounted, false); assert.ok(h.calls.every(c => c.command !== 'qieji_save'));
});
test('save requests are serialized and capture snapshots before later edits', async () => {
  let release; const wait = new Promise(r => { release = r; }); let writes = 0;
  const h = harness(async (command,args) => { writes++; if (writes===1) await wait; return args.workspace; });
  const first = workspace('first'); h.api.postMessage({type:'workspace',workspace:first}); first.tasks[0].text='mutated';
  h.api.postMessage({type:'workspace',workspace:workspace('second')}); await tick();
  assert.equal(h.calls.length,1); assert.equal(h.calls[0].args.workspace.tasks[0].text,'first');
  assert.equal(h.api.getSaveState().status,'saving'); release(); await h.api.flush();
  assert.equal(h.calls.length,2); assert.equal(h.api.getSaveState().status,'saved');
  assert.equal(h.window.__QIEJI_NATIVE_WORKSPACE__.tasks[0].text,'second');
});
test('save failure cancels quit; retry must save before native exit', async () => {
  let failing=true;
  const h=harness((command,args) => {
    if(command==='qieji_bootstrap')return {workspace:workspace('before'),recovered:false};
    if(command==='qieji_save'){if(failing)throw new Error('disk failure');return args.workspace;}
    return true;
  });
  await h.api.start(()=>{});
  assert.equal(await h.api.requestClose(),false);
  assert.equal(h.api.getSaveState().status,'error'); assert.ok(!h.calls.some(c=>c.command==='qieji_exit'));
  assert.ok(h.notices.some(n=>n.includes('取消退出')));
  failing=false; assert.equal(await h.api.requestClose(),true);
  assert.equal(h.calls.at(-1).command,'qieji_exit'); assert.equal(h.api.getSaveState().status,'saved');
});
test('export remains usable when native workspace saving fails', async () => {
  const h=harness((command,args)=>{if(command==='qieji_save')throw new Error('disk failure');return true;});
  await assert.rejects(h.api.saveCurrent());
  assert.equal(await h.api.exportWorkspace(),true);
  const call=h.calls.find(c=>c.command==='qieji_export'); assert.equal(call.args.workspace.tasks[0].text,'export');
  assert.equal(h.api.getSaveState().status,'error');
});
test('import backup failure never applies the imported UI state', async () => {
  let applied=false;
  const h=harness((command,args)=>{
    if(command==='qieji_save')return args.workspace;
    if(command==='qieji_pick_import')return workspace('incoming');
    if(command==='qieji_confirm_import')return true;
    if(command==='qieji_import')throw new Error('backup failed');
  });
  h.window.paperEdgePreviewImport=()=>({before:workspace('current'),workspace:workspace('merged'),summary:{tasks:1,trash:0,conflicts:0}});
  h.window.paperEdgeApplyWorkspace=()=>{applied=true;};
  assert.equal(await h.api.importWorkspace(),false); assert.equal(applied,false);
  assert.ok(h.notices.some(n=>n.includes('backup failed')));
});
test('canceling the import file picker never creates a checkpoint', async () => {
  const h=harness((command,args)=>command==='qieji_save'?args.workspace:null);
  assert.equal(await h.api.importWorkspace(),false);
  assert.ok(!h.calls.some(c=>c.command==='qieji_import'));
});

const desktopState = (view, trayReady = true) => ({view, mode:view==='paper'?'paper':'side',open:view!=='edge',trayReady});
test('native startup restores a collapsed edge before mounting React', async () => {
  const h=harness(()=>({workspace:workspace('saved'),recovered:false,desktop:desktopState('edge')}));
  await h.api.start(()=>{});
  assert.equal(h.window.__QIEJI_PANEL_OPEN__,false);
  assert.equal(h.window.__QIEJI_DISPLAY_MODE__,'side');
});
test('window transitions commit the current editor before changing native bounds', async () => {
  const h=harness((command,args)=>command==='qieji_bootstrap'?{workspace:workspace('before'),desktop:desktopState('paper')}:
    command==='qieji_window'?desktopState(args.view):args.workspace);
  await h.api.start(()=>{});
  h.window.paperEdgePrepareToQuit=()=>workspace('unblurred edit');
  assert.equal(await h.api.requestDesktop('edge'),true);
  const change=h.calls.find(c=>c.command==='qieji_window');
  assert.equal(change.args.workspace.tasks[0].text,'unblurred edit');
  assert.ok(h.calls.findIndex(c=>c.command==='qieji_save')<h.calls.indexOf(change));
  assert.equal(h.api.getDesktopState().view,'edge');
});
test('failed writes block collapse and tray hide without losing the open window', async () => {
  const h=harness(command=>{if(command==='qieji_bootstrap')return {workspace:workspace('saved'),desktop:desktopState('paper')};
    if(command==='qieji_save')throw new Error('disk failure');});
  await h.api.start(()=>{});
  assert.equal(await h.api.requestDesktop('edge'),false);
  assert.equal(await h.api.requestWindowClose(),false);
  assert.equal(h.api.getDesktopState().view,'paper');
  assert.ok(!h.calls.some(c=>c.command==='qieji_window'||c.command==='qieji_exit'));
});
test('native window failure rolls back the displayed mode', async () => {
  const h=harness((command,args)=>{if(command==='qieji_bootstrap')return {workspace:workspace('saved'),desktop:desktopState('paper')};
    if(command==='qieji_window')throw new Error('window unavailable');return args.workspace;});
  await h.api.start(()=>{});
  assert.equal(await h.api.requestDesktop('edge'),false);
  assert.equal(h.api.getDesktopState().view,'paper');
});
test('close hides only when tray exists; explicit quit still exits', async () => {
  const h=harness((command,args)=>command==='qieji_bootstrap'?{workspace:workspace('saved'),desktop:desktopState('paper')}:
    command==='qieji_window'?desktopState(args.view):args.workspace);
  await h.api.start(()=>{});
  assert.equal(await h.api.requestWindowClose(),true);
  assert.equal(h.calls.at(-1).command,'qieji_window');
  assert.equal(h.calls.at(-1).args.view,'hidden');
  assert.equal(await h.api.requestClose(),true);
  assert.equal(h.calls.at(-1).command,'qieji_exit');
});
test('missing tray falls back to saving and exiting instead of disappearing', async () => {
  const h=harness((command,args)=>command==='qieji_bootstrap'?{workspace:workspace('saved'),desktop:desktopState('paper',false)}:args.workspace);
  await h.api.start(()=>{});
  assert.equal(await h.api.requestWindowClose(),true);
  assert.equal(h.calls.at(-1).command,'qieji_exit');
});
test('Chinese composition blocks transitions and exit until composition ends', async () => {
  const h=harness((command,args)=>command==='qieji_bootstrap'?{workspace:workspace('saved'),desktop:desktopState('paper')}:
    command==='qieji_window'?desktopState(args.view):args.workspace);
  await h.api.start(()=>{});h.emit('compositionstart');
  assert.equal(await h.api.requestDesktop('edge'),false);
  assert.equal(await h.api.requestClose(),false);
  assert.ok(!h.calls.some(c=>c.command==='qieji_window'||c.command==='qieji_exit'));
  h.emit('compositionend');assert.equal(await h.api.requestDesktop('edge'),true);
});

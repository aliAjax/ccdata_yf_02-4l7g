// 规则层测试：node test-rules.js
const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, 'rules.js'), 'utf8');
eval(code.replace(/\(typeof window[^)]*\)/, '(globalThis)'));
const R = globalThis.WhiteboardRules;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); }
}
function memStore() { let s = null; return { read: () => s, write: v => { s = v; return true; } }; }
function ids(p) { return Object.keys(p.elements); }

// 1. 启动种子房间
let st = R.createStore(memStore());
ok(st.roomId() === 'SPRINT_42', 'boot lands in seeded room');
ok(ids(st.present()).length === 5, 'seed has 5 elements, got ' + ids(st.present()).length);
ok(Object.keys(st.present().edges).length === 1, 'seed has 1 edge');

// 2. 房间隔离
st.switchRoom('ROOM-B');
ok(ids(st.present()).length === 0, 'new room is empty');
st.addElement('note', 10, 10, 'blue');
ok(ids(st.present()).length === 1, 'add in room B');
st.switchRoom('SPRINT_42');
ok(ids(st.present()).length === 5, 'room A still 5 after switch back');
st.switchRoom('ROOM-B');
ok(ids(st.present()).length === 1, 'room B still 1');

// 3. 撤销/重做按房间独立
ok(st.canUndo() === true, 'B can undo');
st.undo();
ok(ids(st.present()).length === 0, 'B undo -> 0');
st.switchRoom('SPRINT_42');
ok(st.canUndo() === false, 'A undo stack untouched by B operations');
ok(ids(st.present()).length === 5, 'A content untouched');
st.switchRoom('ROOM-B');
ok(st.canUndo() === false, 'B nothing more to undo');
ok(st.canRedo() === true, 'B can redo');
st.redo();
ok(ids(st.present()).length === 1, 'B redo restores element');

// 4. 删除端点连带清理连线
st.switchRoom('SPRINT_42');
const eid = Object.keys(st.present().edges)[0];
const edge = st.present().edges[eid];
st.removeElement(edge.from);
ok(!st.present().edges[eid], 'edge removed with endpoint');
ok(ids(st.present()).length === 4, 'element deleted');
// 无悬空
const dangling = Object.values(st.present().edges).filter(
  e => !st.present().elements[e.from] || !st.present().elements[e.to]);
ok(dangling.length === 0, 'no dangling edges after remove');
st.undo();
ok(st.present().edges[eid], 'undo restores edge');
ok(!!st.present().elements[edge.from], 'undo restores endpoint element');

// 5. 拖拽事务：preview 不入栈，commit 一次入栈
st.begin();
const before = ids(st.present()).length;
st.preview(p => { const first = Object.keys(p.elements)[0]; p.elements[first].x = 999; });
ok(st.canUndo() === false, 'preview does not create undo entry');
st.commit(function () {}, { action: 'move' });
ok(st.canUndo() === true, 'commit creates one undo entry');
ok(st.present().elements[edge.from] === undefined || st.present().elements[Object.keys(st.present().elements)[0]].x === 999, 'preview value kept after commit');
st.undo();
ok(Object.values(st.present().elements).some(e => e.x !== 999), 'undo move');

// cancel 回滚
st.begin();
st.preview(p => { const f = Object.keys(p.elements)[0]; p.elements[f].y = 777; });
st.cancel();
ok(!Object.values(st.present().elements).some(e => e.y === 777), 'cancel rolls back');
ok(st.canUndo() === false, 'cancel creates no history entry');
// cancel 不清空 redo（拖拽取消不应丢弃可重做的历史）
ok(st.canRedo() === true, 'cancel keeps redo stack');

// 6. 连线校验
st.switchRoom('EDGES');
const a = st.addElement('circle', 0, 0);
const b = st.addElement('circle', 100, 100);
ok(st.addEdge(a, b).ok, 'edge between two elements ok');
ok(st.addEdge(a, b).reason === 'duplicate', 'duplicate edge rejected');
ok(st.addEdge(a, a).reason === 'self', 'self loop rejected');
ok(st.addEdge(a, 'nope').reason === 'missing', 'missing endpoint rejected');

// 7. 清空房间 + 撤销
ok(st.clearRoom() === true, 'clear returns changed');
ok(ids(st.present()).length === 0 && Object.keys(st.present().edges).length === 0, 'room cleared');
st.undo();
ok(ids(st.present()).length === 2, 'undo clear restores elements');
ok(Object.keys(st.present().edges).length === 1, 'undo clear restores edges');

// 8. 导出 -> 导入往返
st.switchRoom('SPRINT_42');
const bundle = st.exportBundle();
ok(bundle.app === 'canvas-room' && bundle.version === 1 && bundle.room === 'SPRINT_42', 'export shape');
const json = JSON.stringify(bundle);
const back = JSON.parse(json);
const st2 = R.createStore(memStore());
const res2 = st2.importBundle(back);
ok(res2.ok && res2.roomId === 'SPRINT_42', 'import valid bundle');
ok(st2.roomId() === 'SPRINT_42', 'import switches to bundle room');
const origIds = Object.keys(st.present().elements).sort();
const newIds = Object.keys(st2.present().elements).sort();
ok(JSON.stringify(origIds) === JSON.stringify(newIds), 'import keeps same element ids');
ok(Object.keys(st2.present().edges).length === Object.keys(st.present().edges).length, 'import keeps edges');

// 9. 损坏内容不得覆盖当前画面
const beforeImport = JSON.stringify(st2.present());
function reject(label, tamper) {
  const bad = JSON.parse(json); tamper(bad);
  const r = st2.importBundle(bad);
  ok(r.ok === false, label + ' rejected: ' + r.error);
  ok(JSON.stringify(st2.present()) === beforeImport, label + ' did not overwrite board');
}
reject('not an object', b => { b.elements = 'oops'; });
reject('bad room', b => { b.room = '../bad'; });
reject('wrong app', b => { b.app = 'other'; });
reject('wrong version', b => { b.version = 99; });
reject('missing elements', b => { delete b.elements; });
reject('bad element type', b => { b.elements[0].type = 'hack'; });
reject('non-finite coords', b => { b.elements[0].x = 'abc'; });
reject('dangling edge', b => { b.edges[0].to = 'ghost_id'; });
reject('self edge', b => { b.edges[0].to = b.edges[0].from; });
reject('malformed edge', b => { b.edges[0] = { id: 'x' }; });

// 非 JSON 文本由调用方 parse 捕获；validateBundle 对非对象
ok(R.validateBundle(null).ok === false, 'null bundle rejected');
ok(R.validateBundle({}).ok === false, 'empty bundle rejected');

// 10. 导入新房间不影响旧房间
const st3 = R.createStore(memStore());
const fresh = JSON.parse(json); fresh.room = 'IMPORTED';
const r3 = st3.importBundle(fresh);
ok(r3.ok && st3.roomId() === 'IMPORTED', 'import creates/switches room');
st3.switchRoom('SPRINT_42');
ok(ids(st3.present()).length === 5, 'original seeded room untouched by import');

// 11. 离线持久化恢复（同一存储、新 store 实例 = 刷新）
const ms = memStore();
const s1 = R.createStore(ms);
s1.switchRoom('PERSIST');
const pid = s1.addElement('note', 50, 60, 'pink');
s1.addElement('text', 80, 90);
s1.addEdge(pid, Object.keys(s1.present().elements)[1]);
s1.undo(); // 撤销的是连线，元素仍在，留下 redo
const s2 = R.createStore(ms); // 模拟刷新
ok(s2.roomId() === 'PERSIST', 'refresh lands on last room');
ok(ids(s2.present()).length === 2, 'refresh keeps latest state (2 elements, edge undone)');
ok(s2.canRedo() === true, 'redo stack survives refresh');
s2.redo();
ok(ids(s2.present()).length === 2, 'redo after refresh works');
ok(Object.keys(s2.present().edges).length === 1, 'edge restored by redo');

// 12. 损坏的持久化数据被清洗，不白屏
const dirty = ms.read();
const corruptDb = JSON.stringify({
  rooms: {
    'BAD..': { present: { elements: { x: { type: 'note', x: 1, y: 2 } }, edges: {} } },
    'OK1': { present: { elements: { e: { id: 'e', type: 'rect', x: 1, y: 1 } }, edges: { dang: { id: 'dang', from: 'e', to: 'gone' } } }, past: 'nope', future: [] }
  },
  lastRoom: 'OK1'
});
const dms = { read: () => corruptDb, write: () => true };
const s4 = R.createStore(dms);
ok(s4.wasCorruptOnBoot() === true, 'corruption detected');
ok(s4.roomIds().indexOf('BAD..') === -1, 'invalid room id dropped');
ok(s4.roomId() === 'OK1', 'valid room kept');
ok(Object.keys(s4.present().edges).length === 0, 'dangling edge pruned on recovery');
ok(s4.present().elements.e && s4.present().elements.e.type === 'rect', 'valid element kept');

// 13. 完全无法解析的存储 -> 全新种子
const dead = { read: () => '{not json', write: () => true };
const s5 = R.createStore(dead);
ok(s5.roomId() === 'SPRINT_42' && ids(s5.present()).length === 5, 'unparseable storage reseeds');
ok(s5.wasCorruptOnBoot() === true, 'unparseable marked corrupt');

// 14. 撤销快照里的悬空数据也被清洗
const snapCorrupt = { read: () => JSON.stringify({
  rooms: { R: { present: { elements: {}, edges: {} }, past: [{ elements: { x: { id: 'x', type: 'note', x: 1, y: 1 } }, edges: { d: { id: 'd', from: 'x', to: 'y' } } }], future: [] } },
  lastRoom: 'R'
}), write: () => true };
const s6 = R.createStore(snapCorrupt);
ok(s6.canUndo(), 'has past');
s6.undo();
const dangles = Object.values(s6.present().edges).filter(e => !s6.present().elements[e.to]);
ok(dangles.length === 0, 'restored snapshot has no dangling edge');

// 15. 房间号规则
ok(R.roomIdValid('SPRINT_42') && R.roomIdValid('a') && R.roomIdValid('x-1'), 'valid room ids');
ok(!R.roomIdValid('') && !R.roomIdValid('-x') && !R.roomIdValid('a b') && !R.roomIdValid('x'.repeat(33)), 'invalid room ids');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

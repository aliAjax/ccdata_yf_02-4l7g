// 规则层行为测试：在 Node 中给 rules.js 提供 window/localStorage 垫片后加载
'use strict';
const fs = require('fs');
const vm = require('vm');

function makeMemoryStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    _dump: () => Object.fromEntries(m)
  };
}

const sandbox = {};
sandbox.window = sandbox;
sandbox.localStorage = makeMemoryStorage();
sandbox.Date = Date;
sandbox.Math = Math;
sandbox.JSON = JSON;
sandbox.isFinite = isFinite;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('/workspace/rules.js', 'utf8'), sandbox);
const { RoomStore } = sandbox.WB;

let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  passed++;
}
// 与页面层 commit 同语义：先快照、再变更、再入栈
function doRecord(store, fn) {
  const before = store.snapshot();
  const ret = fn();
  store.record(before);
  return ret;
}

// 1) 首次初始化：默认房间 + 示例数据
let store = new RoomStore(sandbox.localStorage);
store.init('');
ok(store.roomId === 'SPRINT-42', '默认进入 SPRINT-42');
ok(Object.keys(store.state.elements).length === 5, '种子房间有 5 个元素');
ok(Object.keys(store.state.connections).length === 1, '种子房间有 1 条连线');

// 2) 房间隔离：切到新房间为空，切回数据还在
store.switchRoom('ROOM-A');
ok(Object.keys(store.state.elements).length === 0, '新房间为空');
const e1 = doRecord(store, () => store.addElement('note', 10, 10, { color: 'pink', text: 'A1' }));
store.switchRoom('ROOM-B');
ok(Object.keys(store.state.elements).length === 0, 'B 房间看不到 A 的元素');
const e2 = doRecord(store, () => store.addElement('rect', 20, 20));
store.switchRoom('ROOM-A');
ok(store.state.elements[e1.id] && store.state.elements[e1.id].text === 'A1', '切回 A 数据恢复');
ok(!store.state.elements[e2.id], 'A 中不存在 B 的元素');

// 3) 撤销/重做栈按房间独立：A、B 各自有 1 步，互不影响
ok(store.canUndo() === true && store.state.elements[e1.id], 'A 的栈保留自己的新增步骤');
store.switchRoom('ROOM-B');
ok(store.canUndo() === true && Object.keys(store.state.elements).length === 1, 'B 栈独立保留');
store.undo();
ok(Object.keys(store.state.elements).length === 0, 'B 撤销新增');
ok(store.canRedo() === true, 'B 可重做');
store.redo();
ok(store.state.elements[e2.id], 'B 重做恢复元素');
store.switchRoom('ROOM-A');
ok(store.canUndo() === true && store.state.elements[e1.id], 'A 的栈不受 B 撤销影响');

// 4) 刷新恢复：新建 store（同一 localStorage），停在最近房间且状态/栈都在
const store2 = new RoomStore(sandbox.localStorage);
store2.init('');
ok(store2.roomId === 'ROOM-A', '刷新后停在最近房间 A');
ok(store2.state.elements[e1.id], '刷新后 A 状态恢复');
ok(store2.canUndo() === true, '刷新后撤销栈仍在');

// 5) 连线绑定：移动不影响关系；删除端点时级联清理悬空连线
store = store2;
const x = store.addElement('circle', 0, 0);
const y = store.addElement('circle', 100, 100);
const conn = store.addConnection(e1.id, x.id);
ok(conn && store.state.connections[conn.id], '连线已建立');
ok(store.addConnection(e1.id, x.id) === null, '重复连线被拒绝');
ok(store.addConnection(x.id, e1.id) === null, '反向重复连线被拒绝');
ok(store.addConnection(x.id, y.id), '第二根连线建立');
store.setPosition(x.id, 500, 500);
ok(store.state.connections[conn.id].from === e1.id, '移动后绑定关系不变');
store.deleteElement(x.id);
ok(!store.state.connections[conn.id], '端点消失后连线一并清理');
ok(Object.keys(store.state.connections).every(id => {
  const c = store.state.connections[id];
  return store.state.elements[c.from] && store.state.elements[c.to];
}), '不存在任何悬空连线');

// 6) 改线：端点更新；禁止连自己/重复（此时仅剩 e1 与 y 两个孤立元素）
const z = store.addElement('circle', 200, 0);
const relinkConn = store.addConnection(e1.id, y.id);
ok(relinkConn, '为改线测试建立连线');
const c2 = relinkConn.id;
const c2obj = store.state.connections[c2];
ok(store.updateConnectionEnd(c2, 'from', z.id) === true, '改线成功');
ok(c2obj.from === z.id && store.state.elements[c2obj.to], '新端点有效，关系完整');
ok(store.updateConnectionEnd(c2, 'from', c2obj.to) === false, '禁止改到另一个端点（自连）');
ok(store.updateConnectionEnd(c2, 'from', 'ghost-id') === false, '禁止改到不存在的元素');
const dup = store.addConnection(e1.id, y.id);
ok(dup, '建立另一根 e1-y 连线');
ok(store.updateConnectionEnd(c2, 'from', e1.id) === false, '禁止改成已存在的关系（e1-y）');
ok(c2obj.from === z.id, '改线失败时关系原样回滚');

// 7) 清空房间 + 撤销
const beforeClear = store.snapshot();
store.clearRoom();
ok(Object.keys(store.state.elements).length === 0 && Object.keys(store.state.connections).length === 0, '清空无残留');
store.record(beforeClear);
store.undo();
ok(Object.keys(store.state.elements).length > 0, '清空可撤销恢复');

// 8) 导出 → 导入往返；导入到新房间且当前画面不受影响
store.switchRoom('ROOM-C');
doRecord(store, () => store.addElement('note', 5, 5, { text: '导出测试\n第二行', color: 'blue' }));
const exported = store.exportRoom();
const json = JSON.parse(exported);
ok(json.roomId === 'ROOM-C' && json.state.elements.length === 1, '导出包含房间号与元素');

// 9) 损坏内容不得覆盖当前画面
const currentRoom = store.roomId;
const currentCount = Object.keys(store.state.elements).length;
const badCases = [
  ['not json{', '非 JSON'],
  [JSON.stringify({ app: 'other', version: 1 }), '非本应用文件'],
  [JSON.stringify({ app: 'canvas-room', version: 9, roomId: 'X' }), '版本错误'],
  [JSON.stringify({ app: 'canvas-room', version: 1, roomId: 'X', state: { elements: [{ id: 'a' }], connections: [] } }), '元素缺字段'],
  [JSON.stringify({ app: 'canvas-room', version: 1, roomId: 'X', state: { elements: [], connections: [{ id: 'c', from: 'a', to: 'b' }] } }), '悬空连线'],
  [JSON.stringify({ app: 'canvas-room', version: 1, roomId: 'X', state: { elements: [{ id: 'a', kind: 'note', x: 0, y: 0 }, { id: 'a', kind: 'note', x: 1, y: 1 }], connections: [] } }), '重复 ID'],
  [JSON.stringify({ app: 'canvas-room', version: 1, roomId: 'bad room!!', state: { elements: [], connections: [] } }), '房间号非法']
];
badCases.forEach(([text, label]) => {
  let threw = false;
  try { store.importRoom(text); } catch (e) { threw = true; }
  ok(threw, '损坏文件被拒绝：' + label);
  ok(store.roomId === currentRoom, '拒绝后仍停在原房间：' + label);
  ok(Object.keys(store.state.elements).length === currentCount, '拒绝后当前画面未变：' + label);
});

// 10) 合法导入：进入文件中的房间，内容一致，且可撤销
const importedId = store.importRoom(exported);
ok(importedId === 'ROOM-C', '导入后进入导出房间');
ok(Object.keys(store.state.elements).length === 1, '导入内容正确');
ok(store.state.connections && true, '导入后结构正常');
ok(store.canUndo(), '导入可撤销');
store.undo();
ok(Object.keys(store.state.elements).length === currentCount, '撤销导入恢复导入前画面');

// 11) localStorage 中人为塞入损坏数据：加载时清洗悬空连线，不崩溃
const dirty = {
  state: {
    elements: [
      { id: 'ok', kind: 'rect', x: 1, y: 2 },
      { id: 'bad-kind', kind: 'ufo', x: 1, y: 2 },
      { id: 'bad-xy', kind: 'rect', x: 'oops', y: 2 }
    ],
    connections: [
      { id: 'c1', from: 'ok', to: 'ghost' },
      { id: 'c2', from: 'ok', to: 'ok' },
      { id: 'c3', from: 'ok', to: 'ok' }
    ]
  },
  undoStack: 'garbage',
  redoStack: []
};
sandbox.localStorage.setItem('canvas-room:v1:room:DIRTY', JSON.stringify(dirty));
const store3 = new RoomStore(sandbox.localStorage);
store3.init('DIRTY');
ok(Object.keys(store3.state.elements).length === 1, '损坏元素被清洗，只留合法元素');
ok(Object.keys(store3.state.connections).length === 0, '悬空/自连连线被清洗');
ok(store3.canUndo() === false, '损坏栈被安全降级');

// 12) 房间号校验
let roomErr = false;
try { sandbox.WB.normalizeRoomId(''); } catch (e) { roomErr = true; }
ok(roomErr, '空房间号被拒绝');
ok(sandbox.WB.normalizeRoomId('  中文-42_A ') === '中文-42_A', '合法房间号（含中文/去空格）');

// 13) 撤销栈不随拖动式重复操作无限增长 —— record 清空 redo
store3.switchRoom('LIMIT');
for (let i = 0; i < 60; i++) {
  doRecord(store3, () => store3.addElement('rect', i, i));
}
ok(store3.canUndo() && true, '60 步操作后仍可用');
const rawRec = JSON.parse(sandbox.localStorage.getItem('canvas-room:v1:room:LIMIT'));
ok(rawRec.undoStack.length === 50, '撤销栈上限 50，避免撑爆离线存储');
ok(rawRec.redoStack.length === 0, '新操作后重做栈清空');

console.log('ALL TESTS PASSED: ' + passed + ' assertions');

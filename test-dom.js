// DOM 冒烟测试（jsdom）：node test-dom.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/node_modules/jsdom');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost/index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
const { document } = window;

// localStorage polyfill
const ls = (() => { let s = {}; return {
  getItem: k => (k in s ? s[k] : null),
  setItem: (k, v) => { s[k] = String(v); },
  removeItem: k => { delete s[k]; }
}; })();
Object.defineProperty(window, 'localStorage', { value: ls });

window.HTMLElement.prototype.scrollIntoView = function () {};

// jsdom 未实现 PointerEvent / DataTransfer，用 MouseEvent 与手工对象打桩
if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends window.MouseEvent {
    constructor(type, init) { super(type, init); Object.assign(this, init || {}); }
  };
}
class FakeDataTransfer {
  constructor() { this.files = []; this.items = { add: f => this.files.push(f) }; }
}
window.DataTransfer = FakeDataTransfer;

const rulesCode = fs.readFileSync(path.join(__dirname, 'rules.js'), 'utf8');
const appCode = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
window.eval(rulesCode);
window.eval(appCode);

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const nodes = () => $$('#board .object');
const edgePaths = () => $$('#edgeLines .edge-g');

function dispatch(el, type, opts) {
  el.dispatchEvent(new window.Event(type, Object.assign({ bubbles: true, cancelable: true }, opts)));
}
function pointer(el, type, cx, cy) {
  el.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
}

// jsdom 不做布局：getBoundingClientRect 给板子和元素手工打桩
const board = $('#board');
board.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 650, right: 1200, bottom: 650 });
Object.defineProperty(board, 'clientWidth', { value: 1200, configurable: true });
Object.defineProperty(board, 'clientHeight', { value: 650, configurable: true });

// 1. 种子渲染
ok(nodes().length === 5, '5 elements rendered, got ' + nodes().length);
ok(edgePaths().length === 1, '1 edge rendered');
ok($('#roomInput').value === 'SPRINT_42', 'room input shows seed room');
ok($('#undo').disabled === true, 'undo disabled initially');
ok($('#roomStat').textContent.indexOf('5 个元素') > -1, 'room stat text');

// 2. 元素矩形打桩 + 拖动元素，连线端点跟随
function stubRects() {
  nodes().forEach(n => {
    const x = parseFloat(n.style.left), y = parseFloat(n.style.top);
    n.getBoundingClientRect = () => ({ left: x, top: y, width: 110, height: 60, right: x + 110, bottom: y + 60 });
  });
}
stubRects();
const edgeG = edgePaths()[0];
const edgeBefore = edgeG.querySelector('.edge-line').getAttribute('d');
const noteNode = nodes()[0];
const startLeft = parseFloat(noteNode.style.left);
pointer(noteNode, 'pointerdown', startLeft + 100, 100);
pointer(window, 'pointermove', startLeft + 160, 140);
pointer(window, 'pointerup', startLeft + 160, 140);
ok(parseFloat(noteNode.style.left) === startLeft + 60, 'element moved 60px');
const edgeAfter = edgeG.querySelector('.edge-line').getAttribute('d');
ok(edgeAfter !== edgeBefore, 'edge path updated with endpoint move');
ok($('#undo').disabled === false, 'move pushed undo entry');

// 3. 撤销拖动恢复位置和连线
$('#undo').click();
ok(parseFloat(nodes()[0].style.left) === startLeft, 'undo restores position');
$('#redo').click();
ok(parseFloat(nodes()[0].style.left) === startLeft + 60, 'redo moves again');
$('#undo').click();

// 4. 画布点击放置元素
$$('.tool').find(b => b.dataset.type === 'rect').click();
const boardRect = board.getBoundingClientRect();
board.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 300, clientY: 300 }));
ok(nodes().length === 6, 'rect added by canvas click: ' + nodes().length);
const newRect = nodes()[5];
ok(newRect.classList.contains('shape'), 'new node is shape');

// 5. 删除元素连带删线（选种子便签里的连线端点）
const db1 = JSON.parse(window.localStorage.getItem('canvas-room/db/v1'));
const room = db1.rooms.SPRINT_42;
const edgeId = Object.keys(room.present.edges)[0];
const endpointId = room.present.edges[edgeId].from;
const endpointNode = nodes().find(n => n.dataset.id === endpointId);
ok(endpointNode, 'found endpoint node in DOM');
pointer(endpointNode, 'pointerdown', 0, 0); pointer(endpointNode, 'pointerup', 0, 0); // 选中（未移动，不入栈）
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
ok(edgePaths().length === 0, 'edge DOM removed when endpoint deleted');
ok(!JSON.parse(window.localStorage.getItem('canvas-room/db/v1')).rooms.SPRINT_42.present.edges[edgeId], 'edge data removed');
ok(nodes().length === 5, 'element removed from DOM');

// 撤销删除恢复线和元素
$('#undo').click();
ok(edgePaths().length === 1, 'undo restores edge');
ok(nodes().length === 6, 'undo restores element');

// 6. 双击编辑
stubRects();
const note = nodes().find(n => n.classList.contains('note'));
note.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
const editor = $('.editor');
ok(!!editor, 'textarea editor opens');
editor.value = '改后的标题\n第二行';
editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
ok(!$('.editor'), 'editor closes on Enter');
const noteAfter = nodes().find(n => n.classList.contains('note') && n.textContent.indexOf('改后的标题') === 0);
ok(!!noteAfter, 'note text updated');

// 7. 连线工具：点两个元素建线
$$('.tool').find(b => b.dataset.type === 'line').click();
const two = nodes().slice(0, 2);
dispatch(two[0], 'click');
ok(two[0].classList.contains('pending'), 'first endpoint marked pending');
dispatch(two[1], 'click');
ok(edgePaths().length === 2 || true, 'second click attempts edge; count=' + edgePaths().length);
const dbNow = JSON.parse(window.localStorage.getItem('canvas-room/db/v1')).rooms.SPRINT_42;
ok(Object.keys(dbNow.present.edges).length === 2, 'second edge created in data');
ok(edgePaths().length === 2, 'second edge rendered');
// 重复连同一对
$$('.tool').find(b => b.dataset.type === 'line').click();
dispatch(two[0], 'click'); dispatch(two[1], 'click');
ok(Object.keys(JSON.parse(window.localStorage.getItem('canvas-room/db/v1')).rooms.SPRINT_42.present.edges).length === 2, 'duplicate edge not created');

// 8. 房间切换隔离
$$('.tool').find(b => b.dataset.type === 'select').click();
$('#roomInput').value = 'ROOM-B';
$('#switchRoom').click();
ok(nodes().length === 0, 'room B board empty');
ok(edgePaths().length === 0, 'room B no edges');
ok($('#undo').disabled === true, 'room B has own empty undo stack');
$$('.tool').find(b => b.dataset.type === 'note').click();
board.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 200, clientY: 200 }));
ok(nodes().length === 1, 'added element in room B');
$('#roomInput').value = 'SPRINT_42';
$('#switchRoom').click();
ok(nodes().length === 6, 'back to room A still has its 6 elements, count=' + nodes().length);

// 9. 清空房间可撤销
const countA = nodes().length;
window.confirm = () => true;
$('#clear').click();
ok(nodes().length === 0 && edgePaths().length === 0, 'clear empties board');
$('#undo').click();
ok(nodes().length === countA, 'undo clear restores ' + countA + ' nodes, got ' + nodes().length);
ok(edgePaths().length === 2, 'undo clear restores edges');

// 10. 导出/导入往返（不覆盖当前画面的校验）
window.URL.createObjectURL = () => 'blob:x';
window.URL.revokeObjectURL = () => {};
// 切到 B 导出
$('#roomInput').value = 'ROOM-B'; $('#switchRoom').click();
let exported;
const origCreate = document.createElement.bind(document);
document.createElement = tag => {
  const el = origCreate(tag);
  if (tag === 'a') el.click = function () { exported = el.href; };
  return el;
};
$('#exportBtn').click();
ok(!!exported, 'export created download');

// 构造损坏文件导入：画面不得变
const beforeHtml = board.querySelectorAll('.object').length;
const fileInput = $('#importFile');
function importText(text) {
  const file = new window.File([text], 'room.json', { type: 'application/json' });
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
}
// jsdom 的 FileReader 可用（pretendToBeVisual / 内置）
importText('{bad json');
setTimeout(() => {
  ok(board.querySelectorAll('.object').length === beforeHtml, 'corrupt text import leaves board unchanged, count=' + board.querySelectorAll('.object').length);

  // 合法导入：进 B（当前）的导出 + 改名 ROOM-C
  // 从 localStorage 直接组 bundle 不便，复用规则层：
  const bundle = JSON.parse(JSON.stringify({
    app: 'canvas-room', version: 1, room: 'ROOM-C',
    elements: [{ id: 'z1', type: 'circle', x: 1, y: 2 }],
    edges: []
  }));
  importText(JSON.stringify(bundle));
  setTimeout(() => {
    ok($('#roomInput').value === 'ROOM-C', 'switched to imported room');
    ok(board.querySelectorAll('.object').length === 1, 'imported content shown');
    // 悬空连线 bundle 被拒
    const badBundle = JSON.parse(JSON.stringify(bundle));
    badBundle.edges = [{ id: 'e1', from: 'z1', to: 'ghost' }];
    importText(JSON.stringify(badBundle));
    setTimeout(() => {
      ok($('#roomInput').value === 'ROOM-C', 'dangling-edge import rejected, room unchanged');
      ok(board.querySelectorAll('.object').length === 1, 'board unchanged after bad import');

      // 11. 刷新恢复：新 JSDOM + 同一 localStorage
      const dom2 = new JSDOM(html, { url: 'http://localhost/index.html?room=ROOM-C', runScripts: 'outside-only', pretendToBeVisual: true });
      Object.defineProperty(dom2.window, 'localStorage', { value: ls });
      dom2.window.HTMLElement.prototype.scrollIntoView = function () {};
      dom2.window.eval(rulesCode);
      dom2.window.eval(appCode);
      ok(dom2.window.document.getElementById('roomInput').value === 'ROOM-C', 'reload restores last room');
      ok(dom2.window.document.querySelectorAll('#board .object').length === 1, 'reload restores elements');
      ok(dom2.window.document.getElementById('undo').disabled === false, 'undo stack survives reload');

      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    }, 50);
  }, 50);
}, 50);

/* app.js — 页面逻辑层
 * 只负责渲染与交互；数据规则（房间隔离、撤销重做、持久化、导入校验）全部调用 rules.js。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'canvas-room/db/v1';
  var storage = {
    read: function () {
      try { return window.localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
    },
    write: function (text) {
      try { window.localStorage.setItem(STORAGE_KEY, text); return true; } catch (e) { return false; }
    }
  };
  var store = WhiteboardRules.createStore(storage);

  var board = document.getElementById('board');
  var edgeLines = document.getElementById('edgeLines');
  var roomInput = document.getElementById('roomInput');
  var syncEl = document.getElementById('sync');
  var roomStat = document.getElementById('roomStat');
  var activityEl = document.getElementById('activity');
  var toastEl = document.getElementById('toast');

  var tool = 'note', color = 'yellow', filter = 'all';
  var selected = null;        // {kind:'element'|'edge', id}
  var pendingFrom = null;     // 连线模式下已点击的第一个元素
  var nodeEls = {};           // elementId -> 元素 DOM
  var edgeEls = {};           // edgeId -> <g>
  var feed = {};              // 房间号 -> [{text, at}]，按房间隔离的动态记录
  var toastTimer = null;

  var TYPE_NAMES = { note: '便签', text: '文本', rect: '矩形', circle: '圆形' };

  /* ---------------- 提示 ---------------- */
  function notify(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, 2000);
  }

  function record(text) {
    var rid = store.roomId();
    if (!feed[rid]) feed[rid] = [];
    feed[rid].unshift({ text: text, at: Date.now() });
    if (feed[rid].length > 30) feed[rid].length = 30;
    renderFeed();
  }
  function timeAgo(t) {
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 10) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  function renderFeed() {
    var items = feed[store.roomId()] || [];
    if (!items.length) {
      activityEl.innerHTML = '<div class="event muted">暂无操作</div>';
      return;
    }
    activityEl.innerHTML = items.slice(0, 8).map(function (it) {
      return '<div class="event">' + escapeHtml(it.text) + '<br><small>' + timeAgo(it.at) + '</small></div>';
    }).join('');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- 渲染 ---------------- */
  function renderAll() {
    var p = store.present();
    nodeEls = {};
    edgeEls = {};
    board.querySelectorAll('.object').forEach(function (n) { n.remove(); });
    edgeLines.innerHTML = '';

    Object.keys(p.elements).forEach(function (id) {
      var el = p.elements[id];
      var node = document.createElement('div');
      node.dataset.id = id;
      node.className = 'object ' + nodeClass(el);
      node.style.left = el.x + 'px';
      node.style.top = el.y + 'px';
      if (el.w) node.style.width = el.w + 'px';
      if (el.h) node.style.height = el.h + 'px';
      if (el.type === 'note' || el.type === 'text') node.textContent = el.text || '';
      board.appendChild(node);
      nodeEls[id] = node;
      bindObjectNode(node, id);
    });

    Object.keys(p.edges).forEach(function (id) {
      var edge = p.edges[id];
      var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.dataset.id = id;
      g.classList.add('edge-g');
      var hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('class', 'edge-hit');
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('class', 'edge-line');
      line.setAttribute('marker-end', 'url(#arrow)');
      g.appendChild(hit);
      g.appendChild(line);
      edgeLines.appendChild(g);
      edgeEls[id] = g;
      g.addEventListener('click', function () { setSelected({ kind: 'edge', id: id }); });
    });

    // 选中项若已不存在则清掉
    if (selected) {
      var exists = selected.kind === 'element' ? nodeEls[selected.id] : edgeEls[selected.id];
      if (!exists) selected = null;
    }
    syncSelection();
    syncAllEdges();
    applyFilter();
    updateChrome();
  }

  function nodeClass(el) {
    if (el.type === 'note') return 'note ' + el.color;
    if (el.type === 'text') return 'label';
    if (el.type === 'circle') return 'shape circle';
    return 'shape';
  }

  function updateChrome() {
    document.getElementById('undo').disabled = !store.canUndo();
    document.getElementById('redo').disabled = !store.canRedo();
    var p = store.present();
    roomStat.textContent = '房间 ' + store.roomId() + ' · ' +
      Object.keys(p.elements).length + ' 个元素 · ' + Object.keys(p.edges).length + ' 条连线';
    roomInput.value = store.roomId();
    syncEl.textContent = '● 已保存';
    syncEl.className = 'sync';
  }

  function setSelected(sel) {
    selected = sel;
    syncSelection();
  }
  function syncSelection() {
    Object.keys(nodeEls).forEach(function (id) {
      nodeEls[id].classList.toggle('selected', !!(selected && selected.kind === 'element' && selected.id === id));
      nodeEls[id].classList.toggle('pending', pendingFrom === id);
    });
    Object.keys(edgeEls).forEach(function (id) {
      edgeEls[id].classList.toggle('selected', !!(selected && selected.kind === 'edge' && selected.id === id));
      var line = edgeEls[id].querySelector('.edge-line');
      if (line) line.setAttribute('marker-end', selected && selected.kind === 'edge' && selected.id === id ? 'url(#arrow-active)' : 'url(#arrow)');
    });
  }

  /* ---------------- 筛选（仅影响显示，不动数据） ---------------- */
  function applyFilter() {
    var p = store.present();
    Object.keys(p.elements).forEach(function (id) {
      var el = p.elements[id];
      var node = nodeEls[id];
      if (!node) return;
      node.style.display = (filter === 'all' || el.type !== 'note' || el.color === filter) ? '' : 'none';
    });
    Object.keys(p.edges).forEach(function (id) {
      var edge = p.edges[id];
      var a = nodeEls[edge.from], b = nodeEls[edge.to];
      edgeEls[id].style.display = (a && b && a.style.display !== 'none' && b.style.display !== 'none') ? '' : 'none';
    });
  }

  /* ---------------- 连线几何：端点移动时实时同步 ---------------- */
  function boardPoint(node) {
    var br = board.getBoundingClientRect();
    var nr = node.getBoundingClientRect();
    return { x: nr.left - br.left, y: nr.top - br.top, w: nr.width, h: nr.height };
  }
  // 求从 A 矩形中心射向 B 中心、与 A 边界的交点
  function borderPoint(a, b) {
    var cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    var tx = b.x + b.w / 2, ty = b.y + b.h / 2;
    var dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    var hw = a.w / 2, hh = a.h / 2;
    var scale;
    if (dx === 0) scale = hh / Math.abs(dy);
    else if (dy === 0) scale = hw / Math.abs(dx);
    else scale = Math.min(hw / Math.abs(dx), hh / Math.abs(dy));
    return { x: cx + dx * scale, y: cy + dy * scale };
  }
  function syncEdge(id) {
    var p = store.present();
    var edge = p.edges[id];
    var g = edgeEls[id];
    if (!edge || !g) return;
    var na = nodeEls[edge.from], nb = nodeEls[edge.to];
    // 端点消失：规则层已负责清理数据，这里同步清理残留视图
    if (!na || !nb) { g.remove(); delete edgeEls[id]; return; }
    var a = boardPoint(na), b = boardPoint(nb);
    var p1 = borderPoint(a, b), p2 = borderPoint(b, a);
    var d = 'M' + p1.x + ',' + p1.y + ' L' + p2.x + ',' + p2.y;
    g.querySelectorAll('path').forEach(function (path) { path.setAttribute('d', d); });
  }
  function syncAllEdges() { Object.keys(edgeEls).forEach(syncEdge); }

  /* ---------------- 元素交互 ---------------- */
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function bindObjectNode(node, id) {
    // 拖动（连线工具下拖动不生效，改用点击连端点）
    node.addEventListener('pointerdown', function (e) {
      if (tool === 'line' || e.button !== 0) return;
      var el = store.element(id);
      if (!el) return;
      e.preventDefault();
      setSelected({ kind: 'element', id: id });
      store.begin();
      var startX = e.clientX, startY = e.clientY;
      var ox = el.x, oy = el.y, moved = false;

      function move(ev) {
        var dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 3) return;
        moved = true;
        var nx = clamp(Math.round(ox + dx), 0, board.clientWidth - 40);
        var ny = clamp(Math.round(oy + dy), 0, board.clientHeight - 20);
        store.preview(function (p) {
          p.elements[id].x = nx;
          p.elements[id].y = ny;
        });
        node.style.left = nx + 'px';
        node.style.top = ny + 'px';
        syncAllEdges();
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (moved) {
          if (store.commit(function () {}, { action: 'move' })) record('你移动了「' + describe(id) + '」');
        } else {
          store.cancel();
        }
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // 连线工具：点击元素选端点
    node.addEventListener('click', function () {
      if (tool !== 'line') return;
      if (!pendingFrom) {
        pendingFrom = id;
        syncSelection();
        notify('再点击一个元素完成连线');
      } else if (pendingFrom === id) {
        pendingFrom = null;
        syncSelection();
        notify('已取消连线');
      } else {
        var res = store.addEdge(pendingFrom, id);
        if (res.ok) {
          record('你连接了「' + describe(pendingFrom) + '」和「' + describe(id) + '」');
          notify('连线已建立');
        } else if (res.reason === 'duplicate') {
          notify('两个元素之间已有连线');
        } else {
          notify('连线失败：端点不存在', true);
        }
        pendingFrom = null;
      }
    });

    // 双击编辑
    node.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      if (tool === 'line') return;
      var el = store.element(id);
      if (el && (el.type === 'note' || el.type === 'text')) startEdit(id);
    });
  }

  function describe(id) {
    var el = store.element(id);
    if (!el) return '已删除元素';
    if (el.type === 'note' || el.type === 'text') {
      var first = (el.text || '').split('\n')[0].trim();
      return first || TYPE_NAMES[el.type];
    }
    return TYPE_NAMES[el.type];
  }

  /* ---------------- 内联编辑 ---------------- */
  function startEdit(id) {
    var el = store.element(id);
    var node = nodeEls[id];
    if (!el || !node) return;
    var editor = document.createElement('textarea');
    editor.className = 'editor' + (el.type === 'text' ? ' label-editor' : ' ' + el.color);
    editor.value = el.text || '';
    var rect = node.getBoundingClientRect();
    var br = board.getBoundingClientRect();
    editor.style.left = (rect.left - br.left) + 'px';
    editor.style.top = (rect.top - br.top) + 'px';
    editor.style.width = rect.width + 'px';
    editor.style.height = rect.height + 'px';
    board.appendChild(editor);
    editor.focus();
    editor.select();
    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      if (commit && editor.value !== el.text) {
        if (store.editElement(id, editor.value)) record('你编辑了「' + (editor.value.split('\n')[0] || TYPE_NAMES[el.type]) + '」');
      }
      editor.remove();
    }
    editor.addEventListener('blur', function () { finish(true); });
    editor.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
  }

  /* ---------------- 画布点击：放置新元素 ---------------- */
  board.addEventListener('click', function (e) {
    if (e.target !== board) return;
    if (tool === 'select' || tool === 'line') {
      if (tool === 'line' && pendingFrom) { pendingFrom = null; syncSelection(); notify('已取消连线'); }
      if (tool === 'select') setSelected(null);
      return;
    }
    var br = board.getBoundingClientRect();
    var x = Math.round(e.clientX - br.left);
    var y = Math.round(e.clientY - br.top);
    var id = store.addElement(tool, x, y, color);
    setSelected({ kind: 'element', id: id });
    notify('已在房间 ' + store.roomId() + ' 添加' + TYPE_NAMES[tool]);
  });

  /* ---------------- 删除（连同关联连线一起进入撤销栈） ---------------- */
  function deleteSelected() {
    if (!selected) return;
    if (selected.kind === 'element') {
      var id = selected.id;
      var incident = store.incidentEdges(id).length;
      var name = describe(id);
      if (store.removeElement(id)) {
        record('你删除了「' + name + '」' + (incident ? '，并清理了 ' + incident + ' 条连线' : ''));
        notify(incident ? '元素及 ' + incident + ' 条关联连线已删除' : '元素已删除');
        selected = null;
      }
    } else {
      if (store.removeEdge(selected.id)) {
        record('你删除了一条连线');
        notify('连线已删除');
        selected = null;
      }
    }
  }

  /* ---------------- 工具栏 / 快捷键 ---------------- */
  document.querySelectorAll('.tool').forEach(function (b) {
    b.addEventListener('click', function () {
      tool = b.dataset.type;
      pendingFrom = null;
      document.querySelectorAll('.tool').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      board.className = tool === 'line' ? 'tool-line' : (tool === 'select' ? 'tool-select' : '');
      syncSelection();
    });
  });
  document.querySelectorAll('.color button').forEach(function (b) {
    b.addEventListener('click', function () {
      color = b.dataset.c;
      document.querySelectorAll('.color button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
    });
  });
  document.querySelectorAll('[data-filter]').forEach(function (b) {
    b.addEventListener('click', function () {
      filter = b.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      applyFilter();
    });
  });

  document.getElementById('undo').addEventListener('click', doUndo);
  document.getElementById('redo').addEventListener('click', doRedo);
  function doUndo() { if (store.undo()) { record('撤销了上一步操作'); notify('已撤销'); } }
  function doRedo() { if (store.redo()) { record('重做了一步操作'); notify('已重做'); } }

  document.getElementById('clear').addEventListener('click', function () {
    var p = store.present();
    if (!Object.keys(p.elements).length) { notify('当前房间已经是空的'); return; }
    if (window.confirm('确定清空房间 ' + store.roomId() + ' 的全部内容吗？此操作可以撤销。')) {
      if (store.clearRoom()) {
        selected = null; pendingFrom = null;
        record('你清空了房间');
        notify('房间已清空，可撤销恢复');
      }
    }
  });

  window.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault(); doRedo();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selected) { e.preventDefault(); deleteSelected(); }
    } else if (e.key === 'Escape' && pendingFrom) {
      pendingFrom = null; syncSelection(); notify('已取消连线');
    }
  });

  /* ---------------- 房间切换（只显示本房间元素） ---------------- */
  function switchRoom(id) {
    if (!WhiteboardRules.roomIdValid(id)) {
      notify('房间号只能使用 1–32 位字母、数字、下划线或短横线', true);
      roomInput.value = store.roomId();
      return;
    }
    if (id === store.roomId()) return;
    store.switchRoom(id);
  }
  document.getElementById('switchRoom').addEventListener('click', function () {
    switchRoom(roomInput.value.trim());
  });
  roomInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') switchRoom(roomInput.value.trim());
  });

  document.getElementById('copy').addEventListener('click', function () {
    var url = location.origin + location.pathname + '?room=' + encodeURIComponent(store.roomId());
    function done() { notify('房间链接已复制：' + store.roomId()); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { window.prompt('复制此房间链接：', url); });
    } else {
      window.prompt('复制此房间链接：', url);
    }
  });

  /* ---------------- 导出 / 导入 ---------------- */
  document.getElementById('exportBtn').addEventListener('click', function () {
    var bundle = store.exportBundle();
    var blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'canvas-room-' + bundle.room + '-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    notify('已导出房间 ' + bundle.room);
  });

  var fileInput = document.getElementById('importFile');
  document.getElementById('importBtn').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); }
      catch (e) { notify('导入失败：文件不是合法 JSON，当前画面未改动', true); fileInput.value = ''; return; }
      var res = store.importBundle(data);
      fileInput.value = '';
      if (res.ok) {
        selected = null; pendingFrom = null;
        history.replaceState(null, '', location.pathname + '?room=' + encodeURIComponent(res.roomId));
        record('导入了房间备份：' + res.roomId);
        notify('已导入房间 ' + res.roomId + '（可撤销）');
      } else {
        notify('导入失败：' + res.error + '，当前画面未改动', true);
      }
    };
    reader.onerror = function () { notify('读取文件失败，当前画面未改动', true); fileInput.value = ''; };
    reader.readAsText(file);
  });

  /* ---------------- 存储事件 / 房间切换 ---------------- */
  store.subscribe(function (ev) {
    if (ev.saveError) {
      syncEl.textContent = '● 本地保存失败（存储不可用）';
      syncEl.className = 'sync warn';
    }
    if (ev.phase === 'preview') return; // 拖动过程中已做局部更新
    if (ev.phase === 'room') {
      selected = null; pendingFrom = null;
      renderAll();
      renderFeed();
      history.replaceState(null, '', location.pathname + '?room=' + encodeURIComponent(store.roomId()));
      notify('已进入房间 ' + store.roomId());
      return;
    }
    renderAll();
    if (ev.phase === 'commit' && ev.meta.action === 'add') {
      var p = store.present();
      var ids = Object.keys(p.elements);
      var newest = ids[ids.length - 1];
      if (newest) setSelected({ kind: 'element', id: newest });
      record('你添加了一个' + TYPE_NAMES[ev.meta.type]);
    }
    if (ev.phase === 'connect') {} // addEdge 的动态在调用处记录
  });

  window.addEventListener('resize', syncAllEdges);

  /* ---------------- 启动：URL 指定房间 + 恢复最近状态 ---------------- */
  (function boot() {
    var match = /[?&]room=([^&]+)/.exec(location.search);
    var urlRoom = match ? decodeURIComponent(match[1]) : null;
    if (urlRoom && WhiteboardRules.roomIdValid(urlRoom) && urlRoom !== store.roomId()) {
      store.switchRoom(urlRoom);
    }
    renderAll();
    renderFeed();
    if (store.wasCorruptOnBoot()) {
      notify('本地数据有损坏，已自动清理无效内容', true);
    }
  })();
})();

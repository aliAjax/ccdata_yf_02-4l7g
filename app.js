/*
 * Canvas Room —— 页面逻辑层
 * 只负责把规则层（window.WB.RoomStore）的状态渲染到页面并转发用户手势；
 * 数据隔离、撤销栈、连线完整性与持久化规则都在 rules.js。
 */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var store = new WB.RoomStore();
  var params = new URLSearchParams(location.search);
  try {
    store.init(params.get('room') || '');
  } catch (err) {
    store.init(''); // URL 里房间号非法时回到默认房间，不让页面白屏
  }

  var board = $('#board');
  var svg = $('#linkLayer');
  var objectsLayer = $('#objects');
  var toastEl = $('#toast');
  var roomInput = $('#roomInput');
  var roomIdEl = $('#roomId');
  var syncEl = $('#sync');
  var countsEl = $('#counts');
  var undoBtn = $('#undo');
  var redoBtn = $('#redo');
  var importInput = $('#importFile');

  var tool = 'note';
  var color = 'yellow';
  var filter = 'all';
  var selectedEl = null;      // 选中的元素 id
  var selectedConn = null;    // 选中的连线 id
  var pendingSource = null;   // 连线工具：等待选择目标元素的源 id
  var metricsCache = {};      // 元素中心点缓存（被筛选隐藏时仍可定位）
  var toastTimer = null;
  var saveTimer = null;

  function notify(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2000);
  }

  function flashSaved() {
    syncEl.textContent = '● 保存中…';
    syncEl.style.color = 'var(--muted)';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      syncEl.textContent = '● 已本地保存';
      syncEl.style.color = '#44a57b';
    }, 250);
  }

  /* ---------------- 渲染 ---------------- */

  function boardPoint(e) {
    var r = board.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function render() {
    // 选中项可能因撤销/导入已不存在
    if (selectedEl && !store.state.elements[selectedEl]) selectedEl = null;
    if (selectedConn && !store.state.connections[selectedConn]) selectedConn = null;
    if (pendingSource && !store.state.elements[pendingSource]) pendingSource = null;

    objectsLayer.innerHTML = '';
    Object.keys(store.state.elements).forEach(function (id) {
      objectsLayer.appendChild(renderElement(store.state.elements[id]));
    });
    renderLinks(null);
    updateChrome();
  }

  function renderElement(el) {
    var node = document.createElement('div');
    var cls = 'object';
    if (el.kind === 'note') cls += ' note ' + (el.color || 'yellow');
    else if (el.kind === 'text') cls += ' label';
    else if (el.kind === 'rect') cls += ' shape';
    else if (el.kind === 'circle') cls += ' shape circle';
    if (el.id === selectedEl) cls += ' selected';
    if (el.id === pendingSource) cls += ' relink-source';
    node.className = cls;
    node.dataset.id = el.id;
    node.style.left = el.x + 'px';
    node.style.top = el.y + 'px';

    if (el.kind === 'note') {
      var parts = (el.text || '').split('\n');
      var head = document.createElement('div');
      head.textContent = parts[0] || ' ';
      node.appendChild(head);
      if (parts.length > 1) {
        var sub = document.createElement('small');
        sub.textContent = parts.slice(1).join('\n');
        node.appendChild(sub);
      }
    } else if (el.kind === 'text') {
      node.textContent = el.text || '';
    }
    if (filter !== 'all' && el.kind === 'note' && (el.color || 'yellow') !== filter) {
      node.style.display = 'none';
    }
    return node;
  }

  function svgEl(tag, attrs) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  /* 读取元素当前中心坐标；连线渲染始终以此为准，拖动时天然同步 */
  function centerOf(id) {
    var el = store.state.elements[id];
    var node = objectsLayer.querySelector('[data-id="' + id + '"]');
    if (node && node.offsetParent !== null) {
      var w = node.offsetWidth, h = node.offsetHeight;
      metricsCache[id] = { w: w, h: h };
      return { x: el.x + w / 2, y: el.y + h / 2, w: w, h: h };
    }
    var cached = metricsCache[id] || { w: 100, h: 60 };
    return { x: el.x + cached.w / 2, y: el.y + cached.h / 2, w: cached.w, h: cached.h };
  }

  function renderLinks(temp) {
    var bw = board.clientWidth, bh = board.clientHeight;
    svg.setAttribute('viewBox', '0 0 ' + bw + ' ' + bh);
    svg.setAttribute('width', bw);
    svg.setAttribute('height', bh);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var defs = svgEl('defs', {});
    var marker = svgEl('marker', {
      id: 'arrow', markerWidth: 10, markerHeight: 10,
      refX: 8, refY: 3, orient: 'auto', markerUnits: 'strokeWidth'
    });
    marker.appendChild(svgEl('path', { d: 'M0,0 L8,3 L0,6 Z', fill: '#667484', 'pointer-events': 'none' }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    Object.keys(store.state.connections).forEach(function (id) {
      var c = store.state.connections[id];
      if (!store.state.elements[c.from] || !store.state.elements[c.to]) return; // 双保险：不画悬空线
      var a = centerOf(c.from), b = centerOf(c.to);
      var g = svgEl('g', { 'data-cid': id });
      g.appendChild(svgEl('line', {
        class: 'link-hit', 'data-cid': id, x1: a.x, y1: a.y, x2: b.x, y2: b.y
      }));
      var line = svgEl('line', {
        class: 'link-line' + (id === selectedConn ? ' selected' : ''),
        x1: a.x, y1: a.y, x2: b.x, y2: b.y
      });
      if (id !== selectedConn) line.setAttribute('marker-end', 'url(#arrow)');
      g.appendChild(line);
      svg.appendChild(g);

      if (id === selectedConn) {
        [['from', a], ['to', b]].forEach(function (pair) {
          var knob = svgEl('circle', {
            class: 'link-knob', cx: pair[1].x, cy: pair[1].y, r: 6,
            'data-cid': id, 'data-end': pair[0]
          });
          svg.appendChild(knob);
        });
      }
    });

    if (temp) {
      svg.appendChild(svgEl('line', {
        class: 'link-temp', x1: temp.x1, y1: temp.y1, x2: temp.x2, y2: temp.y2
      }));
    }
  }

  function updateChrome() {
    roomIdEl.textContent = store.roomId;
    roomInput.value = store.roomId;
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
    var n = Object.keys(store.state.elements).length;
    var m = Object.keys(store.state.connections).length;
    countsEl.textContent = n + ' 个元素 · ' + m + ' 条连线 · 房间数据相互隔离';
    var want = '?room=' + encodeURIComponent(store.roomId);
    if (location.search !== want) {
      history.replaceState(null, '', want);
    }
  }

  /* 提交一次进入撤销栈的操作：先快照、执行变更、入栈并重绘 */
  function commit(fn) {
    var before = store.snapshot();
    var ret = fn();
    store.record(before);
    flashSaved();
    render();
    return ret;
  }

  /* ---------------- 画布手势 ---------------- */

  board.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();

    var start = { x: e.clientX, y: e.clientY };
    var p0 = boardPoint(e);
    var moved = false;

    // 1) 拖动选中连线的端点 → 改线
    var knob = e.target.closest && e.target.closest('.link-knob');
    if (knob) {
      startRelink(knob.dataset.cid, knob.dataset.end, e);
      return;
    }

    var obj = e.target.closest && e.target.closest('.object');
    var hitNode = e.target.closest && e.target.closest('[data-cid]');
    var hit = hitNode && hitNode.tagName.toLowerCase() !== 'circle' && !obj;

    var move = null, up = null;

    if (obj && tool === 'link') {
      // 连线工具：在元素上按下，拖到另一个元素松手；不拖则进入“再点一个目标”模式
      var sourceId = obj.dataset.id;
      move = function (v) {
        var p = boardPoint(v);
        if (Math.abs(v.clientX - start.x) + Math.abs(v.clientY - start.y) > 4) moved = true;
        var c = centerOf(sourceId);
        renderLinks({ x1: c.x, y1: c.y, x2: p.x, y2: p.y });
      };
      up = function (v) {
        var targetNode = document.elementFromPoint(v.clientX, v.clientY);
        var target = targetNode && targetNode.closest && targetNode.closest('.object');
        var targetId = target ? target.dataset.id : null;
        if (targetId) {
          connectTo(sourceId, targetId);
        } else if (!moved) {
          if (pendingSource && pendingSource !== sourceId) {
            connectTo(pendingSource, sourceId);
          } else {
            pendingSource = sourceId;
            selectedConn = null;
            notify('再点击一个元素作为连线终点（Esc 取消）');
            render();
          }
        } else {
          notify('请在元素上松手');
          render();
        }
      };
    } else if (obj) {
      // 2) 拖动元素（端点随之移动）；未移动视为点选
      var id = obj.dataset.id;
      var before = store.snapshot();
      selectedEl = id;
      selectedConn = null;
      render();
      var node = objectsLayer.querySelector('[data-id="' + id + '"]');
      move = function (v) {
        if (Math.abs(v.clientX - start.x) + Math.abs(v.clientY - start.y) > 4) moved = true;
        var dx = v.clientX - start.x, dy = v.clientY - start.y;
        store.setPosition(id, store.state.elements[id].x + dx, store.state.elements[id].y + dy);
        start.x = v.clientX; start.y = v.clientY;
        node.style.left = store.state.elements[id].x + 'px';
        node.style.top = store.state.elements[id].y + 'px';
        renderLinks(null);
      };
      up = function () {
        if (moved) {
          store.record(before); // 整次拖动 = 一个撤销步骤
          flashSaved();
          render();
        }
      };
    } else if (hit) {
      // 3) 点选连线（粗透明命中带或可见线条均可）
      var cid = hitNode.dataset.cid;
      up = function () {
        if (!moved) {
          selectedConn = selectedConn === cid ? null : cid;
          selectedEl = null;
          render();
        }
      };
      move = function (v) {
        if (Math.abs(v.clientX - start.x) + Math.abs(v.clientY - start.y) > 4) moved = true;
      };
    } else {
      // 4) 画布空白：放置元素 / 取消连线 / 清除选择
      up = function () {
        if (moved) return;
        if (tool === 'select') {
          selectedEl = selectedConn = null;
          pendingSource = null;
          render();
        } else if (tool === 'link') {
          pendingSource = null;
          notify('已取消连线');
          render();
        } else {
          placeAt(p0);
        }
      };
      move = function (v) {
        if (Math.abs(v.clientX - start.x) + Math.abs(v.clientY - start.y) > 4) moved = true;
      };
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', function handler(v) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', handler);
      up(v);
    });
  });

  function startRelink(cid, end, e) {
    if (!store.state.connections[cid]) return;
    var before = store.snapshot();
    var start = { x: e.clientX, y: e.clientY };
    var otherEnd = end === 'from' ? 'to' : 'from';
    var anchor = centerOf(store.state.connections[cid][otherEnd]);

    // 高亮所有可作为新端点的元素
    $$('.object').forEach(function (n) { n.classList.add('relink-source'); });

    function move(v) {
      var p = boardPoint(v);
      renderLinks({ x1: anchor.x, y1: anchor.y, x2: p.x, y2: p.y });
    }
    function up(v) {
      $$('.object').forEach(function (n) { n.classList.remove('relink-source'); });
      var targetNode = document.elementFromPoint(v.clientX, v.clientY);
      var target = targetNode && targetNode.closest && targetNode.closest('.object');
      var targetId = target ? target.dataset.id : null;
      if (targetId && store.updateConnectionEnd(cid, end, targetId)) {
        store.record(before); // 改线也进入本房间撤销栈
        flashSaved();
        notify('连线端点已更新');
      } else {
        notify(targetId ? '目标无效（不能连到自己或与现有连线重复）' : '已取消改线');
      }
      render();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', function handler(v) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', handler);
      up(v);
    });
  }

  function connectTo(fromId, toId) {
    if (fromId === toId) {
      notify('不能连接同一个元素');
      render();
      return;
    }
    var conn = commit(function () { return store.addConnection(fromId, toId); });
    pendingSource = null;
    notify(conn ? '已连接两个元素' : '两个元素之间已存在连线');
  }

  function placeAt(p) {
    commit(function () {
      return store.addElement(tool, p.x - 45, p.y - 25, { color: color });
    });
    notify('已添加元素');
  }

  /* ---------------- 编辑与删除 ---------------- */

  board.addEventListener('dblclick', function (e) {
    var node = e.target.closest && e.target.closest('.object');
    if (!node) return;
    var el = store.state.elements[node.dataset.id];
    if (!el || (el.kind !== 'note' && el.kind !== 'text')) return;
    var value = prompt(el.kind === 'note' ? '编辑便签内容（换行即多行）' : '编辑文本', el.text || '');
    if (value === null) return;
    if (value === el.text) return;
    commit(function () { store.updateText(el.id, value); });
    notify('内容已更新');
  });

  window.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    var mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) store.redo(); else store.undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      store.redo();
      return;
    }
    if (e.key === 'Escape') {
      pendingSource = null;
      render();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedEl) {
        e.preventDefault();
        var id = selectedEl;
        commit(function () {
          store.deleteElement(id); // 绑定该元素的连线在同一事务内清理
        });
        selectedEl = null;
        notify('元素及其连线已删除');
      } else if (selectedConn) {
        e.preventDefault();
        var cid = selectedConn;
        commit(function () { store.deleteConnection(cid); });
        selectedConn = null;
        notify('连线已删除');
      }
    }
  });

  /* ---------------- 工具栏 ---------------- */

  $$('.tool').forEach(function (b) {
    b.addEventListener('click', function () {
      tool = b.dataset.type || 'select';
      pendingSource = null;
      $$('.tool').forEach(function (x) { x.classList.toggle('active', x === b); });
      board.dataset.tool = tool;
      render();
    });
  });
  $$('.color button').forEach(function (b) {
    b.addEventListener('click', function () {
      color = b.dataset.c;
      $$('.color button').forEach(function (x) { x.classList.toggle('active', x === b); });
    });
  });
  $$('[data-filter]').forEach(function (b) {
    b.addEventListener('click', function () {
      filter = b.dataset.filter;
      $$('[data-filter]').forEach(function (x) { x.classList.toggle('active', x === b); });
      render();
    });
  });

  /* ---------------- 房间切换 / 撤销重做 / 清除 ---------------- */

  function switchRoom() {
    var value = roomInput.value;
    try {
      store.switchRoom(value); // 房间号决定数据范围：元素与撤销栈整体替换
      selectedEl = selectedConn = pendingSource = null;
      notify('已进入房间 ' + store.roomId + '（空房间）');
      history.replaceState(null, '', '?room=' + encodeURIComponent(store.roomId));
    } catch (err) {
      notify(err.message);
      roomInput.value = store.roomId;
    }
  }
  $('#roomSwitch').addEventListener('click', switchRoom);
  roomInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') switchRoom(); });

  undoBtn.addEventListener('click', function () { store.undo(); });
  redoBtn.addEventListener('click', function () { store.redo(); });

  $('#clear').addEventListener('click', function () {
    if (!Object.keys(store.state.elements).length && !Object.keys(store.state.connections).length) {
      notify('当前房间已经是空画布');
      return;
    }
    if (!confirm('确定清空房间「' + store.roomId + '」的全部元素与连线？（可撤销）')) return;
    commit(function () { store.clearRoom(); });
    selectedEl = selectedConn = pendingSource = null;
    notify('房间已清空，可撤销恢复');
  });

  /* ---------------- 导出 / 导入 / 复制链接 ---------------- */

  $('#export').addEventListener('click', function () {
    var blob = new Blob([store.exportRoom()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'canvas-room-' + store.roomId + '-' +
      new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    notify('已导出房间「' + store.roomId + '」数据');
  });

  $('#import').addEventListener('click', function () { importInput.click(); });
  importInput.addEventListener('change', function () {
    var file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      // 严格校验通过前 store 不发生任何变化，损坏内容不会覆盖当前画面
      try {
        var id = store.importRoom(String(reader.result));
        selectedEl = selectedConn = pendingSource = null;
        history.replaceState(null, '', '?room=' + encodeURIComponent(id));
        notify('导入成功，已进入房间 ' + id + '（可撤销）');
      } catch (err) {
        notify('导入失败：' + err.message + '，当前画面未改动');
      }
    };
    reader.onerror = function () { notify('读取文件失败，当前画面未改动'); };
    reader.readAsText(file);
  });

  $('#copy').addEventListener('click', function () {
    var url = location.origin + location.pathname + '?room=' + encodeURIComponent(store.roomId);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        function () { notify('房间链接已复制：' + url); },
        function () { notify(url); }
      );
    } else {
      notify(url);
    }
  });

  /* ---------------- 初始化 ---------------- */

  store.subscribe(render); // 撤销/重做/导入后规则层直接触发重绘
  window.addEventListener('resize', function () {
    requestAnimationFrame(function () { renderLinks(null); });
  });

  board.dataset.tool = tool;
  syncEl.textContent = '● 已本地保存';
  render();
})();

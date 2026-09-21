/*
 * Canvas Room —— 规则层（与 DOM 无关）
 * 职责：房间数据隔离、每房间撤销/重做栈、连线完整性、离线持久化、导出与导入校验。
 * 页面逻辑通过 window.WB.RoomStore 使用本文件。
 */
(function (global) {
  'use strict';

  var PREFIX = 'canvas-room:v1:';
  var KEY_CURRENT = PREFIX + 'current';
  var STACK_LIMIT = 50;
  var COORD_LIMIT = 20000;
  var TEXT_LIMIT = 5000;
  var KINDS = { note: 1, text: 1, rect: 1, circle: 1 };
  var NOTE_COLORS = { yellow: 1, blue: 1, pink: 1 };
  var ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  var ROOM_RE = /^[A-Za-z0-9_一-龥-]{1,24}$/;

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function emptyState() { return { elements: {}, connections: {} }; }
  function asList(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return Object.keys(v).map(function (k) { return v[k]; });
    return [];
  }
  function finiteNumber(v) {
    return typeof v === 'number' && isFinite(v) && Math.abs(v) <= COORD_LIMIT;
  }

  /* 任意来源的状态都经过清洗：非法元素丢弃，端点缺失的连线一并清理，杜绝悬空关系 */
  function sanitizeState(raw) {
    var out = emptyState();
    if (!raw || typeof raw !== 'object') return out;
    asList(raw.elements).forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      if (typeof e.id !== 'string' || !ID_RE.test(e.id) || out.elements[e.id]) return;
      if (!KINDS[e.kind]) return;
      var x = Number(e.x), y = Number(e.y);
      if (!finiteNumber(x) || !finiteNumber(y)) return;
      var el = { id: e.id, kind: e.kind, x: Math.round(x), y: Math.round(y) };
      if (e.kind === 'note') el.color = NOTE_COLORS[e.color] ? e.color : 'yellow';
      if (e.kind === 'note' || e.kind === 'text') {
        var t = (typeof e.text === 'string') ? e.text.slice(0, TEXT_LIMIT) : '';
        el.text = t;
      }
      out.elements[el.id] = el;
    });
    var seenPairs = {};
    asList(raw.connections).forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      if (typeof c.id !== 'string' || !ID_RE.test(c.id) || out.connections[c.id]) return;
      if (typeof c.from !== 'string' || typeof c.to !== 'string') return;
      if (!out.elements[c.from] || !out.elements[c.to]) return; // 悬空连线直接清理
      if (c.from === c.to) return;
      var pair = [c.from, c.to].sort().join('|');
      if (seenPairs[pair]) return;
      seenPairs[pair] = 1;
      out.connections[c.id] = { id: c.id, from: c.from, to: c.to };
    });
    return out;
  }

  function normalizeRoomId(id) {
    if (typeof id !== 'string') id = String(id == null ? '' : id);
    id = id.trim();
    if (!ROOM_RE.test(id)) {
      throw new Error('房间号需为 1-24 位字母、数字、中文、下划线或短横线');
    }
    return id;
  }

  /* 首次打开时的示例房间 */
  function seedRecord() {
    var s = emptyState();
    function add(el) { s.elements[el.id] = el; }
    add({ id: 'el-seed-1', kind: 'note', x: 90, y: 80, color: 'yellow', text: '本周目标\n把首页流程走通' });
    add({ id: 'el-seed-2', kind: 'note', x: 330, y: 175, color: 'blue', text: '灵感池\n尝试更轻的导航' });
    add({ id: 'el-seed-3', kind: 'text', x: 590, y: 88, text: '下一步：验证原型' });
    add({ id: 'el-seed-4', kind: 'rect', x: 205, y: 350 });
    add({ id: 'el-seed-5', kind: 'circle', x: 475, y: 370 });
    s.connections['cn-seed-1'] = { id: 'cn-seed-1', from: 'el-seed-1', to: 'el-seed-2' };
    return { state: s, undoStack: [], redoStack: [] };
  }

  function createMemoryStorage() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  }
  function createStorage() {
    try {
      var s = global.localStorage;
      var probe = PREFIX + 'probe';
      s.setItem(probe, '1'); s.removeItem(probe);
      return s;
    } catch (e) {
      return createMemoryStorage(); // 本机存储不可用时退化为内存，仍可正常编辑
    }
  }

  function RoomStore(storage) {
    this.store = storage || createStorage();
    this.roomId = '';
    this.state = emptyState();
    this.undoStack = [];
    this.redoStack = [];
    this._listeners = [];
  }

  RoomStore.prototype = {
    /* ---------- 房间与持久化 ---------- */

    init: function (preferredId) {
      var id;
      if (preferredId) {
        id = normalizeRoomId(preferredId);
      } else {
        id = this._read(KEY_CURRENT);
        if (!id) {
          id = 'SPRINT-42';
          if (!this._readRecord(id)) this._writeRecord(id, seedRecord()); // 首次访问放示例
        }
        id = normalizeRoomId(id);
      }
      this._loadRoom(id);
    },

    switchRoom: function (id) {
      id = normalizeRoomId(id);
      if (id === this.roomId) return;
      this._loadRoom(id); // 房间号决定数据范围：直接换整套状态与撤销栈
      this._emit();
    },

    subscribe: function (fn) { this._listeners.push(fn); },
    _emit: function () { this._listeners.forEach(function (fn) { fn(); }); },

    _read: function (k) {
      try { return this.store.getItem(k); } catch (e) { return null; }
    },
    _write: function (k, v) {
      try { this.store.setItem(k, v); } catch (e) { /* 配额或隐私模式失败时忽略 */ }
    },
    _roomKey: function (id) { return PREFIX + 'room:' + id; },

    _readRecord: function (id) {
      var raw;
      try { raw = JSON.parse(this._read(this._roomKey(id)) || 'null'); }
      catch (e) { return null; }
      if (!raw || typeof raw !== 'object') return null;
      return {
        state: sanitizeState(raw.state),
        undoStack: asList(raw.undoStack).map(sanitizeState).slice(-STACK_LIMIT),
        redoStack: asList(raw.redoStack).map(sanitizeState).slice(-STACK_LIMIT)
      };
    },
    _writeRecord: function (id, rec) {
      this._write(this._roomKey(id), JSON.stringify(rec));
    },
    _loadRoom: function (id) {
      var rec = this._readRecord(id) || { state: emptyState(), undoStack: [], redoStack: [] };
      this.roomId = id;
      this.state = rec.state;
      this.undoStack = rec.undoStack;
      this.redoStack = rec.redoStack;
      this._write(KEY_CURRENT, id); // 刷新后停在最近房间
    },
    persist: function () {
      this._writeRecord(this.roomId, {
        state: this.state,
        undoStack: this.undoStack,
        redoStack: this.redoStack
      });
    },

    /* ---------- 撤销 / 重做（本房间独立栈） ---------- */

    snapshot: function () { return clone(this.state); },
    record: function (before) {
      this.undoStack.push(before);
      if (this.undoStack.length > STACK_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      this.persist();
    },
    canUndo: function () { return this.undoStack.length > 0; },
    canRedo: function () { return this.redoStack.length > 0; },
    undo: function () {
      if (!this.canUndo()) return false;
      this.redoStack.push(clone(this.state));
      this.state = this.undoStack.pop();
      this.persist();
      this._emit();
      return true;
    },
    redo: function () {
      if (!this.canRedo()) return false;
      this.undoStack.push(clone(this.state));
      this.state = this.redoStack.pop();
      this.persist();
      this._emit();
      return true;
    },

    /* ---------- 元素变更（只改内存，历史由 record 统一记录） ---------- */

    addElement: function (kind, x, y, opts) {
      if (!KINDS[kind]) throw new Error('未知元素类型：' + kind);
      x = Math.round(Number(x) || 0);
      y = Math.round(Number(y) || 0);
      var el = { id: uid('el'), kind: kind, x: x, y: y };
      if (kind === 'note') {
        el.color = (opts && NOTE_COLORS[opts.color]) ? opts.color : 'yellow';
        el.text = (opts && typeof opts.text === 'string' && opts.text) ? opts.text : '新便签';
      } else if (kind === 'text') {
        el.text = (opts && typeof opts.text === 'string' && opts.text) ? opts.text : '双击编辑文本';
      }
      this.state.elements[el.id] = el;
      return el;
    },
    setPosition: function (id, x, y) {
      var el = this.state.elements[id];
      if (!el || !isFinite(x) || !isFinite(y)) return;
      el.x = Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, Math.round(x)));
      el.y = Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, Math.round(y)));
    },
    updateText: function (id, text) {
      var el = this.state.elements[id];
      if (!el || (el.kind !== 'note' && el.kind !== 'text')) return;
      el.text = String(text == null ? '' : text).slice(0, TEXT_LIMIT);
    },
    deleteElement: function (id) {
      if (!this.state.elements[id]) return;
      delete this.state.elements[id];
      // 端点消失：绑定它的连线在同一事务中一并清理，不留下悬空关系
      Object.keys(this.state.connections).forEach(function (cid) {
        var c = this.state.connections[cid];
        if (c.from === id || c.to === id) delete this.state.connections[cid];
      }, this);
    },
    clearRoom: function () {
      this.state = emptyState();
    },

    /* ---------- 连线：始终绑定两个现存元素 ---------- */

    _pairExists: function (from, to) {
      return Object.keys(this.state.connections).some(function (id) {
        var c = this.state.connections[id];
        return (c.from === from && c.to === to) || (c.from === to && c.to === from);
      }, this);
    },
    addConnection: function (from, to) {
      var els = this.state.elements;
      if (!els[from] || !els[to] || from === to) return null;
      if (this._pairExists(from, to)) return null;
      var conn = { id: uid('cn'), from: from, to: to };
      this.state.connections[conn.id] = conn;
      return conn;
    },
    updateConnectionEnd: function (id, end, targetId) {
      var c = this.state.connections[id];
      if (!c || (end !== 'from' && end !== 'to')) return false;
      if (!this.state.elements[targetId]) return false;
      var other = end === 'from' ? c.to : c.from;
      if (other === targetId) return false;
      var nextFrom = end === 'from' ? targetId : c.from;
      var nextTo = end === 'to' ? targetId : c.to;
      // 先摘除自己再查重，避免“改线”到反向端点时被误判重复
      delete this.state.connections[id];
      if (this._pairExists(nextFrom, nextTo)) {
        this.state.connections[id] = c; // 回滚
        return false;
      }
      c[end] = targetId;
      this.state.connections[id] = c;
      return true;
    },
    deleteConnection: function (id) {
      delete this.state.connections[id];
    },

    /* ---------- 导出 / 导入 ---------- */

    exportRoom: function () {
      var data = {
        app: 'canvas-room',
        version: 1,
        roomId: this.roomId,
        exportedAt: new Date().toISOString(),
        state: {
          elements: Object.keys(this.state.elements).map(function (id) {
            return clone(this.state.elements[id]);
          }, this),
          connections: Object.keys(this.state.connections).map(function (id) {
            return clone(this.state.connections[id]);
          }, this)
        }
      };
      return JSON.stringify(data, null, 2);
    },

    /* 严格校验：任何一项不合格就抛错，调用方保证当前画面在成功前不动 */
    importRoom: function (text) {
      var data;
      try { data = JSON.parse(text); }
      catch (e) { throw new Error('文件不是有效的 JSON'); }
      if (!data || typeof data !== 'object') throw new Error('文件结构不正确');
      if (data.app !== 'canvas-room') throw new Error('不是 Canvas Room 导出文件');
      if (data.version !== 1) throw new Error('不支持的导出版本：' + data.version);
      var roomId = normalizeRoomId(data.roomId);
      if (!data.state || typeof data.state !== 'object') throw new Error('缺少画布状态');

      var state = emptyState();
      var elList = data.state.elements;
      if (!Array.isArray(elList)) throw new Error('元素列表格式错误');
      elList.forEach(function (raw, i) {
        var where = '第 ' + (i + 1) + ' 个元素';
        if (!raw || typeof raw !== 'object') throw new Error(where + '格式错误');
        if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw new Error(where + '的 ID 无效');
        if (state.elements[raw.id]) throw new Error(where + '的 ID 重复');
        if (!KINDS[raw.kind]) throw new Error(where + '类型无法识别');
        if (!finiteNumber(Number(raw.x)) || !finiteNumber(Number(raw.y))) throw new Error(where + '坐标损坏');
        var el = { id: raw.id, kind: raw.kind, x: Math.round(Number(raw.x)), y: Math.round(Number(raw.y)) };
        if (raw.kind === 'note') {
          if (raw.color != null && !NOTE_COLORS[raw.color]) throw new Error(where + '颜色无效');
          el.color = NOTE_COLORS[raw.color] ? raw.color : 'yellow';
        }
        if (raw.kind === 'note' || raw.kind === 'text') {
          if (raw.text != null && typeof raw.text !== 'string') throw new Error(where + '文本损坏');
          if (typeof raw.text === 'string' && raw.text.length > TEXT_LIMIT) throw new Error(where + '文本过长');
          el.text = typeof raw.text === 'string' ? raw.text : (raw.kind === 'note' ? '新便签' : '双击编辑文本');
        }
        state.elements[el.id] = el;
      });

      var cnList = data.state.connections;
      if (!Array.isArray(cnList)) throw new Error('连线列表格式错误');
      var seenPairs = {};
      cnList.forEach(function (raw, i) {
        var where = '第 ' + (i + 1) + ' 条连线';
        if (!raw || typeof raw !== 'object') throw new Error(where + '格式错误');
        if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw new Error(where + '的 ID 无效');
        if (state.connections[raw.id]) throw new Error(where + '的 ID 重复');
        if (!state.elements[raw.from] || !state.elements[raw.to]) throw new Error(where + '端点不存在（悬空连线）');
        if (raw.from === raw.to) throw new Error(where + '连接了同一个元素');
        var pair = [raw.from, raw.to].sort().join('|');
        if (seenPairs[pair]) return; // 重复配对跳过，不算损坏
        seenPairs[pair] = 1;
        state.connections[raw.id] = { id: raw.id, from: raw.from, to: raw.to };
      });

      // 全部校验通过后才落盘、切换：损坏内容绝不可能覆盖当前画面
      var previous = this._readRecord(roomId);
      var rec = { state: state, undoStack: [], redoStack: [] };
      if (previous && Object.keys(previous.state.elements).length) {
        rec.undoStack = [clone(previous.state)]; // 导入可撤销，回到导入前
      }
      this._writeRecord(roomId, rec);
      this._loadRoom(roomId);
      this._emit();
      return roomId;
    }
  };

  global.WB = {
    RoomStore: RoomStore,
    normalizeRoomId: normalizeRoomId
  };
})(window);

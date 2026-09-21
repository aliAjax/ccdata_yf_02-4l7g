/*
 * rules.js — 白板规则层
 * 负责：元素/连线数据模型、按房间隔离、每房间撤销重做栈、离线持久化、
 *       导出打包与导入校验（悬空连线清理、损坏数据拒绝）。
 * 本文件不依赖任何 DOM / localStorage，存储由外部注入，便于直接在浏览器或 Node 中运行。
 */
(function (global) {
  'use strict';

  var APP_NAME = 'canvas-room';
  var VERSION = 1;
  var ELEMENT_TYPES = ['note', 'text', 'rect', 'circle'];
  var NOTE_COLORS = ['yellow', 'blue', 'pink'];
  var PAST_LIMIT = 100;          // 每个房间撤销栈上限
  var MAX_ELEMENTS = 2000;
  var MAX_EDGES = 3000;
  var MAX_TEXT = 5000;
  var MAX_COORD = 100000;
  var MAX_SIZE = 4000;
  var ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isStr(v) { return typeof v === 'string'; }
  function emptyPresent() { return { elements: {}, edges: {} }; }
  function snapshotEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function roomIdValid(id) { return isStr(id) && ROOM_RE.test(id); }

  /* 把任意来源的数据整理成合法 present；strict 模式下任何异常都返回 error（导入用），
     非 strict 模式丢弃坏数据继续工作（启动恢复用）。 */
  function normalizePresent(input, strict) {
    var result = { present: emptyPresent(), badElements: 0, badEdges: 0, error: null };
    var fail = function (msg) { result.error = msg; return result; };

    if (!input || typeof input !== 'object') return fail('数据格式不正确');
    if (input.elements !== undefined && input.elements !== null &&
        typeof input.elements !== 'object') return fail('elements 格式不正确');

    /* ---- 元素 ---- */
    var rawElements = [];
    if (Array.isArray(input.elements)) rawElements = input.elements.slice();
    else if (input.elements) for (var k in input.elements) rawElements.push(input.elements[k]);

    var seenIds = {};
    for (var i = 0; i < rawElements.length; i++) {
      var raw = rawElements[i];
      var el = cleanElement(raw);
      if (!el) {
        result.badElements++;
        if (strict) return fail('存在无法识别的元素');
        continue;
      }
      if (seenIds[el.id]) {
        if (strict) return fail('存在重复的元素编号');
        continue;
      }
      if (Object.keys(result.present.elements).length >= MAX_ELEMENTS) {
        if (strict) return fail('元素数量超出上限');
        break;
      }
      if (el.text && el.text.length > MAX_TEXT) {
        if (strict) return fail('元素文本过长');
        el.text = el.text.slice(0, MAX_TEXT);
      }
      seenIds[el.id] = 1;
      result.present.elements[el.id] = el;
    }

    /* ---- 连线：必须绑定两个仍然存在的端点 ---- */
    if (input.edges !== undefined && input.edges !== null &&
        typeof input.edges !== 'object') return fail('edges 格式不正确');
    var rawEdges = [];
    if (Array.isArray(input.edges)) rawEdges = input.edges.slice();
    else if (input.edges) for (var ek in input.edges) rawEdges.push(input.edges[ek]);

    var seenPairs = {};
    for (var j = 0; j < rawEdges.length; j++) {
      var er = rawEdges[j];
      var eid = er && isStr(er.id) ? er.id : uid('edg');
      if (!er || typeof er !== 'object' ||
          !isStr(er.from) || !isStr(er.to) ||
          !result.present.elements[er.from] ||
          !result.present.elements[er.to] ||
          er.from === er.to) {
        result.badEdges++;
        if (strict) return fail('存在悬空或非法连线');
        continue;
      }
      var pairKey = er.from < er.to ? er.from + '|' + er.to : er.to + '|' + er.from;
      if (seenPairs[pairKey]) continue; // 同一对元素之间只保留一条
      if (Object.keys(result.present.edges).length >= MAX_EDGES) {
        if (strict) return fail('连线数量超出上限');
        break;
      }
      seenPairs[pairKey] = 1;
      result.present.edges[eid] = { id: eid, from: er.from, to: er.to };
    }
    return result;
  }

  function cleanElement(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var id = isStr(raw.id) && raw.id ? raw.id : uid('el');
    if (ELEMENT_TYPES.indexOf(raw.type) === -1) return null;
    var x = Number(raw.x), y = Number(raw.y);
    if (!isNum(x) || !isNum(y) || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) return null;
    var el = { id: id, type: raw.type, x: Math.round(x), y: Math.round(y) };
    if (raw.type === 'note') {
      el.color = NOTE_COLORS.indexOf(raw.color) === -1 ? 'yellow' : raw.color;
      el.text = isStr(raw.text) ? raw.text : '';
    } else if (raw.type === 'text') {
      el.text = isStr(raw.text) ? raw.text : '';
    }
    if (raw.w !== undefined) {
      var w = Number(raw.w);
      if (isNum(w) && w > 0 && w <= MAX_SIZE) el.w = Math.round(w);
    }
    if (raw.h !== undefined) {
      var h = Number(raw.h);
      if (isNum(h) && h > 0 && h <= MAX_SIZE) el.h = Math.round(h);
    }
    return el;
  }

  /* 校验导出文件；只有完全合法才放行，绝不允许损坏内容覆盖画面 */
  function validateBundle(data) {
    if (!data || typeof data !== 'object') return { ok: false, error: '文件不是有效的 JSON 对象' };
    if (data.app !== APP_NAME) return { ok: false, error: '文件标识不符' };
    if (data.version !== VERSION) return { ok: false, error: '文件版本不受支持' };
    if (!roomIdValid(data.room)) return { ok: false, error: '房间号无效' };
    if (data.elements === undefined) return { ok: false, error: '缺少 elements 字段' };
    var n = normalizePresent(data, true);
    if (n.error) return { ok: false, error: n.error };
    return { ok: true, roomId: data.room, present: n.present };
  }

  function freshDb() { return { rooms: {}, lastRoom: null }; }

  /* 读取本地数据库，逐房间清洗；任何损坏都不会导致白屏 */
  function decodeDb(raw) {
    if (!raw) return { db: freshDb(), corrupt: false };
    var data;
    try { data = JSON.parse(raw); } catch (e) { return { db: freshDb(), corrupt: true }; }
    if (!data || typeof data !== 'object' || !data.rooms || typeof data.rooms !== 'object') {
      return { db: freshDb(), corrupt: true };
    }
    var db = freshDb();
    var corrupt = false;
    for (var rid in data.rooms) {
      if (!roomIdValid(rid)) { corrupt = true; continue; }
      var src = data.rooms[rid];
      if (!src || typeof src !== 'object') { corrupt = true; continue; }
      var np = normalizePresent(src.present, false);
      var room = { present: np.present, past: [], future: [] };
      if (np.badElements || np.badEdges) corrupt = true;
      ['past', 'future'].forEach(function (bucket) {
        if (!Array.isArray(src[bucket])) return;
        for (var i = 0; i < src[bucket].length; i++) {
          var sn = normalizePresent(src[bucket][i], false);
          // 撤销/重做快照同样不能包含悬空关系：有问题的部分被清洗，整帧仍可恢复
          if (sn.error) { corrupt = true; continue; }
          if (sn.badElements || sn.badEdges) corrupt = true;
          room[bucket].push(sn.present);
        }
      });
      if (room.past.length > PAST_LIMIT) room.past = room.past.slice(room.past.length - PAST_LIMIT);
      db.rooms[rid] = room;
    }
    if (isStr(data.lastRoom) && db.rooms[data.lastRoom]) db.lastRoom = data.lastRoom;
    return { db: db, corrupt: corrupt };
  }

  /* 首次使用时的示例房间 */
  function seed(db) {
    var n1 = uid('el'), n2 = uid('el'), t1 = uid('el'), r1 = uid('el'), c1 = uid('el'), e1 = uid('edg');
    db.rooms.SPRINT_42 = {
      present: {
        elements: {}
        , edges: {}
      },
      past: [],
      future: []
    };
    var p = db.rooms.SPRINT_42.present;
    p.elements[n1] = { id: n1, type: 'note', color: 'yellow', x: 100, y: 90, text: '本周目标\n把首页流程走通' };
    p.elements[n2] = { id: n2, type: 'note', color: 'blue', x: 360, y: 180, text: '灵感池\n尝试更轻的导航' };
    p.elements[t1] = { id: t1, type: 'text', x: 620, y: 90, text: '下一步：验证原型' };
    p.elements[r1] = { id: r1, type: 'rect', x: 200, y: 380 };
    p.elements[c1] = { id: c1, type: 'circle', x: 480, y: 400 };
    p.edges[e1] = { id: e1, from: n1, to: t1 };
    db.lastRoom = 'SPRINT_42';
  }

  function createStore(storage) {
    var decoded;
    try { decoded = decodeDb(storage.read()); }
    catch (e) { decoded = { db: freshDb(), corrupt: true }; }
    var db = decoded.db;
    var bootCorrupt = decoded.corrupt;
    if (Object.keys(db.rooms).length === 0) seed(db);

    var tx = null;                 // {base: 拖拽/编辑开始前的快照}
    var listeners = [];
    var saveError = false;

    function persist() {
      try { saveError = storage.write(JSON.stringify(db)) === false; }
      catch (e) { saveError = true; }
    }
    function emit(phase, meta) {
      var payload = { room: db.lastRoom, phase: phase, meta: meta || {}, saveError: saveError };
      listeners.forEach(function (fn) { try { fn(payload); } catch (e) {} });
    }
    function room() {
      if (!db.rooms[db.lastRoom]) db.lastRoom = Object.keys(db.rooms)[0] || null;
      return db.rooms[db.lastRoom];
    }
    function ensureRoom(id) {
      if (!db.rooms[id]) db.rooms[id] = { present: emptyPresent(), past: [], future: [] };
    }

    /* 事务：拖拽 / 编辑期间只预览不入栈，提交时一次性进入本房间撤销栈 */
    function begin() { tx = { base: clone(room().present) }; }
    function preview(mutator) {
      if (!tx) tx = { base: clone(room().present) };
      mutator(room().present);
      emit('preview');
    }
    function cancel() {
      if (tx) { room().present = tx.base; tx = null; }
      emit('cancel');
    }
    function commit(mutator, meta) {
      var r = room();
      var base = tx ? tx.base : clone(r.present);
      tx = null;
      if (mutator) mutator(r.present);
      // 提交前再清洗一次，从规则层杜绝悬空连线
      var clean = normalizePresent(r.present, false);
      r.present = clean.present;
      if (snapshotEqual(base, r.present)) { emit('noop', meta); return false; }
      r.past.push(base);
      if (r.past.length > PAST_LIMIT) r.past.shift();
      r.future = [];
      persist();
      emit('commit', meta || {});
      return true;
    }

    return {
      /* —— 房间 —— */
      roomId: function () { room(); return db.lastRoom; },
      roomIds: function () { return Object.keys(db.rooms); },
      wasCorruptOnBoot: function () { return bootCorrupt; },
      switchRoom: function (id) {
        if (!roomIdValid(id)) throw new Error('房间号无效');
        tx = null;
        ensureRoom(id);
        db.lastRoom = id;
        persist();
        emit('room');
      },

      /* —— 读取 —— */
      present: function () { return room().present; },
      element: function (id) { return room().present.elements[id] || null; },
      incidentEdges: function (id) {
        var out = [];
        var p = room().present;
        for (var eid in p.edges) {
          if (p.edges[eid].from === id || p.edges[eid].to === id) out.push(p.edges[eid]);
        }
        return out;
      },
      canUndo: function () { return room().past.length > 0; },
      canRedo: function () { return room().future.length > 0; },
      subscribe: function (fn) { listeners.push(fn); return function () {
        listeners = listeners.filter(function (f) { return f !== fn; });
      }; },

      /* —— 撤销 / 重做（各房间独立栈） —— */
      undo: function () {
        var r = room();
        if (!r.past.length) return false;
        tx = null;
        r.future.push(clone(r.present));
        r.present = r.past.pop();
        persist();
        emit('undo');
        return true;
      },
      redo: function () {
        var r = room();
        if (!r.future.length) return false;
        tx = null;
        r.past.push(clone(r.present));
        r.present = r.future.pop();
        persist();
        emit('redo');
        return true;
      },

      /* —— 元素操作（均进入当前房间的撤销栈） —— */
      begin: begin,
      preview: preview,
      cancel: cancel,
      commit: commit,

      addElement: function (type, x, y, color) {
        if (ELEMENT_TYPES.indexOf(type) === -1) return null;
        var id = uid('el');
        commit(function (p) {
          var el = { id: id, type: type, x: Math.round(x), y: Math.round(y) };
          if (type === 'note') { el.color = NOTE_COLORS.indexOf(color) === -1 ? 'yellow' : color; el.text = '新便签\n双击编辑内容'; }
          if (type === 'text') el.text = '双击编辑文本';
          p.elements[id] = el;
        }, { action: 'add', type: type });
        return id;
      },
      editElement: function (id, text) {
        var el = room().present.elements[id];
        if (!el || (el.type !== 'note' && el.type !== 'text') || !isStr(text)) return false;
        return commit(function (p) { p.elements[id].text = text; }, { action: 'edit', type: el.type });
      },
      removeElement: function (id) {
        var el = room().present.elements[id];
        if (!el) return false;
        var removedEdges = 0;
        commit(function (p) {
          delete p.elements[id];
          for (var eid in p.edges) {
            if (p.edges[eid].from === id || p.edges[eid].to === id) { delete p.edges[eid]; removedEdges++; }
          }
        }, { action: 'remove', type: el.type, removedEdges: removedEdges });
        return true;
      },
      clearRoom: function () {
        return commit(function (p) { p.elements = {}; p.edges = {}; }, { action: 'clear' });
      },

      /* —— 连线：绑定两个元素 —— */
      addEdge: function (from, to) {
        var p = room().present;
        if (!p.elements[from] || !p.elements[to]) return { ok: false, reason: 'missing' };
        if (from === to) return { ok: false, reason: 'self' };
        var key = from < to ? from + '|' + to : to + '|' + from;
        for (var eid in p.edges) {
          var e = p.edges[eid];
          var k = e.from < e.to ? e.from + '|' + e.to : e.to + '|' + e.from;
          if (k === key) return { ok: false, reason: 'duplicate' };
        }
        var id = uid('edg');
        commit(function (p) { p.edges[id] = { id: id, from: from, to: to }; }, { action: 'connect' });
        return { ok: true, id: id };
      },
      removeEdge: function (id) {
        if (!room().present.edges[id]) return false;
        return commit(function (p) { delete p.edges[id]; }, { action: 'disconnect' });
      },

      /* —— 导出 / 导入 —— */
      exportBundle: function () {
        var p = room().present;
        return {
          app: APP_NAME,
          version: VERSION,
          room: db.lastRoom,
          exportedAt: new Date().toISOString(),
          elements: Object.keys(p.elements).map(function (id) { return clone(p.elements[id]); }),
          edges: Object.keys(p.edges).map(function (id) { return clone(p.edges[id]); })
        };
      },
      importBundle: function (data) {
        var verdict = validateBundle(data);
        if (!verdict.ok) return verdict;
        var id = verdict.roomId;
        tx = null;
        ensureRoom(id);
        var r = db.rooms[id];
        r.past.push(clone(r.present));
        if (r.past.length > PAST_LIMIT) r.past.shift();
        r.present = verdict.present;
        r.future = [];
        db.lastRoom = id;
        persist();
        emit('commit', { action: 'import' });
        return { ok: true, roomId: id };
      },

      ELEMENT_TYPES: ELEMENT_TYPES,
      NOTE_COLORS: NOTE_COLORS
    };
  }

  global.WhiteboardRules = {
    APP_NAME: APP_NAME,
    VERSION: VERSION,
    roomIdValid: roomIdValid,
    normalizePresent: normalizePresent,
    validateBundle: validateBundle,
    decodeDb: decodeDb,
    createStore: createStore
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* =========================================================
   后湖小区 · 美食地图
   楼栋固定尺寸 · 商户 flex 自适应填充 · 拖拽改大小/顺序
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 地图参数（改这里即可调整布局） ---------------- */
  const CFG = {
    boxW: 380,      // 楼栋盒子宽（固定，每栋一致）
    boxH: 120,      // 楼栋盒子高
    gapY: 18,       // 楼栋纵向间距
    westX: 110,     // 西侧起始 x
    eastX: 610,     // 东侧起始 x
    startY: 170
  };

  // 南北按卫星图排：23 在 22 上方，1 与 2 横向对齐（底端对齐）
  const WEST = [23, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2];
  const EAST = [21, 19, 17, 15, 13, 11, 9, 7, 5, 3, 1];
  const ROW_H = CFG.boxH + CFG.gapY;
  const ROWS = Math.max(WEST.length, EAST.length);
  const EAST_OFFSET = WEST.length - EAST.length;   // 东侧整体下移，保证 1/2 同排
  const BOARD_W = CFG.eastX + CFG.boxW + 110;
  const BOARD_H = CFG.startY + ROWS * ROW_H + 90;

  const MIN_K = 0.28, MAX_K = 2.4;

  // 初始不带任何商户，全部由用户自己添加
  const SEED = {};

  const KEY = 'houhu.foodmap.v3';

  function uid() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  /* ---------------- 状态 ---------------- */
  let state = loadState() || seedState();
  let editMode = false;
  let cur = null;           // { b, m }
  let saveTimer = 0;

  // 多端同步：server 模式走 HTTP + SSE，local 模式退回浏览器本地存储
  const SYNC = { mode: 'local', version: 0, busy: false, pending: false, timer: 0, es: null };
  // 登录状态：enabled 表示服务端带鉴权，canEdit 决定能不能改
  const AUTH = { enabled: false, user: null, canEdit: true, sso: null };

  function seedState() {
    const buildings = [];
    WEST.forEach((no, i) => {
      buildings.push({ id: 'b' + no, no, x: CFG.westX, y: CFG.startY + i * ROW_H, merchants: [] });
    });
    EAST.forEach((no, i) => {
      buildings.push({ id: 'b' + no, no, x: CFG.eastX, y: CFG.startY + (i + EAST_OFFSET) * ROW_H, merchants: [] });
    });
    buildings.forEach((b) => {
      (SEED[b.no] || []).forEach((s) => {
        b.merchants.push({
          id: uid(),
          name: s.name,
          tag: s.tag || '',
          span: 1,
          blocks: s.blocks ? JSON.parse(JSON.stringify(s.blocks)) : []
        });
      });
    });
    return { version: 3, buildings };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      return normalizeDoc(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  }

  // 兼容旧数据 / 服务器数据：补齐字段，并保证 23 栋永远齐全
  function normalizeDoc(s) {
    if (!s || !Array.isArray(s.buildings)) return null;
    const byNo = {};
    s.buildings.forEach(function (b) {
      if (!b || typeof b.no !== 'number') return;
      b.merchants = (b.merchants || []).filter(Boolean);
      b.merchants.forEach(function (m) {
        if (!Array.isArray(m.blocks)) m.blocks = [];
        if (typeof m.span !== 'number') m.span = 1;
      });
      byNo[b.no] = b;
    });
    const out = [];
    WEST.concat(EAST).forEach(function (no) {
      const b = byNo[no] || { id: 'b' + no, no: no, merchants: [] };
      if (!b.id) b.id = 'b' + no;
      if (!Array.isArray(b.merchants)) b.merchants = [];
      out.push(b);
    });
    return { version: s.version || 0, buildings: out };
  }

  function saveNow() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      toast('本地空间不足：图片太多时可能存不下');
    }
    pushRemote();
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 350);
  }

  /* ---------------- DOM ---------------- */
  const boardEl = document.getElementById('board');
  const viewport = document.getElementById('viewport');
  const detailEl = document.getElementById('detail');
  const scrimEl = document.getElementById('scrim');
  const nameEl = document.getElementById('dName');
  const tagEl = document.getElementById('dTag');
  const badgeEl = document.getElementById('dBadge');
  const bodyEl = document.getElementById('dBody');
  const fileInput = document.getElementById('fileInput');
  const hintEl = document.getElementById('hint');
  const toastEl = document.getElementById('toast');
  const syncEl = document.getElementById('sync');
  const syncLabel = document.getElementById('syncLabel');
  const btnAuth = document.getElementById('btnAuth');
  const dRO = document.getElementById('dRO');

  /* ---------------- 视图（平移 / 缩放） ---------------- */
  const view = { x: 0, y: 0, k: 1 };

  function applyView() {
    boardEl.style.transform = 'translate3d(' + view.x + 'px,' + view.y + 'px,0) scale(' + view.k + ')';
  }

  function clampView() {
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    const w = BOARD_W * view.k, h = BOARD_H * view.k;
    if (w <= vw) view.x = (vw - w) / 2;
    else view.x = Math.min(0, Math.max(vw - w, view.x));
    if (h <= vh) view.y = (vh - h) / 2;
    else view.y = Math.min(0, Math.max(vh - h, view.y));
  }

  function zoomAt(k, px, py) {
    const k2 = clamp(k, MIN_K, MAX_K);
    if (Math.abs(k2 - view.k) < 0.0001) return;
    const wx = (px - view.x) / view.k;
    const wy = (py - view.y) / view.k;
    view.k = k2;
    view.x = px - wx * k2;
    view.y = py - wy * k2;
    clampView();
    applyView();
  }

  function fitWidth() {
    const vw = viewport.clientWidth;
    view.k = clamp(vw / BOARD_W, 0.5, 1);
    view.x = (vw - BOARD_W * view.k) / 2;
    view.y = 24;
    clampView();
    applyView();
  }

  function fitAll() {
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    view.k = clamp(Math.min(vw / BOARD_W, vh / BOARD_H), MIN_K, 1);
    view.x = (vw - BOARD_W * view.k) / 2;
    view.y = (vh - BOARD_H * view.k) / 2;
    clampView();
    applyView();
  }

  /* ---------------- 平移 / 缩放交互 ---------------- */
  const active = new Map();
  let panStart = null, pinch = null, downTarget = null, downPt = null, downAt = 0, moved = false;

  // 这些区域不参与地图手势（详情页、遮罩、搜索下拉、表单控件）
  const NO_MAP = '.detail, .scrim, .q-list, a, button, input, textarea, select, label';

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest && e.target.closest(NO_MAP)) return;

    const inViewport = viewport.contains(e.target);
    stopViewAnim();
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (active.size === 1) {
      downTarget = inViewport ? e.target : null;
      downPt = { x: e.clientX, y: e.clientY };
      downAt = Date.now();
      moved = false;
      pinch = null;
      panStart = inViewport ? { cx: e.clientX, cy: e.clientY, vx: view.x, vy: view.y } : null;
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    } else if (active.size === 2) {
      startPinch();   // 双指：从页面任何位置开始都能缩放地图
    }
  }

  function startPinch() {
    const pts = Array.from(active.values());
    pinch = {
      d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
      cx: (pts[0].x + pts[1].x) / 2,
      cy: (pts[0].y + pts[1].y) / 2,
      k: view.k, vx: view.x, vy: view.y
    };
    panStart = null;
    downTarget = null;
    moved = true;
  }

  function onPointerMove(e) {
    if (!active.has(e.pointerId)) return;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch && active.size >= 2) {
      const pts = Array.from(active.values());
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      const k = clamp(pinch.k * (d / pinch.d), MIN_K, MAX_K);
      const rect = viewport.getBoundingClientRect();
      const wx = (pinch.cx - rect.left - pinch.vx) / pinch.k;
      const wy = (pinch.cy - rect.top - pinch.vy) / pinch.k;
      view.k = k;
      view.x = cx - rect.left - wx * k;
      view.y = cy - rect.top - wy * k;
      // 手势进行中不做边界钳制，否则贴边缩放会被“顶”回去
      applyView();
      return;
    }

    if (panStart) {
      const dx = e.clientX - panStart.cx, dy = e.clientY - panStart.cy;
      if (!moved) {
        if (Math.hypot(dx, dy) < 8) return;   // 8px 内不位移，避免轻点就晃一下
        moved = true;
      }
      view.x = panStart.vx + dx;
      view.y = panStart.vy + dy;
      clampView();
      applyView();
    }
  }

  function onPointerUp(e) {
    const wasSingle = active.size === 1;
    const hadPinch = !!pinch;
    active.delete(e.pointerId);

    if (active.size === 0) {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      // 位移小于 12px 且松手够快 → 认为是点击商户（手指抖动不再被误判成拖动）
      if (wasSingle && downTarget && downPt && !editMode && Date.now() - downAt < 700) {
        const card = downTarget.closest && downTarget.closest('.m');
        const dist = Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y);
        if (card && dist < 12) openDetail(card);
      }

      if (hadPinch) clampView();
      panStart = null;
      pinch = null;
      downTarget = null;
      downPt = null;
      moved = false;
    } else if (active.size === 1) {
      // 双指变单指：以剩下这根手指的位置继续平移
      const p = Array.from(active.values())[0];
      panStart = { cx: p.x, cy: p.y, vx: view.x, vy: view.y };
      pinch = null;
      if (hadPinch) clampView();
    }
  }

  document.addEventListener('pointerdown', onPointerDown, { passive: true });

  viewport.addEventListener('wheel', function (e) {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const f = Math.exp(-e.deltaY * 0.0016);
    zoomAt(view.k * f, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  document.querySelectorAll('[data-zoom]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const rect = viewport.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      zoomAt(view.k * (btn.dataset.zoom === 'in' ? 1.28 : 1 / 1.28), cx, cy);
    });
  });

  /* ---------------- 渲染地图 ---------------- */
  function renderBoard() {
    boardEl.innerHTML = '';
    boardEl.style.width = BOARD_W + 'px';
    boardEl.style.height = BOARD_H + 'px';
    layoutBuildings();

    // 北侧清水路（横向贯穿整条街）
    const highway = document.createElement('div');
    highway.className = 'road-h';
    highway.style.top = '26px';
    highway.style.height = '78px';
    boardEl.appendChild(highway);
    addLabel('lbl-road', '清水路', 46, 54, 'left');

    // 小区内部主路（纵向）
    const lane = document.createElement('div');
    lane.className = 'road';
    lane.style.left = (CFG.westX + CFG.boxW + 10) + 'px';
    lane.style.width = (CFG.eastX - CFG.westX - CFG.boxW - 20) + 'px';
    lane.style.top = '140px';
    lane.style.height = (BOARD_H - 180) + 'px';
    boardEl.appendChild(lane);

    addLabel('lbl-compound', '后湖小区', BOARD_W / 2, BOARD_H - 62, 'center');

    const frag = document.createDocumentFragment();
    state.buildings.forEach(function (b) { frag.appendChild(renderBuilding(b)); });
    boardEl.appendChild(frag);
    updateInfoChip();
  }

  // 楼栋坐标由编号推导，改 CFG 后不需要迁移旧数据
  function layoutBuildings() {
    state.buildings.forEach(function (b) {
      const wi = WEST.indexOf(b.no);
      const ei = EAST.indexOf(b.no);
      if (wi >= 0) {
        b.x = CFG.westX;
        b.y = CFG.startY + wi * ROW_H;
      } else if (ei >= 0) {
        b.x = CFG.eastX;
        b.y = CFG.startY + (ei + EAST_OFFSET) * ROW_H;
      }
    });
  }

  function addLabel(cls, text, x, y, align) {
    const el = document.createElement('div');
    el.className = 'map-label ' + cls;
    el.textContent = text;
    el.style.top = y + 'px';
    if (align === 'center') {
      el.style.left = x + 'px';
      el.style.transform = 'translateX(-50%)';
    } else if (align === 'right') {
      el.style.right = (BOARD_W - x) + 'px';
    } else {
      el.style.left = x + 'px';
    }
    boardEl.appendChild(el);
  }

  function renderBuilding(b) {
    const el = document.createElement('article');
    el.className = 'building';
    el.dataset.bid = b.id;
    el.style.left = b.x + 'px';
    el.style.top = b.y + 'px';
    el.style.width = CFG.boxW + 'px';
    el.style.height = CFG.boxH + 'px';

    const head = document.createElement('div');
    head.className = 'bh';

    const no = document.createElement('span');
    no.className = 'bno';
    no.textContent = b.no + ' 栋';

    const meta = document.createElement('span');
    meta.className = 'bmeta';

    const cnt = document.createElement('span');
    cnt.className = 'bcount';
    cnt.dataset.count = b.id;
    cnt.textContent = countText(b);

    const add = document.createElement('button');
    add.className = 'addm';
    add.type = 'button';
    add.textContent = '＋';
    add.title = '添加商户';
    add.setAttribute('aria-label', b.no + ' 栋添加商户');
    add.addEventListener('click', function (e) {
      e.stopPropagation();
      addMerchant(b);
    });

    meta.appendChild(cnt);
    meta.appendChild(add);
    head.appendChild(no);
    head.appendChild(meta);

    const grid = document.createElement('div');
    grid.className = 'grid';
    if (b.merchants.length >= 12) grid.classList.add('dense');
    else if (b.merchants.length >= 7) grid.classList.add('many');

    if (!b.merchants.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = editMode ? '＋' : '';
      if (editMode) {
        empty.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        empty.addEventListener('click', function (e) { e.stopPropagation(); addMerchant(b); });
      }
      grid.appendChild(empty);
    } else {
      b.merchants.forEach(function (m) { grid.appendChild(renderMerchant(b, m)); });
    }

    el.appendChild(head);
    el.appendChild(grid);
    return el;
  }

  function countText(b) {
    return b.merchants.length ? b.merchants.length + ' 家' : '';
  }

  function renderMerchant(b, m) {
    const el = document.createElement('div');
    el.className = 'm';
    el.dataset.mid = m.id;
    el.style.setProperty('--s', m.span || 1);

    const nm = document.createElement('span');
    nm.className = 'm-nm';
    nm.textContent = m.name || '未命名';
    nm.title = m.name || '';

    const del = document.createElement('button');
    del.className = 'm-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = '删除商户';
    del.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      if (confirm('删除「' + (m.name || '未命名') + '」？')) removeMerchant(b, m);
    });

    const rs = document.createElement('span');
    rs.className = 'm-rs';
    rs.title = '拖动调整大小';
    rs.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      if (editMode) startResize(e, el);
    });

    el.appendChild(nm);
    el.appendChild(del);
    el.appendChild(rs);
    return el;
  }

  function refreshBuilding(b) {
    const old = boardEl.querySelector('[data-bid="' + b.id + '"]');
    if (old) old.replaceWith(renderBuilding(b));
    const cnt = boardEl.querySelector('[data-count="' + b.id + '"]');
    if (cnt) cnt.textContent = countText(b);
    updateInfoChip();
  }

  /* ---------------- 编辑：拖拽排序 / 拖拽改大小 ---------------- */
  let drag = null;

  boardEl.addEventListener('pointerdown', function (e) {
    if (!editMode || !AUTH.canEdit) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const item = e.target.closest('.m');
    if (!item) return;
    if (e.target.closest('.m-del')) return;   // 删除按钮走自己的 click

    e.preventDefault();
    e.stopPropagation();

    if (e.target.closest('.m-rs')) { startResize(e, item); return; }
    startDrag(e, item);
  });

  function startDrag(e, item) {
    const buildingEl = item.closest('.building');
    drag = {
      el: item,
      buildingEl: buildingEl,
      building: state.buildings.find(function (b) { return b.id === buildingEl.dataset.bid; }),
      sx: e.clientX, sy: e.clientY,
      moved: false
    };
    // 用 window 监听而不是 setPointerCapture：任何浏览器上都不会因捕获失败而卡住
    window.addEventListener('pointermove', onItemMove, { passive: false });
    window.addEventListener('pointerup', onItemUp);
    window.addEventListener('pointercancel', onItemUp);
  }

  function onItemMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 6) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
    }
    if (e.cancelable) e.preventDefault();

    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    let under = null;
    for (let i = 0; i < stack.length; i++) {
      const n = stack[i];
      if (n === drag.el) continue;
      if (n.classList && n.classList.contains('m') && n.closest('.building') === drag.buildingEl) {
        under = n;
        break;
      }
    }
    if (!under) return;

    const r = under.getBoundingClientRect();
    const grid = drag.buildingEl.querySelector('.grid');
    if (e.clientX < r.left + r.width / 2) {
      if (under.previousElementSibling !== drag.el) grid.insertBefore(drag.el, under);
    } else if (under.nextElementSibling !== drag.el) {
      grid.insertBefore(drag.el, under.nextElementSibling);
    }
  }

  function onItemUp() {
    window.removeEventListener('pointermove', onItemMove);
    window.removeEventListener('pointerup', onItemUp);
    window.removeEventListener('pointercancel', onItemUp);
    if (!drag) return;

    const el = drag.el;
    el.classList.remove('dragging');

    if (drag.moved) {
      const grid = drag.buildingEl.querySelector('.grid');
      const order = Array.prototype.map.call(grid.querySelectorAll('.m'), function (n) { return n.dataset.mid; });
      const b = drag.building;
      b.merchants.sort(function (x, y) { return order.indexOf(x.id) - order.indexOf(y.id); });
      saveSoon();
      toast('顺序已更新');
    }
    drag = null;
  }

  function startResize(e, item) {
    const startSpan = parseFloat(item.style.getPropertyValue('--s')) || 1;
    const startW = item.getBoundingClientRect().width / (view.k || 1) || 80;
    const sx = e.clientX;
    item.classList.add('resizing');

    function move(ev) {
      const dx = (ev.clientX - sx) / (view.k || 1);
      const span = clamp(startSpan * ((startW + dx) / startW), 0.45, 6);
      item.style.setProperty('--s', span.toFixed(2));
    }

    function end() {
      item.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const bEl = item.closest('.building');
      const b = state.buildings.find(function (x) { return x.id === bEl.dataset.bid; });
      const m = b && b.merchants.find(function (x) { return x.id === item.dataset.mid; });
      if (m) {
        m.span = parseFloat(item.style.getPropertyValue('--s')) || 1;
        saveSoon();
        toast('已调整大小');
      }
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  /* ---------------- 增删商户 ---------------- */
  function addMerchant(b) {
    if (!AUTH.canEdit) { toast('登录后才能添加商户'); return; }
    const m = { id: uid(), name: '新商户', tag: '', span: 1, blocks: [] };
    b.merchants.push(m);
    refreshBuilding(b);
    saveSoon();
    openDetailById(b.id, m.id);
    toast('已添加商户，写点内容吧');
  }

  function removeMerchant(b, m) {
    if (!AUTH.canEdit) { toast('登录后才能删除'); return; }
    b.merchants = b.merchants.filter(function (x) { return x.id !== m.id; });
    if (cur && cur.m.id === m.id) closeDetail();
    refreshBuilding(b);
    saveSoon();
    toast('已删除');
  }

  /* ---------------- 详情页 ---------------- */
  function openDetail(cardEl) {
    const bid = cardEl.closest('.building').dataset.bid;
    openDetailById(bid, cardEl.dataset.mid);
  }

  function openDetailById(bid, mid) {
    const b = state.buildings.find(function (x) { return x.id === bid; });
    if (!b) return;
    const m = b.merchants.find(function (x) { return x.id === mid; });
    if (!m) return;
    cur = { b: b, m: m };

    nameEl.value = m.name || '';
    tagEl.value = m.tag || '';
    badgeEl.textContent = b.no + ' 栋';

    const ro = !AUTH.canEdit;
    nameEl.readOnly = ro;
    tagEl.readOnly = ro;
    detailEl.classList.toggle('readonly', ro);
    if (dRO) dRO.hidden = !ro;

    renderBlocks();

    detailEl.classList.add('open');
    detailEl.setAttribute('aria-hidden', 'false');
    scrimEl.classList.add('show');

    // 深链：/index.html#b7-1 直接打开 7 栋第 1 家
    try {
      history.replaceState(null, '', '#b' + b.no + '-' + (b.merchants.indexOf(m) + 1));
    } catch (e) {}
  }

  // 支持直接用 #b7 / #b7-2 打开某个商户（可分享链接）
  function openByHash() {
    const m = /^b(\d+)(?:-(\d+))?$/.exec((location.hash || '').replace('#', ''));
    if (!m) return;
    const b = state.buildings.find(function (x) { return x.no === Number(m[1]); });
    if (!b || !b.merchants.length) return;
    const idx = Math.min(b.merchants.length, Math.max(1, Number(m[2] || 1))) - 1;
    const merch = b.merchants[idx];
    if (cur && cur.m.id === merch.id) return;
    openDetailById(b.id, merch.id);
  }

  function closeDetail() {
    cur = null;
    detailEl.classList.remove('open');
    detailEl.setAttribute('aria-hidden', 'true');
    scrimEl.classList.remove('show');
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    if (SYNC.pending) { SYNC.pending = false; pullRemote(); }
  }

  function renderBlocks() {
    bodyEl.innerHTML = '';
    const m = cur.m;

    if (!m.blocks.length) {
      const empty = document.createElement('div');
      empty.className = 'd-empty';
      if (AUTH.canEdit) {
        empty.innerHTML = '还没有内容<br>用下方 <b>＋ 文字</b> 写招牌菜、营业时间，<br>用 <b>＋ 图片</b> 放张照片';
      } else {
        empty.textContent = '还没有内容';
      }
      bodyEl.appendChild(empty);
      return;
    }

    m.blocks.forEach(function (blk, i) {
      bodyEl.appendChild(blk.type === 'image' ? imageBlock(blk, i) : textBlock(blk, i));
    });
  }

  function textBlock(blk, index) {
    const wrap = document.createElement('div');
    wrap.className = 'blk';

    const ta = document.createElement('textarea');
    ta.value = blk.text || '';
    ta.placeholder = '写点介绍、招牌菜、营业时间…';
    ta.rows = 2;
    ta.readOnly = !AUTH.canEdit;
    if (AUTH.canEdit) {
      ta.addEventListener('input', function () {
        blk.text = ta.value;
        autoGrow(ta);
        saveSoon();
      });
    }

    wrap.appendChild(ta);
    if (AUTH.canEdit) wrap.appendChild(blockDelete(index));
    requestAnimationFrame(function () { autoGrow(ta); });
    return wrap;
  }

  function imageBlock(blk, index) {
    const wrap = document.createElement('div');
    wrap.className = 'blk blk-img';

    const img = document.createElement('img');
    img.src = blk.src;
    img.alt = blk.caption || '商户图片';

    const cap = document.createElement('input');
    cap.type = 'text';
    cap.value = blk.caption || '';
    cap.placeholder = '图片说明（可留空）';
    cap.readOnly = !AUTH.canEdit;
    if (AUTH.canEdit) {
      cap.addEventListener('input', function () {
        blk.caption = cap.value;
        saveSoon();
      });
    }

    wrap.appendChild(img);
    wrap.appendChild(cap);
    if (AUTH.canEdit) wrap.appendChild(blockDelete(index));
    return wrap;
  }

  function blockDelete(index) {
    const btn = document.createElement('button');
    btn.className = 'blk-del';
    btn.type = 'button';
    btn.textContent = '×';
    btn.title = '删除这一段';
    btn.addEventListener('click', function () {
      cur.m.blocks.splice(index, 1);
      renderBlocks();
      saveSoon();
    });
    return btn;
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(64, ta.scrollHeight) + 'px';
  }

  nameEl.addEventListener('input', function () {
    if (!cur) return;
    cur.m.name = nameEl.value;
    const el = boardEl.querySelector('[data-mid="' + cur.m.id + '"] .m-nm');
    if (el) {
      el.textContent = nameEl.value || '未命名';
      el.title = nameEl.value || '';
    }
    saveSoon();
  });

  tagEl.addEventListener('input', function () {
    if (!cur) return;
    cur.m.tag = tagEl.value;
    saveSoon();
  });

  document.getElementById('addText').addEventListener('click', function () {
    if (!cur) return;
    cur.m.blocks.push({ type: 'text', text: '' });
    renderBlocks();
    saveSoon();
    const tas = bodyEl.querySelectorAll('textarea');
    if (tas.length) tas[tas.length - 1].focus();
  });

  const addImageBtn = document.getElementById('addImage');
  addImageBtn.addEventListener('click', function () {
    if (!cur) return;
    fileInput.click();
  });

  fileInput.addEventListener('change', async function () {
    const files = Array.prototype.slice.call(fileInput.files || []);
    fileInput.value = '';
    if (!files.length || !cur) return;
    let ok = 0;
    for (const f of files) {
      if (!f.type || f.type.indexOf('image/') !== 0) continue;
      try {
        const src = await shrinkImage(f);
        cur.m.blocks.push({ type: 'image', src: src, caption: '' });
        ok++;
      } catch (err) {
        toast('有一张图片读取失败');
      }
    }
    if (ok) {
      renderBlocks();
      saveSoon();
      toast('已添加 ' + ok + ' 张图片');
    }
  });

  function shrinkImage(file, maxSide, quality) {
    maxSide = maxSide || 1000;
    quality = quality || 0.82;
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        try {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement('canvas');
          cv.width = w;
          cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          resolve(cv.toDataURL('image/jpeg', quality));
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('decode'));
      };
      img.src = url;
    });
  }

  document.getElementById('delMerchant').addEventListener('click', function () {
    if (!cur) return;
    if (!confirm('删除「' + (cur.m.name || '未命名') + '」？')) return;
    const b = cur.b, m = cur.m;
    closeDetail();
    removeMerchant(b, m);
  });

  document.getElementById('dClose').addEventListener('click', closeDetail);
  scrimEl.addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && cur) closeDetail();
  });

  /* ---------------- 搜索 ---------------- */
  const searchEl = document.getElementById('search');
  const qInput = document.getElementById('q');
  const qList = document.getElementById('qList');
  const qClear = document.getElementById('qClear');
  let qResults = [];
  let qActive = -1;

  function searchAll(q) {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const out = [];
    state.buildings.forEach(function (b) {
      const noStr = String(b.no);
      if (noStr === query || query === noStr + '栋' || query === noStr + '栋楼') {
        out.push({ type: 'b', b: b, score: 9 });
      }
      b.merchants.forEach(function (m) {
        const name = (m.name || '').toLowerCase();
        const tag = (m.tag || '').toLowerCase();
        let score = -1;
        if (name === query) score = 5;
        else if (name.indexOf(query) === 0) score = 4;
        else if (name.indexOf(query) >= 0) score = 3;
        else if (tag.indexOf(query) >= 0) score = 2;
        if (score >= 0) out.push({ type: 'm', b: b, m: m, score: score });
      });
    });
    out.sort(function (a, b2) { return b2.score - a.score; });
    return out.slice(0, 8);
  }

  function renderSearch() {
    const q = qInput.value;
    searchEl.classList.toggle('has-text', !!q);
    qResults = searchAll(q);
    qActive = -1;
    qList.innerHTML = '';

    if (!q.trim()) { qList.classList.remove('show'); return; }

    if (!qResults.length) {
      const li = document.createElement('li');
      li.className = 'q-empty';
      li.textContent = '没有找到「' + q.trim() + '」';
      qList.appendChild(li);
    } else {
      qResults.forEach(function (r, i) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.idx = String(i);

        const nm = document.createElement('span');
        nm.className = 'q-name';
        nm.textContent = r.type === 'b' ? r.b.no + ' 栋' : (r.m.name || '未命名');

        const sub = document.createElement('span');
        sub.className = 'q-sub';
        if (r.type === 'b') sub.textContent = r.b.merchants.length ? r.b.merchants.length + ' 家' : '楼栋';
        else sub.textContent = r.b.no + ' 栋' + (r.m.tag ? ' · ' + r.m.tag : '');

        btn.appendChild(nm);
        btn.appendChild(sub);
        li.appendChild(btn);
        qList.appendChild(li);
      });
    }
    qList.classList.add('show');
  }

  function pickResult(i) {
    const r = qResults[i];
    if (!r) return;
    qList.classList.remove('show');
    qInput.blur();
    jumpTo(r.b, r.type === 'm' ? r.m : null);
  }

  qInput.addEventListener('input', renderSearch);
  qInput.addEventListener('focus', function () { if (qInput.value.trim()) renderSearch(); });
  qInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      qList.classList.remove('show');
      qInput.blur();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!qResults.length) return;
      e.preventDefault();
      const n = qResults.length;
      qActive = (qActive + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      const btns = qList.querySelectorAll('button');
      for (let i = 0; i < btns.length; i++) btns[i].classList.toggle('active', i === qActive);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      pickResult(qActive >= 0 ? qActive : 0);
    }
  });

  qClear.addEventListener('click', function () {
    qInput.value = '';
    renderSearch();
    qInput.focus();
  });

  qList.addEventListener('click', function (e) {
    const btn = e.target.closest('button');
    if (btn) pickResult(Number(btn.dataset.idx));
  });

  document.addEventListener('pointerdown', function (e) {
    if (!searchEl.contains(e.target)) qList.classList.remove('show');
  });

  /* ---------------- 定位与镜头动画 ---------------- */
  let animId = 0;

  function stopViewAnim() {
    if (animId) { cancelAnimationFrame(animId); animId = 0; }
  }

  function targetView(cx, cy, k) {
    k = clamp(k, MIN_K, MAX_K);
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    const w = BOARD_W * k, h = BOARD_H * k;
    let x = vw / 2 - cx * k;
    let y = vh / 2 - cy * k;
    if (w <= vw) x = (vw - w) / 2; else x = Math.min(0, Math.max(vw - w, x));
    if (h <= vh) y = (vh - h) / 2; else y = Math.min(0, Math.max(vh - h, y));
    return { x: x, y: y, k: k };
  }

  function animateViewTo(t, dur) {
    stopViewAnim();
    const from = { x: view.x, y: view.y, k: view.k };
    const t0 = performance.now();
    dur = dur || 340;
    return new Promise(function (resolve) {
      function step(now) {
        const p = clamp((now - t0) / dur, 0, 1);
        const e = 1 - Math.pow(1 - p, 3);
        view.x = from.x + (t.x - from.x) * e;
        view.y = from.y + (t.y - from.y) * e;
        view.k = from.k + (t.k - from.k) * e;
        applyView();
        if (p < 1) animId = requestAnimationFrame(step);
        else { animId = 0; resolve(); }
      }
      animId = requestAnimationFrame(step);
    });
  }

  function flashBuilding(bid) {
    const el = boardEl.querySelector('[data-bid="' + bid + '"]');
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); }, 2200);
  }

  function jumpTo(b, m) {
    const cx = b.x + CFG.boxW / 2;
    const cy = b.y + CFG.boxH / 2;
    const k = Math.max(view.k, 0.88);
    const t = targetView(cx, cy, k);
    animateViewTo(t, m ? 280 : 380).then(function () {
      flashBuilding(b.id);
      if (m) openDetailById(b.id, m.id);
    });
  }

  /* ---------------- 登录状态 ---------------- */
  async function initAuth() {
    try {
      const r = await fetch('api/me', { cache: 'no-store' });
      if (!r.ok) throw new Error('no-auth');
      const j = await r.json();
      if (j && j.auth) {
        AUTH.enabled = true;
        AUTH.user = j.user || null;
        AUTH.canEdit = !!j.canEdit;
        AUTH.sso = j.sso || null;
      }
    } catch (e) { /* 纯静态 / 旧版服务：不做鉴权，人人可编辑 */ }
    applyAuthUI();
  }

  function applyAuthUI() {
    const noEdit = AUTH.enabled && !AUTH.canEdit;
    document.body.classList.toggle('no-edit', noEdit);

    if (noEdit && editMode) {
      editMode = false;
      document.body.classList.remove('edit');
      const eb = document.getElementById('btnEdit');
      if (eb) eb.classList.remove('on');
    }

    if (!AUTH.enabled) {
      btnAuth.hidden = true;
    } else if (AUTH.user) {
      btnAuth.hidden = false;
      btnAuth.textContent = (AUTH.user.name || AUTH.user.username) + ' · 退出';
      btnAuth.href = '/logout';
      btnAuth.classList.add('logout');
    } else {
      btnAuth.hidden = false;
      btnAuth.textContent = '登录后编辑';
      btnAuth.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      btnAuth.classList.remove('logout');
    }

    detailEl.classList.toggle('readonly', noEdit);
    if (dRO) dRO.hidden = !noEdit;
    if (cur) {
      nameEl.readOnly = noEdit;
      tagEl.readOnly = noEdit;
      renderBlocks();
    }
  }

  /* ---------------- 多端同步 ---------------- */
  function setSync(mode, text) {
    if (!syncEl) return;
    const labels = { local: '本机保存', saving: '保存中…', synced: '已同步', error: '未连接' };
    syncEl.className = 'sync is-' + mode;
    if (syncLabel) syncLabel.textContent = text || labels[mode] || '';
    if (mode === 'local') syncEl.title = '未连接同步服务：数据只保存在本机浏览器';
    else if (mode === 'error') syncEl.title = '连不上同步服务，修改先存本机，恢复后自动重试';
    else syncEl.title = text || labels[mode] || '';
  }

  function pushRemote() {
    if (SYNC.mode !== 'server') return;
    clearTimeout(SYNC.timer);
    SYNC.timer = setTimeout(doPush, 260);
  }

  async function doPush() {
    if (SYNC.mode !== 'server') return;
    if (SYNC.busy) { pushRemote(); return; }
    SYNC.busy = true;
    setSync('saving');
    try {
      const r = await fetch('api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: state })
      });
      if (r.status === 401 || r.status === 403) {
        AUTH.canEdit = false;
        applyAuthUI();
        setSync('error', '需要重新登录');
        toast('登录状态已失效，请重新登录后再编辑');
        return;
      }
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      SYNC.version = Number(j.version) || SYNC.version;
      setSync('synced');
    } catch (e) {
      setSync('error');
    } finally {
      SYNC.busy = false;
    }
  }

  function connectSSE() {
    if (!window.EventSource) return;
    try {
      const es = new EventSource('api/events');
      es.addEventListener('update', function (ev) {
        let v = 0;
        try { v = (JSON.parse(ev.data) || {}).version || 0; } catch (e) {}
        if (v > SYNC.version) pullRemote();
      });
      es.onopen = function () { if (SYNC.mode === 'server') setSync('synced'); };
      es.onerror = function () { if (SYNC.mode === 'server') setSync('error'); };
      SYNC.es = es;
    } catch (e) {}
  }

  async function pullRemote() {
    if (SYNC.mode !== 'server') return;
    if (cur || drag) { SYNC.pending = true; return; }   // 正在编辑，关掉详情页后再同步
    try {
      const r = await fetch('api/data', { cache: 'no-store' });
      const j = await r.json();
      const remote = j.data ? normalizeDoc(j.data) : null;
      if (remote) {
        state = remote;
        SYNC.version = Number(j.version) || SYNC.version;
        renderBoard();
        if (qInput.value.trim()) renderSearch();
        toast('已同步其他设备的修改');
      }
      setSync('synced');
    } catch (e) {
      setSync('error');
    }
  }

  async function initSync() {
    if (!/^https?:/i.test(location.protocol)) { setSync('local'); return; }
    try {
      const r = await fetch('api/data', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      SYNC.mode = 'server';
      SYNC.version = Number(j.version) || 0;
      const remote = j.data ? normalizeDoc(j.data) : null;
      const localHas = state.buildings.some(function (b) { return b.merchants.length; });
      const remoteHas = !!(remote && remote.buildings.some(function (b) { return b.merchants.length; }));

      if (remote && (remoteHas || !localHas)) {
        // 服务器已有内容（或本机是空的）：以服务器为准
        state = remote;
        renderBoard();
        updateInfoChip();
      } else if (localHas) {
        // 服务器还空着，但本机有内容：先推上去，避免离线编辑丢失
        doPush();
      }
      setSync('synced');
      if (!/[?&]nosse=1/.test(location.search)) connectSSE();
    } catch (e) {
      SYNC.mode = 'local';
      setSync('local');
    }
  }

  /* ---------------- 底部统计 ---------------- */
  const infoChip = document.getElementById('infoChip');
  const infoText = document.getElementById('infoText');

  function updateInfoChip() {
    let n = 0;
    state.buildings.forEach(function (b) { n += b.merchants.length; });
    if (infoText) infoText.textContent = state.buildings.length + ' 栋 · ' + n + ' 家商户';
    else if (infoChip) infoChip.textContent = state.buildings.length + ' 栋 · ' + n + ' 家商户';
  }

  /* ---------------- 顶栏 ---------------- */
  const editBtn = document.getElementById('btnEdit');
  editBtn.addEventListener('click', function () {
    if (!AUTH.canEdit) { toast('登录后才能编辑'); return; }
    editMode = !editMode;
    document.body.classList.toggle('edit', editMode);
    editBtn.classList.toggle('on', editMode);
    renderBoard();
    toast(editMode ? '编辑模式：拖拽移动、拖右下角改大小、＋ 添加商户' : '已退出编辑模式');
  });

  document.getElementById('btnFit').addEventListener('click', fitAll);

  /* ---------------- 工具 ---------------- */
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  window.addEventListener('resize', function () {
    clampView();
    applyView();
  });

  /* ---------------- 启动 ---------------- */
  if (/[?&]edit=1/.test(location.search)) {
    editMode = true;
    document.body.classList.add('edit');
    document.getElementById('btnEdit').classList.add('on');
  }

  renderBoard();
  requestAnimationFrame(function () {
    fitWidth();
    setTimeout(function () { hintEl.classList.add('hide'); }, 7000);
  });
  initAuth().then(function () {
    return initSync();
  }).then(function () {
    if (location.hash) openByHash();
  });
  window.addEventListener('hashchange', openByHash);
})();

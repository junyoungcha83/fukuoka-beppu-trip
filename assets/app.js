// 후쿠오카·벳푸 여행 일정 PWA — state, sync, render (시간표/지도/경로/상세)

const STORAGE_KEY = 'fukuoka-beppu-trip-state-v1';
const TOKEN_KEY   = 'fukuoka-beppu-trip-edit-token';
const API_BASE    = 'https://fukuoka-beppu-trip-api.junyoung-cha83.workers.dev';
const SAVE_DEBOUNCE_MS = 800;

// MapTiler API 키 (한국어 지도). https://cloud.maptiler.com 에서 무료 발급(카드 불필요).
// 발급한 키로 아래 값을 교체하세요. 공개돼도 되지만 MapTiler 대시보드에서 도메인 제한 권장.
const MAPTILER_KEY = 'ce4eZGzm8lr8OI1nGEVz';

// 여행 일자 — 필요하면 여기만 늘리/줄이면 됨
const DAYS = [
  { id: 'd1', label: 'Day 1', short: 'D1' },
  { id: 'd2', label: 'Day 2', short: 'D2' },
  { id: 'd3', label: 'Day 3', short: 'D3' },
  { id: 'd4', label: 'Day 4', short: 'D4' },
  { id: 'd5', label: 'Day 5', short: 'D5' },
];

// 구분(종류) — 색상·아이콘이 시간표/지도/경로에 일관 적용
const KINDS = [
  { id: 'airport',  label: '공항', icon: '✈️', color: '#bae6fd' },
  { id: 'hotel',    label: '숙소', icon: '🏨', color: '#ddd6fe' },
  { id: 'sight',    label: '관광', icon: '🎡', color: '#fbcfe8' },
  { id: 'food',     label: '식당', icon: '🍜', color: '#fed7aa' },
  { id: 'shopping', label: '쇼핑', icon: '👠', color: '#fde68a' },
];
const KIND_MAP = Object.fromEntries(KINDS.map(k => [k.id, k]));
function kindOf(id) { return KIND_MAP[id] || KINDS[0]; }

function DEFAULT_STATE() { return { version: 1, entries: [] }; }

let state = DEFAULT_STATE();
let activeTab = 'grid';   // 'grid' | 'map' | 'route' | 'detail'
let activeDay = 'all';    // 'all' | 'd1'... (지도·경로 필터)

// ── 유틸 ─────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }
function nextId() {
  const max = state.entries.reduce((m, e) => {
    const n = parseInt(String(e.id || '').replace(/\D/g, '')) || 0;
    return Math.max(m, n);
  }, 0);
  return 'e' + (max + 1);
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

// HH:mm → 분 (정수). 잘못된 입력이면 null
function parseTimeMin(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}
// 분 → HH:mm
function fmtMin(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
}
function parseNum(s) {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── 영속화 ─────────────────────────────────────────
let _saveTimer = null;
let _saveCtrl  = null;
let _syncStatus = 'idle';
let _refreshInFlight = false;

function setSyncStatus(s) {
  _syncStatus = s;
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const map = {
    idle:        { text: '',         cls: '' },
    pending:     { text: '변경됨',    cls: 'pending' },
    saving:      { text: '저장중…',   cls: 'saving' },
    saved:       { text: '저장됨 ✓',  cls: 'saved' },
    error:       { text: '오프라인',  cls: 'error' },
    unauthorized:{ text: '토큰 오류', cls: 'error' },
    readonly:    { text: '읽기전용',  cls: 'readonly' },
  };
  const m = map[s] || map.idle;
  el.textContent = m.text;
  el.className = 'sync-status ' + m.cls;
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch (e) {}
  return null;
}

function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { alert('localStorage 저장 실패 — 용량 초과 가능성'); }

  const token = getEditToken();
  if (!token) { setSyncStatus('readonly'); return; }

  setSyncStatus('pending');
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; pushToServer(); }, SAVE_DEBOUNCE_MS);
}

async function pushToServer() {
  const token = getEditToken();
  if (!token) return;
  if (_saveCtrl) _saveCtrl.abort();
  _saveCtrl = new AbortController();
  setSyncStatus('saving');
  try {
    const res = await fetch(`${API_BASE}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token },
      body: JSON.stringify(state),
      signal: _saveCtrl.signal,
    });
    if (res.ok) setSyncStatus('saved');
    else if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      updateEditUI();
      setSyncStatus('unauthorized');
      alert('편집 비밀번호가 잘못됐습니다 — 다시 입력하세요.');
    }
    else if (res.status === 413) {
      setSyncStatus('error');
      alert('데이터 크기 초과');
    }
    else setSyncStatus('error');
  } catch (e) {
    if (e.name !== 'AbortError') setSyncStatus('error');
  }
}

async function fetchFromServer() {
  try {
    const res = await fetch(`${API_BASE}/api/data`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    if (json && Array.isArray(json.entries)) return json;
  } catch (e) {}
  return null;
}

async function loadInitial() {
  const remote = await fetchFromServer();
  if (remote) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(remote)); } catch (e) {}
    return migrate(remote);
  }
  const local = loadLocal();
  if (local) return migrate(local);
  try {
    const res = await fetch('data/default.json?t=' + Date.now());
    if (res.ok) {
      const json = await res.json();
      if (json) return migrate(json);
    }
  } catch (e) {}
  return DEFAULT_STATE();
}

function migrate(loaded) {
  if (!loaded || !Array.isArray(loaded.entries)) return DEFAULT_STATE();
  loaded.version = loaded.version || 1;
  for (const e of loaded.entries) {
    e.day   = DAYS.some(d => d.id === e.day) ? e.day : 'd1';
    e.kind  = KINDS.some(k => k.id === e.kind) ? e.kind : 'sight';
    e.place = typeof e.place === 'string' ? e.place : '';
    e.start = typeof e.start === 'string' ? e.start : '';
    e.end   = typeof e.end   === 'string' ? e.end   : '';
    e.memo  = typeof e.memo  === 'string' ? e.memo  : '';
    e.lat   = (typeof e.lat === 'number') ? e.lat : (parseNum(e.lat));
    e.lng   = (typeof e.lng === 'number') ? e.lng : (parseNum(e.lng));
    e.created_at = e.created_at || nowIso();
    e.updated_at = e.updated_at || e.created_at;
  }
  return loaded;
}

async function refreshFromServerNow({ manual = false } = {}) {
  if (_refreshInFlight) return;
  if (!manual && (_syncStatus === 'pending' || _syncStatus === 'saving')) return;
  _refreshInFlight = true;
  if (manual) setSyncStatus('saving');
  try {
    const hadPending = !!_saveTimer || _syncStatus === 'pending' || _syncStatus === 'saving';
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    if (_syncStatus === 'pending' || _syncStatus === 'saving') await pushToServer();
    if (hadPending) {
      if (manual && _syncStatus !== 'error' && _syncStatus !== 'unauthorized') {
        setSyncStatus(getEditToken() ? 'saved' : 'readonly');
      }
      render();
      return;
    }
    const remote = await fetchFromServer();
    if (!remote) { if (manual) setSyncStatus('error'); return; }
    state = migrate(remote);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    if (manual) setSyncStatus(getEditToken() ? 'saved' : 'readonly');
    render();
  } finally {
    _refreshInFlight = false;
  }
}

async function manualSave() {
  const btn = document.getElementById('btnSave');
  if (!btn) return;
  if (!getEditToken()) {
    if (confirm('편집 모드가 아닙니다. 비밀번호를 입력하시겠습니까?')) {
      promptEditToken();
    }
    return;
  }
  btn.disabled = true;
  btn.classList.remove('saved', 'error');
  const original = btn.textContent;
  btn.textContent = '저장중…';
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  await pushToServer();
  btn.disabled = false;
  if (_syncStatus === 'saved') {
    btn.classList.add('saved');
    btn.textContent = '저장됨 ✓';
    setTimeout(() => { btn.classList.remove('saved'); btn.textContent = '저장'; }, 1500);
  } else if (_syncStatus === 'error') {
    btn.classList.add('error');
    btn.textContent = '오프라인';
    setTimeout(() => { btn.classList.remove('error'); btn.textContent = '저장'; }, 2000);
  } else {
    btn.textContent = original;
  }
}

// ── 편집 토큰 ─────────────────────────────────
function getEditToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function promptEditToken() {
  const cur = getEditToken();
  const v = prompt(cur ? '편집 비밀번호 (비우면 로그아웃):' : '편집 비밀번호를 입력하세요:', cur);
  if (v === null) return;
  if (v === '') localStorage.removeItem(TOKEN_KEY);
  else          localStorage.setItem(TOKEN_KEY, v.trim());
  updateEditUI();
  if (getEditToken()) pushToServer();
  else setSyncStatus('readonly');
  render();
}
function updateEditUI() {
  const has = !!getEditToken();
  document.body.classList.toggle('read-only', !has);
  const btn = document.getElementById('btnEdit');
  if (btn) {
    btn.textContent = has ? '🔓' : '🔒';
    btn.classList.toggle('active', has);
  }
  if (!has) setSyncStatus('readonly');
}

// ── 탭 / 미니탭(일자) ─────────────────────────────
const TABS = ['grid', 'map', 'route', 'detail'];
function setActiveTab(t) {
  if (!TABS.includes(t)) return;
  activeTab = t;
  document.querySelectorAll('.top-tab').forEach(b => {
    const on = b.dataset.tab === t;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('hidden', p.dataset.tab !== t);
  });
  renderMiniTabs();
  render();
}
function setActiveDay(d) {
  activeDay = d;
  renderMiniTabs();
  render();
}
// entry 가 있는 일자만
function populatedDays() {
  return DAYS.filter(d => state.entries.some(e => e.day === d.id));
}
function renderMiniTabs() {
  const bar = document.getElementById('miniTabs');
  // 지도·경로 탭에서만 일자 필터 노출
  if (activeTab !== 'map' && activeTab !== 'route') {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  const days = populatedDays();
  if (!days.some(d => d.id === activeDay)) activeDay = 'all';
  const list = [{ id: 'all', label: '전체' }, ...days];
  bar.innerHTML = list.map(c =>
    `<button class="mini-tab${c.id === activeDay ? ' active' : ''}" data-day="${c.id}">${escapeAttr(c.label)}</button>`
  ).join('');
  bar.querySelectorAll('.mini-tab').forEach(b => {
    b.onclick = () => setActiveDay(b.dataset.day);
  });
}

// ── 렌더 디스패치 ─────────────────────────────────
function render() {
  if      (activeTab === 'grid')   renderGrid();
  else if (activeTab === 'map')    renderMap();
  else if (activeTab === 'route')  renderRoute();
  else                             renderDetail();
}

// ── 상세(입력) 탭 ───────────────────────────────
function renderDetail() {
  const root = document.getElementById('detailList');
  root.innerHTML = '';
  const canEdit = !!getEditToken();
  for (const day of DAYS) {
    const dayEntries = state.entries
      .filter(e => e.day === day.id)
      .slice()
      .sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    const showEmptyDefault = canEdit && dayEntries.length === 0;

    const section = document.createElement('section');
    section.className = 'day-section';
    section.innerHTML = `
      <div class="day-header">
        <span class="day-name">${day.label}</span>
        <button class="btn-add" data-day="${day.id}">+ 추가</button>
      </div>
      <div class="day-rows" data-day="${day.id}"></div>
    `;
    const rowsEl = section.querySelector('.day-rows');
    if (showEmptyDefault) {
      rowsEl.appendChild(makeRowCard(null, day.id));
    } else {
      dayEntries.forEach(e => rowsEl.appendChild(makeRowCard(e, day.id)));
    }
    section.querySelector('.btn-add').onclick = () => {
      if (!canEdit) { alert('편집 모드에서만 추가할 수 있습니다.'); return; }
      addEntry(day.id);
    };
    root.appendChild(section);
  }
}

function makeRowCard(entry, dayId) {
  const card = document.createElement('div');
  card.className = 'row-card';
  if (entry) card.dataset.id = entry.id;
  const e = entry || { kind: 'sight', place: '', start: '', end: '', memo: '', lat: null, lng: null };
  card.style.borderLeftColor = kindOf(e.kind).color;

  card.innerHTML = `
    <button class="row-delete" title="삭제" aria-label="삭제">×</button>
    <div class="row-row">
      <select class="f-kind" aria-label="구분">
        ${KINDS.map(k => `<option value="${k.id}"${k.id === e.kind ? ' selected' : ''}>${k.icon} ${k.label}</option>`).join('')}
      </select>
      <input class="f-place" type="text" placeholder="장소" aria-label="장소" value="${escapeAttr(e.place)}" />
    </div>
    <div class="row-row">
      <input class="f-start" type="time" aria-label="시작" value="${escapeAttr(e.start)}" />
      <input class="f-end" type="time" aria-label="종료(선택)" value="${escapeAttr(e.end)}" />
      <input class="f-memo" type="text" placeholder="메모 (선택)" aria-label="메모" value="${escapeAttr(e.memo)}" />
    </div>
    <div class="row-row geo-row">
      <input class="f-lat" type="text" inputmode="decimal" placeholder="위도 lat" aria-label="위도" value="${e.lat == null ? '' : escapeAttr(e.lat)}" />
      <input class="f-lng" type="text" inputmode="decimal" placeholder="경도 lng" aria-label="경도" value="${e.lng == null ? '' : escapeAttr(e.lng)}" />
      <button type="button" class="btn-geo" title="장소명으로 좌표 찾기">📍 좌표</button>
    </div>
  `;

  const textFields = ['kind', 'place', 'start', 'end', 'memo'];
  textFields.forEach(f => {
    const sel = card.querySelector('.f-' + f);
    const handler = () => {
      ensureEntry(card, dayId);
      const target = findEntry(card.dataset.id);
      if (!target) return;
      target[f] = sel.value;
      target.updated_at = nowIso();
      if (f === 'kind') card.style.borderLeftColor = kindOf(sel.value).color;
      saveLocal();
    };
    sel.addEventListener('input', handler);
    if (sel.tagName === 'SELECT') sel.addEventListener('change', handler);
  });

  ['lat', 'lng'].forEach(f => {
    const inp = card.querySelector('.f-' + f);
    inp.addEventListener('input', () => {
      ensureEntry(card, dayId);
      const target = findEntry(card.dataset.id);
      if (!target) return;
      target[f] = parseNum(inp.value);
      target.updated_at = nowIso();
      saveLocal();
    });
  });

  card.querySelector('.btn-geo').onclick = () => geocodeRow(card, dayId);

  card.querySelector('.row-delete').onclick = () => {
    const id = card.dataset.id;
    if (!id) { card.remove(); return; }
    if (!confirm('이 항목을 삭제할까요?')) return;
    state.entries = state.entries.filter(x => x.id !== id);
    saveLocal();
    renderDetail();
  };

  return card;
}

// 장소명 → 좌표 (OpenStreetMap Nominatim, best-effort)
async function geocodeRow(card, dayId) {
  const place = card.querySelector('.f-place').value.trim();
  if (!place) { alert('먼저 장소명을 입력하세요.'); return; }
  const btn = card.querySelector('.btn-geo');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = '검색중…';
  try {
    const q = encodeURIComponent(place + ' 일본');
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`, {
      headers: { 'Accept': 'application/json' },
    });
    const arr = await res.json();
    if (Array.isArray(arr) && arr.length) {
      const lat = parseFloat(arr[0].lat), lng = parseFloat(arr[0].lon);
      card.querySelector('.f-lat').value = lat;
      card.querySelector('.f-lng').value = lng;
      ensureEntry(card, dayId);
      const target = findEntry(card.dataset.id);
      if (target) { target.lat = lat; target.lng = lng; target.updated_at = nowIso(); saveLocal(); }
      btn.textContent = '찾음 ✓';
    } else {
      btn.textContent = '못 찾음';
    }
  } catch (e) {
    btn.textContent = '오류';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1500);
}

function ensureEntry(card, dayId) {
  if (card.dataset.id) return;
  const id = nextId();
  card.dataset.id = id;
  const ts = nowIso();
  state.entries.push({
    id, day: dayId,
    kind: card.querySelector('.f-kind').value,
    place: '', start: '', end: '', memo: '', lat: null, lng: null,
    created_at: ts, updated_at: ts,
  });
}
function findEntry(id) { return state.entries.find(e => e.id === id); }
function addEntry(dayId) {
  const id = nextId();
  const ts = nowIso();
  state.entries.push({
    id, day: dayId, kind: 'sight',
    place: '', start: '', end: '', memo: '', lat: null, lng: null,
    created_at: ts, updated_at: ts,
  });
  saveLocal();
  renderDetail();
  const el = document.querySelector(`.row-card[data-id="${id}"] .f-place`);
  if (el) el.focus();
}

// ── 시간표 격자 ─────────────────────────────────
function renderGrid() {
  const wrap = document.getElementById('gridWrap');
  wrap.innerHTML = '';

  const usedDays = DAYS.filter(d =>
    state.entries.some(e => e.day === d.id && parseTimeMin(e.start) != null && e.place && e.place.trim())
  );
  if (usedDays.length === 0) {
    wrap.innerHTML = `<div class="grid-empty">아직 표시할 일정이 없습니다.<br/>
      <small>상세 탭에서 <strong>장소·시작 시간</strong>을 입력하면 시간표에 나타납니다.</small></div>`;
    return;
  }

  // 한 칸 = 30분
  const SLOT = 30;
  const snap30 = m => { const r = ((m % SLOT) + SLOT) % SLOT; return r <= 15 ? m - r : m - r + SLOT; };
  // 블록 종료: end 없으면 start+90분
  const blockEnd = e => {
    const s = parseTimeMin(e.start);
    const x = parseTimeMin(e.end);
    return (x != null && x > s) ? x : s + 90;
  };
  const items = state.entries.filter(e =>
    usedDays.some(d => d.id === e.day) && parseTimeMin(e.start) != null && e.place && e.place.trim()
  );

  let minT = Math.min(...items.map(e => snap30(parseTimeMin(e.start))));
  let maxT = Math.max(...items.map(e => snap30(blockEnd(e))));
  if (maxT - minT < SLOT * 4) maxT = minT + SLOT * 4;
  const slots = Math.round((maxT - minT) / SLOT);

  const tt = document.createElement('div');
  tt.className = 'timetable';
  tt.style.gridTemplateColumns = `44px repeat(${usedDays.length}, 1fr)`;
  tt.style.gridTemplateRows = `auto repeat(${slots}, 40px)`;

  let html = '';
  html += `<div class="tt-cell tt-head" style="grid-column:1;grid-row:1"></div>`;
  usedDays.forEach((d, di) => {
    html += `<div class="tt-cell tt-head" style="grid-column:${di + 2};grid-row:1">${d.short}</div>`;
  });
  for (let i = 0; i < slots; i++) {
    const row = i + 2;
    const t = minT + i * SLOT;
    const minOfHour = t % 60;
    let label = '', cls = '';
    if (minOfHour === 0)       { label = fmtMin(t); cls = ' hour'; }
    else if (minOfHour === 30) { label = '30';      cls = ' half'; }
    html += `<div class="tt-cell tt-time${cls}" style="grid-column:1;grid-row:${row}">${label}</div>`;
    for (let d = 0; d < usedDays.length; d++) {
      html += `<div class="tt-cell" style="grid-column:${d + 2};grid-row:${row}"></div>`;
    }
  }
  tt.innerHTML = html;
  wrap.appendChild(tt);

  for (const e of items) {
    const s = parseTimeMin(e.start);
    const x = blockEnd(e);
    const rowStart = Math.round((snap30(s) - minT) / SLOT) + 2;
    const rowEnd   = Math.max(rowStart + 1, Math.round((snap30(x) - minT) / SLOT) + 2);
    const dayIdx = usedDays.findIndex(d => d.id === e.day);
    if (dayIdx < 0) continue;
    const k = kindOf(e.kind);

    const div = document.createElement('div');
    div.className = 'tt-entry';
    div.style.gridRow = `${rowStart} / ${rowEnd}`;
    div.style.gridColumn = `${dayIdx + 2}`;
    div.style.background = k.color;
    div.innerHTML =
      `<span class="tt-time-range">${escapeAttr(e.start)}${e.end ? '~' + escapeAttr(e.end) : ''}</span>` +
      `<strong>${k.icon} ${escapeAttr(e.place)}</strong>` +
      (e.memo ? `<small>${escapeAttr(e.memo)}</small>` : '');
    tt.appendChild(div);
  }

  for (let i = 1; i < slots; i++) {
    const t = minT + i * SLOT;
    if (t % 60 !== 0) continue;
    const line = document.createElement('div');
    line.className = 'tt-hour-line';
    line.style.gridRow = String(i + 2);
    line.style.gridColumn = '1 / -1';
    tt.appendChild(line);
  }
}

// ── 지도 탭 (MapTiler SDK, 한국어 라벨) ──────────
let _map = null;
let _mapReady = false;
let _markers = [];

function renderMap() {
  const legend = document.getElementById('mapLegend');
  legend.innerHTML = KINDS.map(k =>
    `<span class="legend-item"><span class="legend-dot" style="background:${k.color}"></span>${k.icon} ${k.label}</span>`
  ).join('');

  const box = document.getElementById('map');
  if (typeof maptilersdk === 'undefined') {
    box.innerHTML = '<div class="grid-empty">지도 라이브러리를 불러오지 못했습니다 (네트워크 확인).</div>';
    return;
  }
  if (!MAPTILER_KEY || MAPTILER_KEY === 'REPLACE_WITH_MAPTILER_KEY') {
    box.innerHTML = '<div class="grid-empty">MapTiler 키가 설정되지 않았습니다.<br/>' +
      '<small>cloud.maptiler.com 에서 무료 키를 발급해 app.js 의 <strong>MAPTILER_KEY</strong> 에 넣으세요.</small></div>';
    return;
  }

  if (!_map) {
    maptilersdk.config.apiKey = MAPTILER_KEY;
    const KO = (maptilersdk.Language && maptilersdk.Language.KOREAN) || 'ko';
    maptilersdk.config.primaryLanguage = KO;
    const opts = {
      container: 'map',
      center: [130.95, 33.45],   // [lng, lat] — 후쿠오카·벳푸 중간
      zoom: 8,
      language: KO,
    };
    if (maptilersdk.MapStyle && maptilersdk.MapStyle.STREETS) opts.style = maptilersdk.MapStyle.STREETS;
    _map = new maptilersdk.Map(opts);
    _map.on('load', () => { _mapReady = true; drawMarkers(); });
  } else {
    // 패널이 다시 표시된 직후 — 크기 재계산
    setTimeout(() => _map.resize(), 50);
    if (_mapReady) drawMarkers();
  }
}

function drawMarkers() {
  if (!_map) return;
  _markers.forEach(m => m.remove());
  _markers = [];
  const pts = state.entries.filter(e =>
    typeof e.lat === 'number' && typeof e.lng === 'number' &&
    (activeDay === 'all' || e.day === activeDay)
  );

  let bounds = null;
  for (const e of pts) {
    const k = kindOf(e.kind);
    const dLabel = (DAYS.find(d => d.id === e.day) || {}).short || '';

    const el = document.createElement('div');
    el.className = 'mt-marker';
    el.innerHTML =
      `<div class="mt-pin" style="background:${k.color}"><span>${k.icon}</span></div>` +
      `<div class="mt-label">${e.start ? escapeAttr(e.start) + ' ' : ''}${escapeAttr(e.place)}</div>`;

    const popup = new maptilersdk.Popup({ offset: 28, closeButton: false }).setHTML(
      `<b>${k.icon} ${escapeAttr(e.place)}</b><br/>` +
      `${dLabel}${e.start ? ' · ' + escapeAttr(e.start) : ''}${e.end ? '~' + escapeAttr(e.end) : ''}` +
      (e.memo ? `<br/>${escapeAttr(e.memo)}` : '')
    );
    const mk = new maptilersdk.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([e.lng, e.lat])
      .setPopup(popup)
      .addTo(_map);
    _markers.push(mk);

    if (!bounds) bounds = new maptilersdk.LngLatBounds([e.lng, e.lat], [e.lng, e.lat]);
    else bounds.extend([e.lng, e.lat]);
  }
  if (pts.length === 1) _map.flyTo({ center: [pts[0].lng, pts[0].lat], zoom: 13 });
  else if (bounds) _map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 0 });
}

// ── 경로 탭 (일자별 타임라인) ────────────────────
function renderRoute() {
  const wrap = document.getElementById('routeWrap');
  wrap.innerHTML = '';
  const days = (activeDay === 'all' ? populatedDays() : DAYS.filter(d => d.id === activeDay));
  if (days.length === 0) {
    wrap.innerHTML = `<div class="grid-empty">아직 일정이 없습니다.<br/><small>상세 탭에서 추가하세요.</small></div>`;
    return;
  }
  for (const day of days) {
    const items = state.entries
      .filter(e => e.day === day.id && e.place && e.place.trim())
      .slice()
      .sort((a, b) => (a.start || '99:99').localeCompare(b.start || '99:99'));
    if (items.length === 0) continue;

    const sec = document.createElement('section');
    sec.className = 'route-day';
    sec.innerHTML = `<h2 class="route-day-title">${day.label}</h2>`;
    const tl = document.createElement('div');
    tl.className = 'timeline';
    for (const e of items) {
      const k = kindOf(e.kind);
      const node = document.createElement('div');
      node.className = 'tl-node';
      node.innerHTML = `
        <div class="tl-dot" style="background:${k.color}">${k.icon}</div>
        <div class="tl-body">
          <div class="tl-head">
            ${e.start ? `<span class="tl-time">${escapeAttr(e.start)}${e.end ? '~' + escapeAttr(e.end) : ''}</span>` : ''}
            <span class="tl-place">${escapeAttr(e.place)}</span>
            <span class="tl-kind">${k.label}</span>
          </div>
          ${e.memo ? `<div class="tl-memo">${escapeAttr(e.memo)}</div>` : ''}
        </div>`;
      tl.appendChild(node);
    }
    sec.appendChild(tl);
    wrap.appendChild(sec);
  }
  if (!wrap.children.length) {
    wrap.innerHTML = `<div class="grid-empty">표시할 일정이 없습니다.</div>`;
  }
}

// ── 부트 ─────────────────────────────────────────
async function bootstrap() {
  document.querySelectorAll('.top-tab').forEach(b => {
    b.onclick = () => setActiveTab(b.dataset.tab);
  });
  document.getElementById('btnEdit').onclick = promptEditToken;
  document.getElementById('btnSave').onclick = manualSave;

  state = await loadInitial();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  updateEditUI();
  renderMiniTabs();
  render();
}

document.addEventListener('DOMContentLoaded', bootstrap);

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

// 경로(스네이크) 일자별 색 — 위(Day1, 연함) → 아래(Day5, 진함)
const DAY_COLORS = ['#e6b8a2', '#df9b86', '#d57c80', '#c45f74', '#9c2f63'];
function dayColor(ci) { return DAY_COLORS[Math.min(Math.max(ci, 0), DAY_COLORS.length - 1)]; }
// 지도 시간순 연속 경로선 색
const ROUTE_LINE_COLOR = '#e11d48';

// 커스텀 아이콘 선택 세트 (항목별 e.icon 으로 저장; 미지정 시 종류 기본)
const ICON_SET = [
  // 이동
  '✈️','🛫','🛬','🚄','🚅','🚆','🚇','🚌','🚕','🚗','🚙','🚢','⛴️','⛵','🚲','🛵','🚠','🚡',
  // 숙소
  '🏨','🏩','🏠','🏡','⛺','🛌','🔑',
  // 명소/관광
  '🗼','🗽','🏯','🏰','⛩️','🕌','⛲','🎡','🎢','🎠','🎆','🎇','🏟️','🎭','🖼️','🎨','📷','🗺️','📍','⛳','♨️','🧖',
  // 자연
  '🏖️','🏝️','🌊','⛱️','🗻','🏔️','⛰️','🌋','🏞️','🌅','🌉','🌸','🍁','🌴',
  // 동물
  '🦌','🐒','🐬','🐠','🦀','🕊️',
  // 음식/카페
  '🍜','🍣','🍱','🍙','🍢','🍡','🍤','🍲','🍛','🥘','🍖','🍗','🥩','🍕','🍔','🥟','🍶','🍺','🍻','☕','🍵','🧋','🍰','🧁','🍦','🍧','🍩','🍓',
  // 쇼핑/기타
  '🛍️','👜','👠','👟','👕','🧢','🛒','💄','🎁','💴','🏧','🎫',
];
// 항목의 실제 표시 아이콘 — 커스텀 우선, 없으면 종류 기본
function entryIcon(e) { return (e && e.icon && e.icon.trim()) ? e.icon : kindOf(e ? e.kind : '').icon; }

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
    e.icon  = typeof e.icon === 'string' ? e.icon : '';
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
      <button type="button" class="f-icon" title="아이콘 선택" aria-label="아이콘 선택">${entryIcon(e)}</button>
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
      <button type="button" class="btn-map" title="지도에서 검색·선택">🗺️ 지도</button>
      <button type="button" class="btn-geo" title="장소명으로 좌표 자동 찾기">📍 자동</button>
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
      if (f === 'kind') {
        card.style.borderLeftColor = kindOf(sel.value).color;
        if (!target.icon) card.querySelector('.f-icon').textContent = kindOf(sel.value).icon;
      }
      saveLocal();
    };
    sel.addEventListener('input', handler);
    if (sel.tagName === 'SELECT') sel.addEventListener('change', handler);
  });

  card.querySelector('.f-icon').onclick = () => openIconPicker(card, dayId);

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
  card.querySelector('.btn-map').onclick = () => openMapPicker(card, dayId);

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

// ── 아이콘 선택 팝업 ───────────────────────────
let _pickerEl = null;
let _pickerTarget = null;
function ensurePickerEl() {
  if (_pickerEl) return;
  _pickerEl = document.createElement('div');
  _pickerEl.className = 'icon-picker hidden';
  _pickerEl.innerHTML = `<div class="ip-panel">
    <div class="ip-head"><span>아이콘 선택</span><button class="ip-close" aria-label="닫기">×</button></div>
    <div class="ip-grid">
      <button class="ip-cell ip-reset" data-icon="">기본</button>
      ${ICON_SET.map(ic => `<button class="ip-cell" data-icon="${ic}">${ic}</button>`).join('')}
    </div></div>`;
  document.body.appendChild(_pickerEl);
  _pickerEl.addEventListener('click', e => {
    if (e.target === _pickerEl || e.target.classList.contains('ip-close')) {
      _pickerEl.classList.add('hidden'); return;
    }
    const cell = e.target.closest('.ip-cell');
    if (!cell || !_pickerTarget) return;
    const target = findEntry(_pickerTarget.id);
    if (target) {
      target.icon = cell.dataset.icon || '';
      target.updated_at = nowIso();
      const btn = _pickerTarget.card.querySelector('.f-icon');
      if (btn) btn.textContent = entryIcon(target);
      saveLocal();
    }
    _pickerEl.classList.add('hidden');
  });
}
function openIconPicker(card, dayId) {
  if (!getEditToken()) { alert('편집 모드에서만 변경할 수 있습니다.'); return; }
  ensureEntry(card, dayId);
  ensurePickerEl();
  _pickerTarget = { card, id: card.dataset.id };
  _pickerEl.classList.remove('hidden');
}

// 한국어 라벨 언어값 (MapTiler)
function koLang() {
  return (typeof maptilersdk !== 'undefined' && maptilersdk.Language && maptilersdk.Language.KOREAN) || 'ko';
}

// 장소 검색 → 후보 목록 [{lat,lng,name}]. MapTiler(한국어) 우선, 실패 시 Nominatim 폴백.
async function geocodeSearch(q) {
  if (!q || !q.trim()) return [];
  // 1) MapTiler 지오코딩 — 같은 키, 한국어, 일본 한정, 규슈 근방 우선
  if (MAPTILER_KEY && MAPTILER_KEY !== 'REPLACE_WITH_MAPTILER_KEY') {
    try {
      const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json` +
        `?key=${MAPTILER_KEY}&language=ko&country=jp&proximity=130.8,33.5&limit=5`;
      const res = await fetch(url);
      const d = await res.json();
      const fs = (d.features || [])
        .filter(f => Array.isArray(f.center) && f.center.length === 2)
        .map(f => ({ lng: f.center[0], lat: f.center[1], name: f.place_name || f.text || q }));
      if (fs.length) return fs;
    } catch (e) {}
  }
  // 2) Nominatim 폴백
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=jp&accept-language=ko&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const arr = await res.json();
    if (Array.isArray(arr)) {
      return arr.map(x => ({ lat: parseFloat(x.lat), lng: parseFloat(x.lon), name: x.display_name || q }));
    }
  } catch (e) {}
  return [];
}
async function geocodeFirst(q) {
  const list = await geocodeSearch(q);
  return list.length ? list[0] : null;
}

// 빠른 자동 좌표 — 장소명으로 바로 채움 (📍 버튼)
async function geocodeRow(card, dayId) {
  const place = card.querySelector('.f-place').value.trim();
  if (!place) { alert('먼저 장소명을 입력하세요.'); return; }
  const btn = card.querySelector('.btn-geo');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = '검색중…';
  const r = await geocodeFirst(place);
  if (r) {
    card.querySelector('.f-lat').value = r.lat;
    card.querySelector('.f-lng').value = r.lng;
    ensureEntry(card, dayId);
    const target = findEntry(card.dataset.id);
    if (target) { target.lat = r.lat; target.lng = r.lng; target.updated_at = nowIso(); saveLocal(); }
    btn.textContent = '찾음 ✓';
  } else {
    btn.textContent = '못 찾음';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1500);
}

// ── 지도 위치 선택기 (검색 + 탭/롱프레스로 좌표 지정) ──────────
let _mpEl = null, _mpMap = null, _mpMarker = null, _mpCoord = null, _mpTarget = null;

function ensureMapPickerEl() {
  if (_mpEl) return;
  _mpEl = document.createElement('div');
  _mpEl.className = 'map-picker hidden';
  _mpEl.innerHTML = `
    <div class="mp-head"><span>지도에서 위치 선택</span><button class="mp-close" aria-label="닫기">×</button></div>
    <div class="mp-search">
      <input class="mp-q" type="text" placeholder="장소 검색 (예: 후쿠오카 텐진 지하상가)" />
      <button class="mp-go" type="button">검색</button>
    </div>
    <div class="mp-results hidden"></div>
    <div id="mp-map" class="mp-map"></div>
    <div class="mp-foot">
      <span class="mp-coord"></span>
      <button class="mp-confirm" type="button" disabled>이 위치로 선택</button>
    </div>`;
  document.body.appendChild(_mpEl);
  _mpEl.querySelector('.mp-close').onclick = closeMapPicker;
  _mpEl.querySelector('.mp-go').onclick = pickerSearch;
  _mpEl.querySelector('.mp-q').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); pickerSearch(); }
  });
  _mpEl.querySelector('.mp-confirm').onclick = confirmMapPicker;
}

function initPickerMap() {
  if (_mpMap || typeof maptilersdk === 'undefined') return;
  maptilersdk.config.apiKey = MAPTILER_KEY;
  maptilersdk.config.primaryLanguage = koLang();   // 한국어 라벨
  const opts = { container: 'mp-map', center: [130.4017, 33.5902], zoom: 11, language: koLang() };
  if (maptilersdk.MapStyle && maptilersdk.MapStyle.STREETS) opts.style = maptilersdk.MapStyle.STREETS;
  _mpMap = new maptilersdk.Map(opts);
  const place = e => setPickerMarker(e.lngLat.lng, e.lngLat.lat);
  _mpMap.on('click', place);        // 탭
  _mpMap.on('contextmenu', place);  // 롱프레스 / 우클릭
}

function setPickerMarker(lng, lat) {
  _mpCoord = { lng, lat };
  const box = _mpEl && _mpEl.querySelector('.mp-results');
  if (box) box.classList.add('hidden');   // 지점 확정되면 후보 목록 닫음
  if (!_mpMarker) {
    _mpMarker = new maptilersdk.Marker({ draggable: true, color: '#0ea5e9' }).setLngLat([lng, lat]).addTo(_mpMap);
    _mpMarker.on('dragend', () => { const p = _mpMarker.getLngLat(); _mpCoord = { lng: p.lng, lat: p.lat }; updatePickerFoot(); });
  } else {
    _mpMarker.setLngLat([lng, lat]);
  }
  updatePickerFoot();
}

function updatePickerFoot() {
  const coordEl = _mpEl.querySelector('.mp-coord');
  const btn = _mpEl.querySelector('.mp-confirm');
  if (_mpCoord) {
    coordEl.textContent = `위도 ${_mpCoord.lat.toFixed(5)}, 경도 ${_mpCoord.lng.toFixed(5)}`;
    btn.disabled = false;
  } else {
    coordEl.textContent = '지도를 탭하거나 길게 눌러 위치를 지정하세요';
    btn.disabled = true;
  }
}

function renderPickerResults(list) {
  const box = _mpEl.querySelector('.mp-results');
  if (!list.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.innerHTML = list.map((r, i) => `<button class="mp-res" data-i="${i}">${escapeAttr(r.name)}</button>`).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.mp-res').forEach(b => {
    b.onclick = () => {
      const r = list[+b.dataset.i];
      _mpMap.flyTo({ center: [r.lng, r.lat], zoom: 16, duration: 0 });
      setPickerMarker(r.lng, r.lat);   // 결과 선택 = 그 지점에 마커
    };
  });
}

async function pickerSearch() {
  const input = _mpEl.querySelector('.mp-q'), btn = _mpEl.querySelector('.mp-go');
  const q = input.value.trim();
  if (!q) return;
  btn.disabled = true; const o = btn.textContent; btn.textContent = '검색중…';
  const list = await geocodeSearch(q);
  btn.disabled = false; btn.textContent = o;
  if (!list.length || !_mpMap) {
    renderPickerResults([]);
    alert('검색 결과가 없습니다. 더 일반적인 이름으로 검색하거나, 지도를 직접 눌러 위치를 지정하세요.');
    return;
  }
  // 첫 결과로 이동(미리보기) + 후보 목록 표시 — 목록/지도에서 정확한 지점 선택
  _mpMap.flyTo({ center: [list[0].lng, list[0].lat], zoom: 14, duration: 0 });
  renderPickerResults(list);
}

function openMapPicker(card, dayId) {
  if (!getEditToken()) { alert('편집 모드에서만 변경할 수 있습니다.'); return; }
  if (typeof maptilersdk === 'undefined') { alert('지도를 불러오지 못했습니다 (네트워크 확인).'); return; }
  ensureEntry(card, dayId);
  ensureMapPickerEl();
  _mpTarget = { card, id: card.dataset.id };
  _mpEl.classList.remove('hidden');
  initPickerMap();
  const t = findEntry(_mpTarget.id);
  _mpEl.querySelector('.mp-q').value = (t && t.place) || '';
  setTimeout(() => {
    _mpMap.resize();
    if (t && typeof t.lat === 'number' && typeof t.lng === 'number') {
      _mpMap.jumpTo({ center: [t.lng, t.lat], zoom: 15 });
      setPickerMarker(t.lng, t.lat);
    } else {
      _mpCoord = null;
      if (_mpMarker) { _mpMarker.remove(); _mpMarker = null; }
      updatePickerFoot();
    }
  }, 80);
}

function closeMapPicker() { if (_mpEl) _mpEl.classList.add('hidden'); }

function confirmMapPicker() {
  if (!_mpCoord || !_mpTarget) return;
  const t = findEntry(_mpTarget.id);
  if (t) {
    t.lat = _mpCoord.lat; t.lng = _mpCoord.lng; t.updated_at = nowIso();
    saveLocal();
    const card = _mpTarget.card;
    card.querySelector('.f-lat').value = _mpCoord.lat.toFixed(6);
    card.querySelector('.f-lng').value = _mpCoord.lng.toFixed(6);
  }
  closeMapPicker();
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
      `<strong>${entryIcon(e)} ${escapeAttr(e.place)}</strong>` +
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
    window._tripMap = _map;   // 디버그/확장용
    _map.on('load', () => {
      _mapReady = true;
      // 시간순 경로선 (일자 색상, 반투명 실선) — 흰 케이싱 위에 컬러 선
      _map.addSource('trip-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      _map.addLayer({
        id: 'trip-lines-casing', type: 'line', source: 'trip-lines',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.7 },
      });
      _map.addLayer({
        id: 'trip-lines', type: 'line', source: 'trip-lines',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-opacity': 0.85 },
      });
      drawMarkers();
    });
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
      `<div class="mt-pin" style="background:${k.color}"><span>${entryIcon(e)}</span></div>` +
      `<div class="mt-label">${e.start ? `<b>${escapeAttr(e.start)}</b> ` : ''}<span>${escapeAttr(e.place)}</span></div>`;

    const popup = new maptilersdk.Popup({ offset: 28, closeButton: false }).setHTML(
      `<b>${entryIcon(e)} ${escapeAttr(e.place)}</b><br/>` +
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

  // 시간순 연속 경로선 — 일자 구분 없이 전체를 하나의 선으로 (일자→시작시간 순)
  const dayIdx = id => DAYS.findIndex(d => d.id === id);
  const ordered = state.entries
    .filter(e => typeof e.lat === 'number' && typeof e.lng === 'number' &&
      (activeDay === 'all' || e.day === activeDay))
    .slice()
    .sort((a, b) => (dayIdx(a.day) - dayIdx(b.day)) ||
      (a.start || '99:99').localeCompare(b.start || '99:99'));
  const feats = ordered.length >= 2 ? [{
    type: 'Feature',
    properties: { color: ROUTE_LINE_COLOR },
    geometry: { type: 'LineString', coordinates: ordered.map(e => [e.lng, e.lat]) },
  }] : [];
  const src = _map.getSource('trip-lines');
  if (src) src.setData({ type: 'FeatureCollection', features: feats });

  if (pts.length === 1) _map.flyTo({ center: [pts[0].lng, pts[0].lat], zoom: 13 });
  else if (bounds) _map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 0 });
}

// ── 경로 탭 (스네이크 일정표) ────────────────────
// DAY 배지·정류장을 좌→우, 우→좌 로 꺾어가며 U턴으로 잇는 뱀 모양 타임라인.
function renderRoute() {
  const wrap = document.getElementById('routeWrap');
  wrap.innerHTML = '';
  const days = (activeDay === 'all' ? populatedDays() : DAYS.filter(d => d.id === activeDay));

  // 노드 시퀀스: [DAY 배지, 정류장…] 을 일자 순서로 평탄화
  const nodes = [];
  for (const day of days) {
    const items = state.entries
      .filter(e => e.day === day.id && e.place && e.place.trim())
      .slice()
      .sort((a, b) => (a.start || '99:99').localeCompare(b.start || '99:99'));
    if (!items.length) continue;
    const ci = DAYS.findIndex(d => d.id === day.id);
    nodes.push({ type: 'day', ci, label: 'DAY ' + (ci + 1) });
    for (const e of items) nodes.push({ type: 'stop', ci, e });
  }
  if (!nodes.length) {
    wrap.innerHTML = `<div class="grid-empty">아직 일정이 없습니다.<br/><small>상세 탭에서 추가하세요.</small></div>`;
    return;
  }

  // 레이아웃 계산
  const W = Math.max(280, wrap.clientWidth || 340);
  const PAD = 6, ROW_H = 132, R = ROW_H / 2, ICON_TOP = 54, LABEL_BOT = 64;
  const Lx = PAD + R, Rx = W - PAD - R;                 // 라인 좌/우 끝(곡선 반경만큼 안쪽)
  const cols = Math.max(2, Math.min(4, Math.floor((Rx - Lx) / 96) + 1));
  const step = cols > 1 ? (Rx - Lx) / (cols - 1) : 0;
  const n = nodes.length, rows = Math.ceil(n / cols);
  const lastCount = n - (rows - 1) * cols;
  const lineY = r => ICON_TOP + r * ROW_H;
  const totalH = ICON_TOP + (rows - 1) * ROW_H + LABEL_BOT;

  // 노드 좌표 (짝수행 좌→우, 홀수행 우→좌)
  const pos = nodes.map((_, i) => {
    const r = Math.floor(i / cols), j = i - r * cols, even = r % 2 === 0;
    return { x: even ? (Lx + j * step) : (Rx - j * step), y: lineY(r) };
  });

  // 스네이크 경로(직선 + 양끝 U턴 arc)
  let d = '';
  for (let r = 0; r < rows; r++) {
    const even = r % 2 === 0, isLast = r === rows - 1;
    const cnt = isLast ? lastCount : cols;
    const startX = even ? Lx : Rx;
    const endX = even ? (Lx + (cnt - 1) * step) : (Rx - (cnt - 1) * step);
    const Y = lineY(r);
    if (r === 0) d += `M ${startX} ${Y} `;
    d += `L ${endX} ${Y} `;
    if (!isLast) {
      const nY = lineY(r + 1);
      d += even ? `A ${R} ${R} 0 0 1 ${Rx} ${nY} ` : `A ${R} ${R} 0 0 0 ${Lx} ${nY} `;
    }
  }

  const svg = `<svg width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">
    <defs><linearGradient id="snG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${DAY_COLORS[0]}"/>
      <stop offset="100%" stop-color="${DAY_COLORS[DAY_COLORS.length - 1]}"/>
    </linearGradient></defs>
    <path d="${d}" fill="none" stroke="url(#snG)" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  let html = svg;
  nodes.forEach((nd, i) => {
    const p = pos[i], c = dayColor(nd.ci);
    if (nd.type === 'day') {
      html += `<div class="sn-badge" style="left:${p.x}px;top:${p.y}px;--c:${c}">${escapeAttr(nd.label)}</div>`;
    } else {
      const k = kindOf(nd.e.kind);
      html += `<div class="sn-node" style="left:${p.x}px;top:${p.y}px;--c:${c}">` +
        `<div class="sn-icon"><span>${entryIcon(nd.e)}</span></div>` +
        `<div class="sn-dot"></div>` +
        `<div class="sn-label"><b>${escapeAttr(nd.e.place)}</b>` +
          (nd.e.start ? `<span class="sn-time">${escapeAttr(nd.e.start)}</span>` : '') +
          (nd.e.memo ? `<small>${escapeAttr(nd.e.memo)}</small>` : '') +
        `</div></div>`;
    }
  });

  const snake = document.createElement('div');
  snake.className = 'snake';
  snake.style.width = W + 'px';
  snake.style.height = totalH + 'px';
  snake.innerHTML = html;
  wrap.appendChild(snake);
}

// ── 부트 ─────────────────────────────────────────
async function bootstrap() {
  document.querySelectorAll('.top-tab').forEach(b => {
    b.onclick = () => setActiveTab(b.dataset.tab);
  });
  document.getElementById('btnEdit').onclick = promptEditToken;
  document.getElementById('btnSave').onclick = manualSave;

  // 화면 크기 변경 시 스네이크 경로 재배치 / 지도 크기 갱신
  let _rzTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_rzTimer);
    _rzTimer = setTimeout(() => {
      if (activeTab === 'route') renderRoute();
      else if (activeTab === 'map' && _map) _map.resize();
    }, 200);
  });

  state = await loadInitial();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  updateEditUI();
  renderMiniTabs();
  render();
}

document.addEventListener('DOMContentLoaded', bootstrap);

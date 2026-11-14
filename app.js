'use strict';
/* Lean Bulk Log — a local-first food logger. All data lives in this browser (localStorage). */

const KEY = 'lbl.v1';
const M = ['k', 'p', 'c', 'f', 's'];

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const todayStr = () => ymd(new Date());
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const r1 = (n) => Math.round(n * 10) / 10;
const fmt = (n) => { n = Math.round(n * 10) / 10; return Number.isInteger(n) ? String(n) : n.toFixed(1); };
const fmtQ = (n) => String(Math.round(n * 100) / 100);
const fmtK = (n) => Math.round(n).toLocaleString('en-US');
const dayName = (s, o) => parseYmd(s).toLocaleDateString('en-US', o);
const isPureG = (serving) => /^\s*[\d.]+\s*g\s*$/i.test(serving || '');

/* ---------- state ---------- */
let S = null;
let viewDate = todayStr();
let lastToday = viewDate;
let tab = 'today';
let storageOK = true;
let deferredInstall = null;

function save() {
  statsCache = null;
  try { localStorage.setItem(KEY, JSON.stringify(S)); storageOK = true; }
  catch (e) { storageOK = false; toast('Could not save — storage is blocked or full. Export a backup!'); }
}

function makeEntry(food, qty, ts = Date.now()) {
  return {
    id: uid(), foodId: food.id, name: food.name, serving: food.serving, g: food.g || null, qty,
    per: { k: food.k, p: food.p, c: food.c, f: food.f, s: food.s }, ts,
  };
}

async function load() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) { storageOK = false; }
  if (raw) { S = JSON.parse(raw); return; }
  const seed = await (await fetch('seed.json')).json();
  S = { v: 1, foods: seed.foods, log: {}, meals: [], targets: seed.targets, supps: seed.supplements, suppLog: {}, usual: {}, pins: [], lastBackup: Date.now(), installedAt: Date.now() };
  const byId = Object.fromEntries(S.foods.map((f) => [f.id, f]));
  let n = 0;
  for (const day of seed.history) {
    const base = parseYmd(day.date).getTime() + 8 * 3600e3;
    S.log[day.date] = day.items.map((it) => { const f = byId[it.foodId]; S.usual[f.id] = it.qty; return makeEntry(f, it.qty, base + n++ * 1000); });
  }
  save();
}

const foodById = (id) => S.foods.find((f) => f.id === id);
const entriesOf = (d) => (S.log[d] || []).slice().sort((a, b) => a.ts - b.ts);

function totalsOf(entries) {
  const t = { k: 0, p: 0, c: 0, f: 0, s: 0 };
  for (const e of entries) for (const m of M) t[m] += (e.per[m] || 0) * e.qty;
  return t;
}
const dayTotals = (d) => totalsOf(S.log[d] || []);

function amountLabel(e) {
  if (isPureG(e.serving) && e.g) return `${fmt(e.qty * e.g)} g`;
  if (Math.abs(e.qty - 1) < 1e-6) return e.serving;
  return `${fmtQ(e.qty)} × ${e.serving}`;
}

let statsCache = null;
function foodStats() {
  if (statsCache) return statsCache;
  const cut = addDays(todayStr(), -60), cnt = {}, last = {}, all = {};
  for (const [d, es] of Object.entries(S.log)) {
    for (const e of es) {
      (all[e.foodId] = all[e.foodId] || []).push([e.ts, e.qty]);
      if (d < cut) continue;
      cnt[e.foodId] = (cnt[e.foodId] || 0) + 1; last[e.foodId] = Math.max(last[e.foodId] || 0, e.ts);
    }
  }
  // "usual" amount = most common of the last 5 quantities logged (ties go to the most recent)
  const usual = {};
  for (const [id, list] of Object.entries(all)) {
    const recent = list.sort((a, b) => b[0] - a[0]).slice(0, 5).map((x) => x[1]);
    const tally = {};
    recent.forEach((q) => { tally[q] = (tally[q] || 0) + 1; });
    usual[id] = recent.slice().sort((a, b) => tally[b] - tally[a] || recent.indexOf(a) - recent.indexOf(b))[0];
  }
  return (statsCache = { cnt, last, usual });
}
const usualQty = (id) => foodStats().usual[id] || 1;
function favourites(n = 14) {
  const { cnt } = foodStats();
  const pinned = S.pins.filter((id) => foodById(id));
  const rest = Object.keys(cnt).filter((id) => !pinned.includes(id) && foodById(id)).sort((a, b) => cnt[b] - cnt[a]);
  return [...pinned, ...rest].slice(0, n);
}
function recents(n, exclude) {
  const { last } = foodStats();
  return Object.keys(last).filter((id) => !exclude.includes(id) && foodById(id)).sort((a, b) => last[b] - last[a]).slice(0, n);
}
function searchFoods(q, limit = 60) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  const { cnt } = foodStats();
  return S.foods
    .filter((f) => { const n = f.name.toLowerCase(); return toks.every((t) => n.includes(t)); })
    .sort((a, b) => {
      const as = a.name.toLowerCase().startsWith(toks[0]) ? 0 : 1, bs = b.name.toLowerCase().startsWith(toks[0]) ? 0 : 1;
      return as - bs || (cnt[b.id] || 0) - (cnt[a.id] || 0) || a.name.localeCompare(b.name);
    }).slice(0, limit);
}

/* ---------- layers (sheets) with Android back-button support ---------- */
const layers = [];
let pendingBack = 0;
function openLayer(html, { full = false } = {}) {
  const el = document.createElement('div');
  el.className = 'layer' + (full ? ' full' : '');
  el.innerHTML = full
    ? `<div class="full-panel">${html}</div>`
    : `<div class="scrim" data-act="close-layer"></div><div class="sheet">${html}</div>`;
  $('#layers').appendChild(el);
  layers.push(el);
  if (full) document.body.classList.add('has-add');
  history.pushState({ l: layers.length }, '');
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  return el;
}
function removeTopLayer() {
  const el = layers.pop();
  if (!el) return;
  if (el.classList.contains('full')) { document.body.classList.remove('has-add'); addEl = null; }
  el.classList.remove('show');
  setTimeout(() => el.remove(), 230);
}
function closeLayer() {
  if (!layers.length) return;
  removeTopLayer();
  pendingBack++;
  history.back();
}
window.addEventListener('popstate', () => {
  if (pendingBack > 0) { pendingBack--; return; }
  removeTopLayer();
});

/* ---------- toast / undo ---------- */
let toastTimer = null, undoFn = null;
function toast(msg, undo) {
  const el = $('#toast');
  undoFn = undo || null;
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button data-act="undo">Undo</button>' : ''}`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 5500 : 2600);
}
function change(msg, fn) {
  const snap = JSON.stringify({ log: S.log, usual: S.usual });
  fn();
  save();
  refresh();
  toast(msg, () => { const o = JSON.parse(snap); S.log = o.log; S.usual = o.usual; save(); refresh(); });
}

/* ---------- log operations ---------- */
function logFood(food, qty, date = viewDate) {
  change(`Added ${food.name} · ${amountLabel({ ...food, qty, serving: food.serving, g: food.g })}`, () => {
    (S.log[date] = S.log[date] || []).push(makeEntry(food, qty));
    S.usual[food.id] = qty;
  });
}
function logMeal(meal, date = viewDate) {
  change(`Added “${meal.name}”`, () => {
    const list = (S.log[date] = S.log[date] || []);
    let ts = Date.now();
    for (const it of meal.items) {
      const f = foodById(it.foodId);
      const e = f ? makeEntry(f, it.qty, ts++) : { ...it, id: uid(), ts: ts++ };
      list.push(e);
    }
  });
}
function copyDay(from, to = viewDate) {
  const src = entriesOf(from);
  if (!src.length) return;
  change(`Copied ${src.length} items from ${dayName(from, { weekday: 'short', month: 'short', day: 'numeric' })}`, () => {
    const list = (S.log[to] = S.log[to] || []);
    let ts = Date.now();
    for (const e of src) list.push({ ...e, id: uid(), ts: ts++, per: { ...e.per } });
  });
}

/* ---------- main render ---------- */
function refresh() {
  render();
  if (addEl) renderAddFoot();
}
function render() {
  $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#fab').hidden = tab !== 'today';
  const v = $('#view');
  const html = { today: viewToday, history: viewHistory, foods: viewFoods, settings: viewSettings }[tab]();
  const keep = window.scrollY;
  v.innerHTML = html;
  window.scrollTo(0, keep);
  if (tab === 'foods') renderFoodList();
  if (tab === 'settings') afterSettings();
}

/* ---------- TODAY ---------- */
function relLabel(d) {
  const t = todayStr();
  if (d === t) return 'Today';
  if (d === addDays(t, -1)) return 'Yesterday';
  return dayName(d, { weekday: 'long' });
}

function viewToday() {
  const d = viewDate, es = entriesOf(d), t = totalsOf(es), T = S.targets;
  const left = T.k - t.k, over = left < 0, pct = Math.min(1, t.k / T.k);
  const R = 54, C = 2 * Math.PI * R;
  const mac = (m, label) => {
    const rem = T[m] - t[m];
    return `<div class="mac ${m}"><div class="hd"><span class="l">${label}</span><span class="r">${fmt(t[m])} / ${T[m]} g</span></div>
      <div class="bar"><i style="width:${Math.min(100, (t[m] / T[m]) * 100)}%"></i></div>
      <div class="small muted" style="margin-top:3px">${rem >= 0 ? `${fmt(rem)} g left` : `${fmt(-rem)} g over`}</div></div>`;
  };
  const hasData = Object.values(S.log).some((a) => a.length);
  const stale = hasData && Date.now() - (S.lastBackup || 0) > 7 * 864e5;
  const taken = S.suppLog[d] || [];

  let html = `
  <div class="daynav">
    <button class="icon-btn" data-act="day-prev" aria-label="Previous day"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
    <button class="mid" data-act="day-today"><b>${relLabel(d)}</b><span>${dayName(d, { weekday: 'short', month: 'short', day: 'numeric' })}</span></button>
    <button class="icon-btn" data-act="day-next" aria-label="Next day" ${d >= todayStr() ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>
    <button class="icon-btn" data-act="day-menu" aria-label="More"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
  </div>`;

  if (stale) html += `<div class="card banner"><div><b>Back up your data</b><div class="small muted">It only lives on this phone.</div></div><button class="btn primary" data-act="export-json">Export</button></div>`;

  html += `<div class="card"><div class="sum">
    <div class="ringbox"><svg class="ring" viewBox="0 0 140 140"><circle class="ring-bg" cx="70" cy="70" r="${R}"/><circle class="ring-fg ${over ? 'over' : ''}" cx="70" cy="70" r="${R}" stroke-dasharray="${pct * C} ${C}" transform="rotate(-90 70 70)"/></svg>
      <div class="ringtxt"><b>${fmtK(Math.abs(left))}</b><span>${over ? 'kcal over' : 'kcal left'}</span></div></div>
    <div class="macros">${mac('p', 'Protein')}${mac('c', 'Carbs')}${mac('f', 'Fat')}</div></div>
    <div class="sugar"><span>${fmtK(t.k)} of ${fmtK(T.k)} kcal</span><span>Sugar ${fmt(t.s)} / ${T.s} g</span></div></div>`;

  if (S.supps.length) {
    html += `<div class="card"><h2>Supplements</h2><div class="chips">${S.supps.map((s) =>
      `<button class="pill ${taken.includes(s.id) ? 'on' : ''}" data-act="supp" data-id="${s.id}">${taken.includes(s.id) ? '✓ ' : ''}${esc(s.name)}${s.dose ? ` · ${esc(s.dose)}` : ''}</button>`).join('')}</div></div>`;
  }

  if (!es.length) {
    const prev = addDays(d, -1);
    html += `<div class="list"><div class="empty">Nothing logged yet.<div class="btns">
      ${entriesOf(prev).length ? `<button class="btn" data-act="copy-day" data-from="${prev}">Copy ${dayName(prev, { weekday: 'long' })}</button>` : `<button class="btn" data-act="copy-pick">Copy a day…</button>`}
      <button class="btn primary" data-act="open-add">Add food</button></div></div></div>`;
  } else {
    html += `<div class="list"><div class="list-h"><h2>Logged · ${es.length}</h2><button class="ghost" data-act="day-menu" style="padding:0">Options</button></div>`;
    for (const e of es) {
      html += `<button class="row" data-act="edit-entry" data-id="${e.id}">
        <div class="row-main"><div class="name">${esc(e.name)}</div><div class="sub">${esc(amountLabel(e))}</div></div>
        <div class="row-right"><div class="kcal">${fmtK(e.per.k * e.qty)}</div>
        <div class="mini"><b class="p-c">P ${fmt(e.per.p * e.qty)}</b> · <b class="c-c">C ${fmt(e.per.c * e.qty)}</b> · <b class="f-c">F ${fmt(e.per.f * e.qty)}</b></div></div></button>`;
    }
    html += `</div>`;
  }
  return html;
}

/* ---------- HISTORY ---------- */
function viewHistory() {
  const T = S.targets;
  const days = Object.keys(S.log).filter((d) => S.log[d].length).sort().reverse();
  const cut = addDays(todayStr(), -6);
  const wk = days.filter((d) => d >= cut && d <= todayStr());
  const avg = (m) => (wk.length ? wk.reduce((a, d) => a + dayTotals(d)[m], 0) / wk.length : 0);
  const hit = (d) => { const t = dayTotals(d); return t.k >= T.k * 0.95 && t.p >= T.p * 0.95; };
  let html = `<div class="top"><div><h1>History</h1><div class="sub">${days.length} days logged</div></div></div>`;
  html += `<div class="card"><h2>Last 7 days${wk.length ? ` · ${wk.length} logged` : ''}</h2>${wk.length ? `
    <div class="stat"><div><b>${fmtK(avg('k'))}</b><span>avg kcal<br>target ${fmtK(T.k)}</span></div>
    <div><b class="p-c">${fmtK(avg('p'))} g</b><span>avg protein<br>target ${T.p} g</span></div>
    <div><b>${wk.filter(hit).length}/${wk.length}</b><span>days on target<br>kcal + protein</span></div></div>`
    : '<div class="muted">Log a few days and your averages show up here.</div>'}</div>`;
  html += `<div class="list" style="margin-top:12px">`;
  for (const d of days.slice(0, 90)) {
    const t = dayTotals(d);
    html += `<button class="row" data-act="goto-day" data-d="${d}"><div class="row-main hist">
      <div class="line"><b>${dayName(d, { weekday: 'short', month: 'short', day: 'numeric' })}${hit(d) ? ' <span style="color:var(--accent)">✓</span>' : ''}</b>
      <span><b>${fmtK(t.k)}</b> <span class="muted small">/ ${fmtK(T.k)}</span></span></div>
      <div class="bar"><i style="width:${Math.min(100, (t.k / T.k) * 100)}%;background:var(--accent)"></i></div>
      <div class="small muted"><span class="p-c">P ${fmtK(t.p)}</span> · <span class="c-c">C ${fmtK(t.c)}</span> · <span class="f-c">F ${fmtK(t.f)}</span></div></div></button>`;
  }
  if (!days.length) html += `<div class="empty">No history yet.</div>`;
  return html + `</div>`;
}

/* ---------- FOODS ---------- */
let foodQ = '';
function viewFoods() {
  return `<div class="top"><div><h1>Foods</h1><div class="sub">${S.foods.length} in your database</div></div>
    <div style="display:flex;gap:8px"><button class="btn" data-act="scan-label" aria-label="Scan a nutrition label" style="padding:10px 12px;color:var(--accent)">${CAMERA_SVG}</button><button class="btn primary" data-act="new-food">+ New</button></div></div>
    <div style="padding:10px 14px 0"><div class="search"><input id="food-q" type="search" placeholder="Search foods…" value="${esc(foodQ)}" autocomplete="off"></div></div>
    <div class="list" id="food-list"></div>`;
}
function foodRow(f, act = 'edit-food') {
  const star = S.pins.includes(f.id) ? '★ ' : '';
  return `<button class="row" data-act="${act}" data-id="${f.id}"><div class="row-main"><div class="name">${star}${esc(f.name)}</div><div class="sub">${esc(f.serving)} · ${esc(f.cat)}</div></div>
    <div class="row-right"><div class="kcal">${fmtK(f.k)}</div><div class="mini"><b class="p-c">P ${fmt(f.p)}</b> · <b class="c-c">C ${fmt(f.c)}</b> · <b class="f-c">F ${fmt(f.f)}</b></div></div></button>`;
}
function renderFoodList() {
  const list = foodQ.trim() ? searchFoods(foodQ, 100) : S.foods.slice().sort((a, b) => a.name.localeCompare(b.name));
  $('#food-list').innerHTML = list.map((f) => foodRow(f)).join('') || '<div class="empty">No matches.</div>';
}

function openFoodForm(food, { fromAdd = false, prefill = null, banner = '', photo = '' } = {}) {
  const isNew = !food;
  const f = food || { name: addEl ? (addState.q || '') : (tab === 'foods' ? foodQ : ''), serving: '1 serving', k: '', p: '', c: '', f: '', s: 0, cat: 'Other', g: '', ...(prefill || {}) };
  const cats = [...new Set([...S.foods.map((x) => x.cat), 'Other'])].sort();
  const el = openLayer(`
    ${photo ? `<img class="scan-thumb" src="${photo}" alt="Your label photo">` : ''}
    ${banner ? `<div class="notice">${banner}</div>` : ''}
    <div class="sheet-title">${isNew ? (prefill ? 'Check scanned food' : 'New food') : 'Edit food'}</div>
    <div class="muted small" style="margin-bottom:12px">Macros are per one serving.${isNew ? '' : ' Past log entries keep the macros they were logged with.'}</div>
    <div class="field"><label>Name</label><input id="ff-name" value="${esc(f.name)}" autocomplete="off"></div>
    <div class="grid2"><div class="field"><label>Serving (e.g. “100 g”, “1 bar”)</label><input id="ff-serving" value="${esc(f.serving)}"></div>
    <div class="field"><label>Grams per serving (optional)</label><input id="ff-g" inputmode="decimal" value="${f.g || ''}" placeholder="enables gram entry"></div></div>
    <div class="grid2"><div class="field"><label>Calories</label><input id="ff-k" inputmode="decimal" value="${f.k}" placeholder="auto from macros"></div>
    <div class="field"><label>Protein (g)</label><input id="ff-p" inputmode="decimal" value="${f.p}"></div></div>
    <div class="grid3"><div class="field"><label>Carbs (g)</label><input id="ff-c" inputmode="decimal" value="${f.c}"></div>
    <div class="field"><label>Fat (g)</label><input id="ff-f" inputmode="decimal" value="${f.f}"></div>
    <div class="field"><label>Sugar (g)</label><input id="ff-s" inputmode="decimal" value="${f.s}"></div></div>
    <div class="field"><label>Category</label><select id="ff-cat">${cats.map((c) => `<option ${c === f.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
    ${isNew ? '' : `<label class="check"><input type="checkbox" id="ff-pin" ${S.pins.includes(f.id) ? 'checked' : ''}> Always show in favourites</label>`}
    <div class="btn-row">${isNew ? '' : '<button class="btn danger" id="ff-del">Delete</button>'}<button class="btn primary" id="ff-save">Save</button></div>`);
  const v = (id) => $(id, el).value.trim();
  const n = (id) => { const x = parseFloat(v(id)); return Number.isFinite(x) && x >= 0 ? x : 0; };
  $('#ff-save', el).onclick = () => {
    const name = v('#ff-name');
    if (!name) { toast('Give the food a name'); return; }
    if (S.foods.some((x) => x.name.toLowerCase() === name.toLowerCase() && (!food || x.id !== food.id))) { toast('A food with that name already exists'); return; }
    const p = n('#ff-p'), c = n('#ff-c'), fa = n('#ff-f');
    const kRaw = parseFloat(v('#ff-k'));
    const g = parseFloat(v('#ff-g'));
    const rec = { name, serving: v('#ff-serving') || '1 serving', k: Number.isFinite(kRaw) ? Math.round(kRaw) : Math.round(p * 4 + c * 4 + fa * 9), p: r1(p), c: r1(c), f: r1(fa), s: r1(n('#ff-s')), cat: $('#ff-cat', el).value };
    const fromLabel = rec.serving.match(/^\s*([\d.]+)\s*g\s*$/i) || rec.serving.match(/\(~?([\d.]+)\s*g\)/i);
    if (g > 0) rec.g = g; else if (fromLabel) rec.g = parseFloat(fromLabel[1]);
    let target = food;
    if (isNew) { target = { id: 'f' + uid(), ...rec }; S.foods.push(target); } else { delete target.g; Object.assign(target, rec); }
    if (!isNew) { const pin = $('#ff-pin', el).checked; S.pins = S.pins.filter((x) => x !== target.id); if (pin) S.pins.push(target.id); }
    save(); closeLayer(); refresh(); if (addEl) renderAddBody();
    if (isNew && fromAdd) setTimeout(() => openQty({ food: target }), 260);
    else toast(isNew ? 'Food saved' : 'Changes saved');
  };
  if (!isNew) $('#ff-del', el).onclick = () => askConfirm(`Delete “${food.name}” from your database? Past logs are not affected.`, 'Delete', () => {
    S.foods = S.foods.filter((x) => x.id !== food.id); S.pins = S.pins.filter((x) => x !== food.id); save(); closeLayer(); refresh(); if (addEl) renderAddBody();
  });
}

const CAMERA_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

/* ---------- ADD FLOW ---------- */
let addEl = null;
let addState = { q: '', cat: 'All' };

function openAdd() {
  addState = { q: '', cat: 'All' };
  addEl = openLayer(`
    <div class="add-head"><div class="search"><input id="q" type="search" placeholder="Search foods…" autocomplete="off"></div>
      <button class="icon-btn" data-act="scan-label" aria-label="Scan a nutrition label" style="color:var(--accent)">${CAMERA_SVG}</button><button class="ghost" data-act="close-layer">Done</button></div>
    <div class="add-body" id="add-body"></div><div class="add-foot" id="add-foot"></div>`, { full: true });
  $('#q', addEl).addEventListener('input', (e) => { addState.q = e.target.value; renderAddBody(); });
  renderAddBody(); renderAddFoot();
}

function chip(id) {
  const f = foodById(id); if (!f) return '';
  const q = usualQty(id);
  const label = isPureG(f.serving) && f.g ? `${fmt(q * f.g)} g` : `×${fmtQ(q)}`;
  return `<div class="qchip"><button class="go" data-act="quick" data-id="${id}"><b>${esc(f.name)}</b><small>${label} · ${fmtK(f.k * q)} kcal</small></button>
    <button class="ed" data-act="pick" data-id="${id}" aria-label="Change amount"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg></button></div>`;
}
function mealTotals(m) {
  return totalsOf(m.items.map((it) => { const f = foodById(it.foodId); return { per: f ? { k: f.k, p: f.p, c: f.c, f: f.f, s: f.s } : it.per, qty: it.qty }; }));
}

function renderAddBody() {
  const body = $('#add-body', addEl); if (!body) return;
  const q = addState.q.trim();
  let html = '';
  if (q) {
    const res = searchFoods(q);
    html += `<div class="list" style="margin-top:10px">${res.map((f) => foodRow(f, 'pick')).join('')}
      <button class="row" data-act="new-food-add"><div class="row-main"><div class="name" style="color:var(--accent)">+ Create “${esc(q)}”</div><div class="sub">Add it as a new food</div></div></button></div>`;
  } else {
    if (S.meals.length) {
      html += `<div class="sect">Saved meals</div><div class="list" style="margin-top:4px">${S.meals.map((m) => { const t = mealTotals(m); return `
        <button class="row" data-act="quick-meal" data-id="${m.id}"><div class="row-main"><div class="name">${esc(m.name)}</div><div class="sub">${m.items.length} items · tap to log all</div></div>
        <div class="row-right"><div class="kcal">${fmtK(t.k)}</div><div class="mini"><b class="p-c">P ${fmt(t.p)}</b> · <b class="c-c">C ${fmt(t.c)}</b> · <b class="f-c">F ${fmt(t.f)}</b></div></div></button>`; }).join('')}</div>`;
    }
    const favs = favourites(14), rec = recents(10, favs);
    if (favs.length) html += `<div class="sect">Favourites <span class="small" style="text-transform:none;letter-spacing:0">tap = add · ✎ = change amount</span></div><div class="qchips">${favs.map(chip).join('')}</div>`;
    if (rec.length) html += `<div class="sect">Recent</div><div class="qchips">${rec.map(chip).join('')}</div>`;
    const cats = ['All', ...[...new Set(S.foods.map((f) => f.cat))].sort()];
    html += `<div class="sect">All foods</div><div class="hscroll">${cats.map((c) => `<button class="pill ${addState.cat === c ? 'on' : ''}" data-act="add-cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
    const list = S.foods.filter((f) => addState.cat === 'All' || f.cat === addState.cat).sort((a, b) => a.name.localeCompare(b.name));
    html += `<div class="list" style="margin-top:6px">${list.map((f) => foodRow(f, 'pick')).join('')}</div>`;
  }
  body.innerHTML = html;
}

function renderAddFoot() {
  const foot = $('#add-foot', addEl); if (!foot) return;
  const t = dayTotals(viewDate), T = S.targets;
  const rem = (m) => fmt(T[m] - t[m]);
  foot.innerHTML = `<div><div class="small muted">${viewDate === todayStr() ? 'Left today' : 'Left on ' + dayName(viewDate, { month: 'short', day: 'numeric' })}</div>
    <div class="nums"><b>${fmtK(T.k - t.k)} kcal</b><b class="p-c">P ${rem('p')}</b><b class="c-c">C ${rem('c')}</b><b class="f-c">F ${rem('f')}</b></div></div>
    <button class="btn primary" data-act="close-layer">Done</button>`;
}

/* qty dialog — add a food, or edit an existing log entry */
function openQty({ food, entry }) {
  const src = entry || food;
  const g = src.g || null;
  const per = entry ? entry.per : { k: food.k, p: food.p, c: food.c, f: food.f, s: food.s };
  let unit = g && isPureG(src.serving) ? 'g' : 'srv';
  let qty = entry ? entry.qty : usualQty(food.id);
  const el = openLayer(`
    <div class="sheet-title">${esc(src.name)}</div><div class="muted small">1 serving = ${esc(src.serving)}</div>
    <div class="qty-row"><button class="step" data-s="-">−</button><input id="qv" inputmode="decimal"><button class="step" data-s="+">+</button></div>
    ${g ? `<div class="seg"><button data-u="srv">Servings</button><button data-u="g">Grams</button></div>` : ''}
    <div class="presets" id="presets"></div>
    <div class="preview" id="pv"></div>
    <div class="btn-row">${entry ? '<button class="btn danger" id="q-del">Remove</button>' : ''}<button class="btn primary" id="q-ok">${entry ? 'Save' : 'Add'}</button></div>`);
  const input = $('#qv', el);
  const shown = () => (unit === 'g' ? qty * g : qty);
  const step = () => (unit === 'g' ? (g * qty >= 60 ? 10 : 5) : 0.5);
  function paint(setInput) {
    if (setInput) input.value = fmtQ(shown());
    $$('.seg button', el).forEach((b) => b.classList.toggle('on', b.dataset.u === unit));
    const presets = unit === 'g' ? [50, 100, 150, 200, 250, 300] : [0.5, 1, 1.5, 2, 3, 4];
    $('#presets', el).innerHTML = presets.map((p) => `<button class="pill" data-p="${p}">${unit === 'g' ? p + ' g' : '×' + p}</button>`).join('');
    const t = totalsOf([{ per, qty }]);
    $('#pv', el).innerHTML = `<div class="k">${fmtK(t.k)} <small>kcal</small></div><div class="m"><b class="p-c">P ${fmt(t.p)}</b><b class="c-c">C ${fmt(t.c)}</b><b class="f-c">F ${fmt(t.f)}</b></div>`;
    $('#q-ok', el).disabled = !(qty > 0);
  }
  const setFromShown = (v) => { qty = unit === 'g' ? v / g : v; qty = Math.round(qty * 10000) / 10000; };
  input.addEventListener('input', () => { const v = parseFloat(input.value.replace(',', '.')); setFromShown(Number.isFinite(v) && v > 0 ? v : 0); paint(false); });
  el.addEventListener('click', (e) => {
    const s = e.target.closest('[data-s]'), u = e.target.closest('[data-u]'), p = e.target.closest('[data-p]');
    if (s) { const v = Math.max(0, shown() + (s.dataset.s === '+' ? 1 : -1) * step()); setFromShown(v); paint(true); }
    if (u) { unit = u.dataset.u; paint(true); }
    if (p) { setFromShown(parseFloat(p.dataset.p)); paint(true); }
  });
  $('#q-ok', el).onclick = () => {
    if (!(qty > 0)) return;
    if (entry) {
      closeLayer();
      change('Entry updated', () => { entry.qty = qty; S.usual[entry.foodId] = qty; });
    } else { closeLayer(); logFood(food, qty); }
  };
  if (entry) $('#q-del', el).onclick = () => { closeLayer(); change('Removed ' + entry.name, () => { S.log[viewDate] = S.log[viewDate].filter((e) => e.id !== entry.id); }); };
  paint(true);
}

/* ---------- LABEL SCANNER (photo -> proxy -> Claude -> pre-filled food form) ---------- */
const SCAN_KEY = 'lbl.scan'; // kept outside the main state so the token never lands in backups
const scanCfg = () => { try { return JSON.parse(localStorage.getItem(SCAN_KEY)) || {}; } catch (e) { return {}; } };
const setScanCfg = (c) => { try { localStorage.setItem(SCAN_KEY, JSON.stringify(c)); } catch (e) { toast('Could not save scanner settings'); } };
const scanReady = () => { const c = scanCfg(); return !!(c.url && c.token); };

async function prepImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
  return { b64, blobUrl: URL.createObjectURL(blob) };
}

function scannedToForm(x) {
  const num = (v) => (Number.isFinite(+v) && +v > 0 ? +v : 0);
  const k = Math.round(num(x.calories)), p = r1(num(x.protein_g)), c = r1(num(x.carbs_g)), f = r1(num(x.fat_g));
  const prefill = { name: (x.product_name || '').trim(), serving: (x.serving_label || '').trim() || '1 serving', g: num(x.serving_grams) || '', k, p, c, f, s: r1(num(x.sugar_g)), cat: 'Other' };
  const warn = [];
  const calc = p * 4 + c * 4 + f * 9;
  if (Math.abs(calc - k) > Math.max(30, k * 0.2)) warn.push(`Calories (${k}) don't match the macros (~${Math.round(calc)}) — double-check them against the photo.`);
  if (x.confidence !== 'high') warn.push(`Claude wasn't fully sure about this label (${esc(x.confidence)} confidence).`);
  if (x.notes) warn.push(esc(x.notes));
  return { prefill, banner: `<b>Check these against your photo before saving.</b>${warn.map((w) => `<div>⚠ ${w}</div>`).join('')}` };
}

function scanSetupSheet() {
  openLayer(`<div class="sheet-title">Set up label scanning</div>
    <div class="muted" style="margin:6px 0 12px">Scanning needs a small proxy that holds your Claude API key (one-time setup, steps in the README). Then paste its address and your app token under <b>Settings → Label scanner</b>.</div>
    <div class="btn-row"><button class="btn" data-act="close-layer">Not now</button><button class="btn primary" data-act="scan-go-settings">Open settings</button></div>`);
}

function scanPick(gallery) {
  const input = $(gallery ? '#scan-file-gallery' : '#scan-file');
  input.value = '';
  input.click();
}

async function handleScan(file) {
  const cfg = scanCfg();
  const el = openLayer(`<div class="sheet-title" id="scan-title">Reading label…</div>
    <div class="muted small" id="scan-status">Preparing photo</div>
    <img id="scan-img" class="scan-thumb" alt="" hidden><div class="spinner" id="scan-spin"></div><div id="scan-actions"></div>`);
  const fail = (msg) => {
    $('#scan-title', el).textContent = 'Couldn’t read that';
    $('#scan-status', el).textContent = msg;
    $('#scan-spin', el).hidden = true;
    $('#scan-actions', el).innerHTML = `<div class="btn-row" style="flex-wrap:wrap"><button class="btn" data-act="scan-retry">Retake</button><button class="btn" data-act="scan-gallery">From gallery</button><button class="btn primary" data-act="scan-manual">Enter manually</button></div>`;
  };
  let photoUrl = '';
  try {
    const { b64, blobUrl } = await prepImage(file);
    photoUrl = blobUrl;
    const img = $('#scan-img', el); img.src = blobUrl; img.hidden = false;
    $('#scan-status', el).textContent = 'Asking Claude to read it…';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': cfg.token }, body: JSON.stringify({ image: b64, mediaType: 'image/jpeg' }), signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) return fail((data && data.error) || `Scan server error (${res.status}).`);
    if (!data.food.is_nutrition_label) return fail('That doesn’t look like a Nutrition Facts label. Try a closer, flatter shot of the panel.');
    const { prefill, banner } = scannedToForm(data.food);
    const fromAdd = !!addEl;
    closeLayer();
    setTimeout(() => openFoodForm(null, { fromAdd, prefill, banner, photo: photoUrl }), 280);
  } catch (e) {
    fail(e.name === 'AbortError' ? 'Took too long — check your connection and try again.' : e instanceof TypeError ? `Couldn’t reach the scan server (${e.message}). Run Test connection in Settings to see what’s wrong.` : 'Something went wrong reading the photo.');
  }
}

async function testScanner(btn) {
  const c = scanCfg(), out = $('#scan-test-result');
  if (!c.url || !c.token) { out.textContent = 'Enter the proxy address and token first.'; return; }
  if (!/^https:\/\/[^\s/]+(\/\S*)?$/i.test(c.url)) { out.textContent = `✗ The address must start with https:// and contain no spaces. It currently reads: ${c.url.slice(0, 70)}`; return; }
  if (!/^[\x21-\x7e]+$/.test(c.token)) { out.textContent = '✗ The token contains a character that is not allowed (copy/paste added something odd). Clear the field and paste it again.'; return; }
  btn.disabled = true; out.textContent = 'Testing…';
  try {
    const r = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': c.token }, body: '{}' });
    out.textContent = r.status === 401 ? '✗ The proxy rejected your app token (wrong or mistyped).' : r.status === 413 ? '✓ Connected — the proxy accepted your token.' : r.status === 403 ? '✗ The proxy does not allow this website (check ALLOWED_ORIGIN).' : `Unexpected reply (${r.status}).`;
  } catch (e) { out.textContent = `✗ Could not reach ${new URL(c.url).host} (${e.message || e.name}). Check the address, your connection, and any VPN or Private DNS.`; }
  btn.disabled = false;
}

/* ---------- confirm / menus ---------- */
function askConfirm(msg, okLabel, fn) {
  const el = openLayer(`<div class="sheet-title">${esc(msg)}</div><div class="btn-row"><button class="btn" data-act="close-layer">Cancel</button><button class="btn primary" id="c-ok">${esc(okLabel)}</button></div>`);
  $('#c-ok', el).onclick = () => { closeLayer(); setTimeout(fn, 250); };
}

function dayMenu() {
  const has = entriesOf(viewDate).length > 0;
  openLayer(`<div class="sheet-title">${relLabel(viewDate)} · ${dayName(viewDate, { month: 'short', day: 'numeric' })}</div>
    <div class="list" style="margin:12px 0 0">
      <button class="row" data-act="copy-pick"><div class="row-main"><div class="name">Copy from another day…</div><div class="sub">Repeat a day you've already logged</div></div></button>
      <button class="row" data-act="save-meal" ${has ? '' : 'disabled style="opacity:.4"'}><div class="row-main"><div class="name">Save entries as a meal…</div><div class="sub">One-tap combos like “my usual breakfast”</div></div></button>
      <button class="row" data-act="clear-day" ${has ? '' : 'disabled style="opacity:.4"'}><div class="row-main"><div class="name" style="color:var(--danger)">Clear this day</div></div></button>
    </div>`);
}

function copyPicker() {
  const days = Object.keys(S.log).filter((d) => d !== viewDate && S.log[d].length).sort().reverse().slice(0, 14);
  openLayer(`<div class="sheet-title">Copy a day into ${relLabel(viewDate).toLowerCase()}</div>
    <div class="list" style="margin:12px 0 0">${days.map((d) => { const t = dayTotals(d); return `<button class="row" data-act="copy-day" data-from="${d}">
      <div class="row-main"><div class="name">${d === addDays(todayStr(), -1) ? 'Yesterday · ' : ''}${dayName(d, { weekday: 'long', month: 'short', day: 'numeric' })}</div><div class="sub">${S.log[d].length} items</div></div>
      <div class="row-right"><div class="kcal">${fmtK(t.k)}</div><div class="mini">P ${fmtK(t.p)}</div></div></button>`; }).join('') || '<div class="empty">No other days logged yet.</div>'}</div>`);
}

function saveMealSheet() {
  const es = entriesOf(viewDate);
  const el = openLayer(`<div class="sheet-title">Save as meal</div>
    <div class="field" style="margin-top:12px"><label>Meal name</label><input id="m-name" placeholder="e.g. Usual breakfast" autocomplete="off"></div>
    ${es.map((e, i) => `<label class="check"><input type="checkbox" data-i="${i}" checked><span style="flex:1">${esc(e.name)} <span class="muted small">· ${esc(amountLabel(e))}</span></span></label>`).join('')}
    <div class="btn-row"><button class="btn primary" id="m-ok">Save meal</button></div>`);
  $('#m-ok', el).onclick = () => {
    const name = $('#m-name', el).value.trim();
    const items = $$('input[data-i]', el).filter((c) => c.checked).map((c) => { const e = es[+c.dataset.i]; return { foodId: e.foodId, name: e.name, serving: e.serving, g: e.g, qty: e.qty, per: { ...e.per } }; });
    if (!name) { toast('Name your meal'); return; }
    if (!items.length) { toast('Pick at least one item'); return; }
    S.meals.push({ id: 'm' + uid(), name, items }); save(); closeLayer(); refresh(); toast(`Saved “${name}”`);
  };
}

function mealSheet(m) {
  const t = mealTotals(m);
  const el = openLayer(`<div class="sheet-title">${esc(m.name)}</div><div class="muted small">${fmtK(t.k)} kcal · P ${fmt(t.p)} · C ${fmt(t.c)} · F ${fmt(t.f)}</div>
    <div class="list" style="margin:12px 0">${m.items.map((it) => `<div class="row"><div class="row-main"><div class="name">${esc(it.name)}</div><div class="sub">${esc(amountLabel(it))}</div></div></div>`).join('')}</div>
    <div class="field"><label>Rename</label><input id="m-rename" value="${esc(m.name)}"></div>
    <div class="btn-row"><button class="btn danger" id="m-del">Delete</button><button class="btn primary" id="m-save">Save</button></div>`);
  $('#m-save', el).onclick = () => { const n = $('#m-rename', el).value.trim(); if (n) m.name = n; save(); closeLayer(); refresh(); if (addEl) renderAddBody(); };
  $('#m-del', el).onclick = () => { S.meals = S.meals.filter((x) => x.id !== m.id); save(); closeLayer(); refresh(); if (addEl) renderAddBody(); toast('Meal deleted'); };
}

/* ---------- SETTINGS ---------- */
function viewSettings() {
  const T = S.targets;
  const kcalFromMacros = T.p * 4 + T.c * 4 + T.f * 9;
  const row = (k, label) => `<div class="tgt"><span>${label}</span><input type="number" inputmode="decimal" data-t="${k}" value="${T[k]}"></div>`;
  const last = S.lastBackup ? new Date(S.lastBackup).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'never';
  return `<div class="top"><div><h1>Settings</h1><div class="sub">Everything stays on this phone</div></div></div>
  <div class="card"><h2>Daily targets</h2>${row('k', 'Calories (kcal)')}${row('p', 'Protein (g)')}${row('c', 'Carbs (g)')}${row('f', 'Fat (g)')}${row('s', 'Sugar limit (g)')}
    <div class="small muted" id="macro-hint">${hint(kcalFromMacros, T.k)}</div></div>
  <div class="card"><h2>Supplements</h2>${S.supps.map((s) => `<div class="tgt" style="grid-template-columns:1fr auto"><span>${esc(s.name)}${s.dose ? ` <span class="muted small">· ${esc(s.dose)}</span>` : ''}</span><button class="ghost" style="color:var(--danger)" data-act="del-supp" data-id="${s.id}">Remove</button></div>`).join('')}
    <div class="grid2" style="margin-top:8px"><div class="field" style="margin:0"><input id="sp-name" placeholder="Name" autocomplete="off"></div><div class="field" style="margin:0"><input id="sp-dose" placeholder="Dose (optional)" autocomplete="off"></div></div>
    <button class="btn block" style="margin-top:10px" data-act="add-supp">Add supplement</button></div>
  <div class="card"><h2>Saved meals</h2>${S.meals.length ? S.meals.map((m) => `<button class="row" style="padding-left:0;padding-right:0" data-act="meal" data-id="${m.id}"><div class="row-main"><div class="name">${esc(m.name)}</div><div class="sub">${m.items.length} items · ${fmtK(mealTotals(m).k)} kcal</div></div><span class="muted">›</span></button>`).join('') : '<div class="muted small">Log a few foods, then use ⋯ → “Save entries as a meal” on the Today screen.</div>'}</div>
  <div class="card"><h2>Label scanner</h2><div class="small muted" style="margin-bottom:10px">Photograph a Nutrition Facts label and Claude fills in the food. Needs your own proxy — see the README. The token stays on this phone and is not included in backups.</div>
    <div class="field"><label>Proxy address</label><input id="scan-url" data-scan="url" inputmode="url" autocomplete="off" placeholder="https://lean-bulk-log-scan.your-name.workers.dev" value="${esc(scanCfg().url || '')}"></div>
    <div class="field"><label>App token</label><input id="scan-token" data-scan="token" type="password" autocomplete="off" value="${esc(scanCfg().token || '')}"></div>
    <div class="btn-row" style="margin-top:0"><button class="btn" data-act="scan-test">Test connection</button></div>
    <div class="small muted" id="scan-test-result" style="margin-top:8px"></div></div>
  <div class="card"><h2>Backup &amp; export</h2><div class="small muted" style="margin-bottom:10px">Last backup: <b>${last}</b>. Clearing browser data erases everything here, so export now and then and keep the file in Drive/Photos.</div>
    <div class="btn-row" style="margin-top:0"><button class="btn primary" data-act="export-json">Backup (JSON)</button><button class="btn" data-act="import-json">Restore…</button></div>
    <button class="btn block" style="margin-top:8px" data-act="merge-json">Import history (keep my data)…</button>
    <div class="small muted" style="margin-top:6px"><b>Restore</b> replaces everything. <b>Import history</b> only adds what’s missing — use it to load an old backup without losing newer logs.</div>
    <input type="file" id="merge-file" accept=".json,application/json" hidden>
    ${(() => { const p = readPrev(); return p && p.data ? `<button class="btn block" style="margin-top:8px;color:var(--warn)" data-act="undo-import">Undo last ${esc(p.label)} · ${new Date(p.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</button>` : ''; })()}
    <button class="btn block" style="margin-top:8px" data-act="export-csv">Export log for Excel (CSV)</button>
    <input type="file" id="import-file" accept=".json,application/json" hidden>
    <div class="small muted" style="margin-top:10px" id="persist-note"></div></div>
  <div class="card" id="install-card" hidden><h2>Install</h2><button class="btn primary block" data-act="install">Install app on this phone</button></div>`;
}
const hint = (fromMacros, k) => `Your macros add up to <b>${fmtK(fromMacros)} kcal</b>${Math.abs(fromMacros - k) > 40 ? ` (target is ${fmtK(k)}). <button class="ghost" style="padding:0" data-act="sync-kcal">Set calories to ${fmtK(fromMacros)}</button>` : ' — matches your calorie target.'}`;

function afterSettings() {
  $('#install-card').hidden = !deferredInstall;
  const note = $('#persist-note');
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((p) => { if (note) note.textContent = p ? 'Storage is marked persistent — the browser will not clear it automatically.' : 'The browser may clear this data if the phone runs low on space — keep backups.'; });
  }
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportJson() {
  S.lastBackup = Date.now(); save();
  download(`lean-bulk-log-backup-${todayStr()}.json`, JSON.stringify(S), 'application/json');
  refresh(); toast('Backup saved to your downloads');
}
function exportCsv() {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Date', 'Food', 'Servings', 'Serving size', 'Amount', 'Calories', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Sugar (g)']];
  for (const d of Object.keys(S.log).sort()) for (const e of S.log[d].slice().sort((a, b) => a.ts - b.ts)) {
    rows.push([d, e.name, fmtQ(e.qty), e.serving, amountLabel(e), Math.round(e.per.k * e.qty), r1(e.per.p * e.qty), r1(e.per.c * e.qty), r1(e.per.f * e.qty), r1(e.per.s * e.qty)]);
  }
  download(`lean-bulk-log-${todayStr()}.csv`, '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n'), 'text/csv');
  toast('CSV exported');
}
/* Safety net: a copy of everything is kept just before any restore/import, so it can always be undone. */
const PREV_KEY = 'lbl.prev';
function snapshotBefore(label) {
  try { localStorage.setItem(PREV_KEY, JSON.stringify({ ts: Date.now(), label, data: S })); } catch (e) { /* storage full: in-session undo still works */ }
}
function readPrev() { try { return JSON.parse(localStorage.getItem(PREV_KEY)); } catch (e) { return null; } }
function undoImport() {
  const p = readPrev();
  if (!p || !p.data || !Array.isArray(p.data.foods)) { toast('Nothing to undo'); return; }
  S = p.data;
  try { localStorage.removeItem(PREV_KEY); } catch (e) { /* ignore */ }
  save(); viewDate = todayStr(); refresh(); toast(`Undid the ${p.label} — your data is back`);
}

/* Merge a backup INTO the current data: nothing existing is removed or changed. Safe to run twice. */
function mergeBackup(o) {
  snapshotBefore('history import');
  const snap = JSON.stringify(S);
  const key = (s) => String(s).trim().toLowerCase();
  const byName = new Map(S.foods.map((f) => [key(f.name), f]));
  const idMap = {};
  let addedFoods = 0;
  for (const f of o.foods) {
    if (!f || !f.name) continue;
    let local = byName.get(key(f.name));
    if (!local) {
      local = { ...f };
      if (S.foods.some((x) => x.id === local.id)) local.id = 'f' + uid();
      S.foods.push(local); byName.set(key(local.name), local); addedFoods++;
    }
    idMap[f.id] = local.id;
  }
  const have = new Set();
  for (const es of Object.values(S.log)) for (const e of es) have.add(e.id);
  let addedEntries = 0, addedDays = 0;
  for (const [d, es] of Object.entries(o.log || {})) {
    const fresh = (es || []).filter((e) => e && e.id && e.per && typeof e.qty === 'number' && !have.has(e.id));
    if (!fresh.length) continue;
    const list = (S.log[d] = S.log[d] || []);
    if (!list.length) addedDays++;
    for (const e of fresh) { list.push({ ...e, foodId: idMap[e.foodId] || e.foodId, per: { ...e.per } }); addedEntries++; }
  }
  let addedMeals = 0;
  for (const m of o.meals || []) {
    if (m && m.name && !S.meals.some((x) => key(x.name) === key(m.name))) {
      S.meals.push({ ...m, id: 'm' + uid(), items: (m.items || []).map((it) => ({ ...it, foodId: idMap[it.foodId] || it.foodId })) }); addedMeals++;
    }
  }
  for (const s of o.supps || []) if (s && s.name && !S.supps.some((x) => key(x.name) === key(s.name))) S.supps.push({ ...s, id: 's' + uid() });
  save(); refresh();
  toast(addedEntries ? `Merged ${addedEntries} entries (${addedDays} new days) and ${addedFoods} new foods` : 'Nothing new to merge — it’s already in the app', addedEntries || addedFoods ? () => { S = JSON.parse(snap); save(); refresh(); } : null);
  return { addedEntries, addedDays, addedFoods, addedMeals };
}

function importJson(file, merge = false) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const o = JSON.parse(rd.result);
      if (!Array.isArray(o.foods) || typeof o.log !== 'object') throw new Error('bad');
      if (merge) {
        const days = Object.values(o.log).filter((a) => a && a.length).length;
        askConfirm(`Add up to ${days} logged days and any foods you don’t have yet from this file? Everything already in the app stays.`, 'Merge', () => mergeBackup(o));
        return;
      }
      const mine = Object.values(S.log).filter((a) => a && a.length).length;
      askConfirm(`Restore will ERASE what’s in the app now (${mine} logged days, ${S.foods.length} foods) and replace it with this backup (${Object.keys(o.log).length} days, ${o.foods.length} foods). To keep your current data, use “Import history” instead.`, 'Restore anyway', () => {
        snapshotBefore('restore');
        S = o; save(); viewDate = todayStr(); refresh();
        toast('Backup restored', () => undoImport());
      });
    } catch (e) { toast('That file is not a Lean Bulk Log backup'); }
  };
  rd.readAsText(file);
}

/* ---------- events ---------- */
const actions = {
  tab: (el) => { tab = el.dataset.tab; window.scrollTo(0, 0); render(); },
  'open-add': () => openAdd(),
  'close-layer': () => closeLayer(),
  undo: () => { const f = undoFn; undoFn = null; $('#toast').classList.remove('show'); if (f) f(); },
  'day-prev': () => { viewDate = addDays(viewDate, -1); refresh(); },
  'day-next': () => { if (viewDate < todayStr()) { viewDate = addDays(viewDate, 1); refresh(); } },
  'day-today': () => { viewDate = todayStr(); refresh(); },
  'day-menu': () => dayMenu(),
  'goto-day': (el) => { viewDate = el.dataset.d; tab = 'today'; window.scrollTo(0, 0); render(); },
  supp: (el) => { const id = el.dataset.id, a = (S.suppLog[viewDate] = S.suppLog[viewDate] || []); const i = a.indexOf(id); i >= 0 ? a.splice(i, 1) : a.push(id); save(); refresh(); },
  'edit-entry': (el) => { const e = (S.log[viewDate] || []).find((x) => x.id === el.dataset.id); if (e) openQty({ entry: e }); },
  quick: (el) => { const f = foodById(el.dataset.id); if (f) logFood(f, usualQty(f.id)); },
  'quick-meal': (el) => { const m = S.meals.find((x) => x.id === el.dataset.id); if (m) logMeal(m); },
  pick: (el) => { const f = foodById(el.dataset.id); if (f) openQty({ food: f }); },
  'add-cat': (el) => { addState.cat = el.dataset.cat; renderAddBody(); },
  'new-food': () => openFoodForm(null),
  'new-food-add': () => openFoodForm(null, { fromAdd: true }),
  'edit-food': (el) => { const f = foodById(el.dataset.id); if (f) openFoodForm(f); },
  'copy-day': (el) => { if (layers.length && !addEl) closeLayer(); copyDay(el.dataset.from); },
  'copy-pick': () => { if (layers.length && !addEl) { closeLayer(); setTimeout(copyPicker, 260); } else copyPicker(); },
  'save-meal': () => { closeLayer(); setTimeout(saveMealSheet, 260); },
  'clear-day': () => { closeLayer(); setTimeout(() => askConfirm(`Clear everything logged on ${dayName(viewDate, { month: 'short', day: 'numeric' })}?`, 'Clear day', () => change('Day cleared', () => { S.log[viewDate] = []; })), 260); },
  meal: (el) => { const m = S.meals.find((x) => x.id === el.dataset.id); if (m) mealSheet(m); },
  'add-supp': () => { const n = $('#sp-name').value.trim(); if (!n) return; S.supps.push({ id: 's' + uid(), name: n, dose: $('#sp-dose').value.trim() }); save(); refresh(); },
  'del-supp': (el) => { S.supps = S.supps.filter((s) => s.id !== el.dataset.id); save(); refresh(); },
  'sync-kcal': () => { const T = S.targets; T.k = Math.round(T.p * 4 + T.c * 4 + T.f * 9); save(); refresh(); },
  'export-json': () => exportJson(),
  'export-csv': () => exportCsv(),
  'import-json': () => $('#import-file').click(),
  'merge-json': () => $('#merge-file').click(),
  'undo-import': () => askConfirm('Undo the last import and go back to exactly what the app held before it?', 'Undo', () => undoImport()),
  'scan-label': () => { if (scanReady()) scanPick(false); else scanSetupSheet(); },
  'scan-retry': () => { closeLayer(); setTimeout(() => scanPick(false), 280); },
  'scan-gallery': () => { closeLayer(); setTimeout(() => scanPick(true), 280); },
  'scan-manual': () => { const fromAdd = !!addEl; closeLayer(); setTimeout(() => openFoodForm(null, { fromAdd }), 280); },
  'scan-test': (el) => testScanner(el),
  'scan-go-settings': () => { closeLayer(); if (addEl) closeLayer(); tab = 'settings'; setTimeout(() => { window.scrollTo(0, 0); render(); }, 280); },
  install: async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; refresh(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el, e);
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'food-q') { foodQ = e.target.value; renderFoodList(); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.t) {
    const v = parseFloat(t.value);
    if (Number.isFinite(v) && v >= 0) { S.targets[t.dataset.t] = v; save(); const T = S.targets; $('#macro-hint').innerHTML = hint(T.p * 4 + T.c * 4 + T.f * 9, T.k); }
  }
  if (t.id === 'import-file' && t.files[0]) { importJson(t.files[0]); t.value = ''; }
  if (t.id === 'merge-file' && t.files[0]) { importJson(t.files[0], true); t.value = ''; }
  if (t.dataset && t.dataset.scan) { const clean = t.value.replace(/\s+/g, ''); t.value = clean; const c = scanCfg(); c[t.dataset.scan] = clean; setScanCfg(c); }
  if ((t.id === 'scan-file' || t.id === 'scan-file-gallery') && t.files[0]) { const file = t.files[0]; t.value = ''; handleScan(file); }
});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; if (tab === 'settings') afterSettings(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S) return;
  const t = todayStr();
  if (t !== lastToday) { if (viewDate === lastToday) viewDate = t; lastToday = t; refresh(); }
});

/* ---------- boot ---------- */
(async function boot() {
  try {
    await load();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    render();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  } catch (err) {
    $('#view').innerHTML = `<div class="card"><b>Could not start.</b><div class="muted small">${esc(err.message)}</div></div>`;
  }
})();

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
  if (raw) { S = JSON.parse(raw); ensureWorkouts(); return; }
  const seed = await (await fetch('seed.json')).json();
  S = { v: 1, foods: seed.foods, log: {}, meals: [], targets: seed.targets, supps: seed.supplements, suppLog: {}, usual: {}, pins: [], lastBackup: Date.now(), installedAt: Date.now() };
  const byId = Object.fromEntries(S.foods.map((f) => [f.id, f]));
  let n = 0;
  for (const day of seed.history) {
    const base = parseYmd(day.date).getTime() + 8 * 3600e3;
    S.log[day.date] = day.items.map((it) => { const f = byId[it.foodId]; S.usual[f.id] = it.qty; return makeEntry(f, it.qty, base + n++ * 1000); });
  }
  ensureWorkouts();
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
  if (el === checkEl) checkEl = null;
  if (el.classList.contains('full')) {
    document.body.classList.remove('has-add');
    if (el === addEl) addEl = null;
    if (el === coachEl) coachEl = null;
    if (el === workoutEl) {
      workoutEl = null; clearInterval(workoutTick); clearInterval(restTick); releaseWake();
      clearTimeout(saveTimer); save(); render();
    }
  }
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
  if (coachEl) renderCoachHead();
}
function render() {
  $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#fab').hidden = tab !== 'today';
  const v = $('#view');
  const html = { today: viewToday, train: viewTrain, history: viewHistory, foods: viewFoods, settings: viewSettings }[tab]();
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

  const pd = plannedDay(d), ss = sessionOn(d);
  html += `<button class="card coach-card" data-act="goto-train"><span class="coach-ic">${DUMBBELL_SVG}</span><span style="flex:1;min-width:0"><b>${ss ? `${esc(ss.dayName)} ${ss.finishedAt ? '✓ done' : '· in progress'}` : pd ? `Up next: ${esc(pd.name)}` : 'Workouts'}</b><span class="small muted" style="display:block">${ss ? `${doneSets(ss)}/${totalSets(ss)} sets · ${fmtK(volumeOf(ss))} lb` : pd ? `${pd.exercises.length} exercises — tap to open Train` : 'Open Train to log a workout'}</span></span><span class="muted">›</span></button>`;
  const pLeft = T.p - t.p;
  html += `<button class="card coach-card" data-act="open-coach"><span class="coach-ic">${CHAT_SVG}</span><span style="flex:1;min-width:0"><b>Ask your coach</b><span class="small muted" style="display:block">${pLeft > 1 ? `${fmt(pLeft)} g protein to go — what should you eat?` : 'Targets covered — ask about tomorrow or a snack'}</span></span><span class="muted">›</span></button>`;

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
  const issues = findIssues().length;
  return `<div class="top"><div><h1>Foods</h1><div class="sub">${S.foods.length} in your database</div></div>
    <div style="display:flex;gap:8px"><button class="btn" data-act="scan-label" aria-label="Scan a nutrition label" style="padding:10px 12px;color:var(--accent)">${CAMERA_SVG}</button><button class="btn primary" data-act="new-food">+ New</button></div></div>
    <div style="padding:10px 14px 0"><div class="search"><input id="food-q" type="search" placeholder="Search foods…" value="${esc(foodQ)}" autocomplete="off"></div></div>
    <button class="card coach-card" data-act="open-check" style="margin-top:10px"><span class="coach-ic" style="font-size:20px">${issues ? '!' : '✓'}</span><span style="flex:1;min-width:0"><b>Check my database</b><span class="small muted" style="display:block">${issues ? `${issues} thing${issues === 1 ? '' : 's'} to review — wrong calories, duplicates` : 'Nothing to review right now'}</span></span><span class="muted">›</span></button>
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
    ${!isNew && pastCount(f.id) ? `<label class="check"><input type="checkbox" id="ff-hist"> Also update the ${pastCount(f.id)} past log entries with these numbers</label>` : ''}
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
    let updatedPast = 0;
    if (!isNew && $('#ff-hist', el) && $('#ff-hist', el).checked) { snapshotBefore('food edit'); updatedPast = applyPast(target); }
    save(); closeLayer(); refresh(); if (addEl) renderAddBody(); if (checkEl) paintCheck();
    if (isNew && fromAdd) setTimeout(() => openQty({ food: target }), 260);
    else if (updatedPast) toast(`Changes saved · ${updatedPast} past entries updated`, () => undoImport());
    else toast(isNew ? 'Food saved' : 'Changes saved');
  };
  if (!isNew) $('#ff-del', el).onclick = () => askConfirm(`Delete “${food.name}” from your database? Past logs are not affected.`, 'Delete', () => {
    S.foods = S.foods.filter((x) => x.id !== food.id); S.pins = S.pins.filter((x) => x !== food.id); save(); closeLayer(); refresh(); if (addEl) renderAddBody();
  });
}

const DUMBBELL_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/></svg>';
const CHAT_SVG ='<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>';
const SEND_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 11l6-6 6 6"/></svg>';
const CAMERA_SVG ='<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

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
  openLayer(`<div class="sheet-title">Set up the AI features</div>
    <div class="muted" style="margin:6px 0 12px">Label scanning and the coach need a small proxy that holds your Claude API key (one-time setup, steps in the README). Then paste its address and your app token under <b>Settings → AI proxy</b>.</div>
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

/* ---------- COACH: chat with Claude about what to eat next ---------- */
const COACH_KEY = 'lbl.coach'; // conversation lives outside the main state/backups; one conversation per day
let coachEl = null, coachBusy = false, coachDate = null;
let coachMsgs = []; // { role: 'user'|'ai', text, suggestions?: [{food_id, qty, note}], logged?: {idx: true}, error?: true }
const COACH_PROMPTS = ['What should I eat next?', 'How should I progress my weights?', 'Am I stalling on any lifts?', 'How’s my day looking?', 'Easiest way to hit my protein', 'Late-night snack ideas', 'Something quick and cheap'];

/* the coach's voice: a preset plus anything you add. Voice only — the worker keeps every rule, number and safety limit fixed. */
const COACH_PRESETS = {
  default: { label: 'Straight-talking', text: 'A straight-talking training partner: concise, practical, a little humour, no lectures.' },
  hype: { label: 'Hype gym-bro', text: 'High-energy, loud, confident gym humour. Hype the user up, tease them when they skip things, celebrate PRs. Swearing is fine and should sound casual, never forced. Open with a short punchy line, then explain the why in a few real sentences.' },
  dry: { label: 'Dry humour', text: 'Deadpan and a bit sarcastic, understated. Roast gently but never meanly. Concise, with the occasional dry one-liner, and the reasoning explained clearly.' },
  mentor: { label: 'Calm mentor', text: 'Calm, patient and encouraging. Plain language, no jargon dumps, reassuring but honest about what needs work.' },
  sergeant: { label: 'Tough love', text: 'Tough-love drill sergeant. Blunt and demanding, no excuses, but fair, and always finish with one clear next action.' },
  nerd: { label: 'Science nerd', text: 'Evidence-first and nerdy: briefly explain the mechanism (progressive overload, stimulus versus fatigue, protein per meal) and say so when the evidence is mixed.' },
};
/* a starter set of widely used hypertrophy principles: edit freely, they are yours once inserted */
const STARTER_PRINCIPLES = [
  '- Progress by total reps: when the total reps across all my sets reach the top of my target, add the smallest weight jump next session (for 4 sets that is roughly 20 to 24 total reps).',
  '- Stay 1 to 3 reps short of failure on most sets: the early sets nearer 2 to 3 reps in reserve, the last set closest to failure. Avoid grinding to failure.',
  '- Judge volume per week, not per session: roughly 10 to 20 hard sets per muscle per week. If performance or recovery drops, trim sets before adding exercises.',
  '- If a lift stalls for 3 or more sessions, check sleep, food and recovery and adjust sets or reps before simply adding weight.',
  '- Cut junk volume: extra sets that only add fatigue and no extra stimulus.',
].join('\n');
function coachStyleBody() {
  const cs = S.coachStyle || {}, p = COACH_PRESETS[cs.preset] || COACH_PRESETS.default;
  return { persona: [p.text, String(cs.custom || '').trim()].filter(Boolean).join(' ').slice(0, 900), principles: String(cs.principles || '').trim().slice(0, 2000) };
}

function coachLoad(date) {
  try { const o = JSON.parse(localStorage.getItem(COACH_KEY)); coachMsgs = o && o.date === date && Array.isArray(o.msgs) ? o.msgs : []; } catch (e) { coachMsgs = []; }
}
function coachSave() {
  try { localStorage.setItem(COACH_KEY, JSON.stringify({ date: coachDate, msgs: coachMsgs.slice(-40) })); } catch (e) { /* conversation just won't persist */ }
}

function coachContext(date) {
  const T = S.targets, es = entriesOf(date), t = totalsOf(es), r = (n) => Math.round(n * 10) / 10;
  const days = [...Array(7)].map((_, i) => addDays(todayStr(), -i - 1)).filter((d) => (S.log[d] || []).length);
  const avg = (m) => days.reduce((a, d) => a + dayTotals(d)[m], 0) / days.length;
  return {
    date, isToday: date === todayStr(), localTime: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), goal: 'lean bulk',
    targets: { kcal: T.k, protein_g: T.p, carbs_g: T.c, fat_g: T.f, sugar_limit_g: T.s },
    eaten: { kcal: Math.round(t.k), protein_g: r(t.p), carbs_g: r(t.c), fat_g: r(t.f), sugar_g: r(t.s) },
    remaining: { kcal: Math.round(T.k - t.k), protein_g: r(T.p - t.p), carbs_g: r(T.c - t.c), fat_g: r(T.f - t.f) },
    logged: es.map((e) => ({ food: e.name, amount: amountLabel(e), kcal: Math.round(e.per.k * e.qty), protein_g: r(e.per.p * e.qty), carbs_g: r(e.per.c * e.qty), fat_g: r(e.per.f * e.qty) })),
    supplementsTaken: (S.suppLog[date] || []).map((id) => (S.supps.find((s) => s.id === id) || {}).name).filter(Boolean),
    last7DaysAverage: days.length ? { days_logged: days.length, kcal: Math.round(avg('k')), protein_g: r(avg('p')) } : null,
    training: workoutContext(date),
    exercises: exerciseHistoryContext(),
    favouriteFoodIds: favourites(14),
    foods: S.foods.map((f) => ({ id: f.id, name: f.name, serving: f.serving, category: f.cat, kcal: f.k, protein_g: f.p, carbs_g: f.c, fat_g: f.f, usual_servings: usualQty(f.id) })),
  };
}

const chatUrl = () => scanCfg().url.replace(/\/+$/, '') + '/chat';

async function coachSend(text) {
  text = String(text || '').trim();
  if (!text || coachBusy) return;
  if (!scanReady()) { scanSetupSheet(); return; }
  coachMsgs.push({ role: 'user', text });
  coachBusy = true; coachSave(); renderCoachBody(true);
  const cfg = scanCfg();
  const messages = coachMsgs.filter((m) => !m.error).slice(-12).map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text.slice(0, 1900) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    let res;
    try {
      res = await fetch(chatUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': cfg.token }, body: JSON.stringify({ messages, context: coachContext(coachDate), ...coachStyleBody() }), signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) throw new Error((data && data.error) || `Coach server error (${res.status})`);
    coachMsgs.push({ role: 'ai', text: data.reply, suggestions: data.suggestions || [], plan: data.plan || [] });
  } catch (e) {
    coachMsgs.push({ role: 'ai', error: true, text: e.name === 'AbortError' ? 'The coach took too long — try again.' : e instanceof TypeError ? `Couldn’t reach the server (${e.message}). Check your connection, then use Test connection in Settings.` : e.message });
  }
  coachBusy = false; coachSave();
  if (coachEl) renderCoachBody(true);
}

function fmtChat(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^- /gm, '• ');
}

function suggestionRows(m, mi) {
  const rows = (m.suggestions || []).map((s, si) => ({ s, si, f: foodById(s.food_id) })).filter((x) => x.f);
  if (!rows.length) return '';
  const unlogged = rows.filter((x) => !(m.logged && m.logged[x.si]));
  const tot = totalsOf(rows.map((x) => ({ per: x.f, qty: x.s.qty })));
  return `<div class="sugg-list">${rows.map(({ s, si, f }) => {
    const done = m.logged && m.logged[si], tt = totalsOf([{ per: f, qty: s.qty }]);
    return `<div class="sugg"><div class="sugg-main"><div class="name">${esc(f.name)}</div>
      <div class="sub">${esc(amountLabel({ serving: f.serving, g: f.g, qty: s.qty }))}${s.note ? ` · ${esc(s.note)}` : ''}</div>
      <div class="mini"><b>${fmtK(tt.k)} kcal</b> · <b class="p-c">P ${fmt(tt.p)}</b> · <b class="c-c">C ${fmt(tt.c)}</b> · <b class="f-c">F ${fmt(tt.f)}</b></div></div>
      ${done ? '<span class="logged-ok">✓ Logged</span>' : `<button class="btn primary sm" data-act="coach-log" data-m="${mi}" data-s="${si}">Log</button>`}</div>`;
  }).join('')}
    ${unlogged.length > 1 ? `<div class="sugg-all"><span class="small muted">Together: <b>${fmtK(tot.k)} kcal</b> · P ${fmt(tot.p)} · C ${fmt(tot.c)} · F ${fmt(tot.f)}</span><button class="btn sm" data-act="coach-log-all" data-m="${mi}">Log all</button></div>` : ''}</div>`;
}

/* weights the coach suggests for your next session of an exercise, with a one-tap "Use it" */
function planRows(m, mi) {
  const rows = (m.plan || []).map((p, pi) => ({ p, pi, ex: findExercise(p.exercise_id) })).filter((x) => x.ex);
  if (!rows.length) return '';
  return `<div class="sugg-list">${rows.map(({ p, pi, ex }) => {
    const done = m.applied && m.applied[pi];
    return `<div class="sugg"><div class="sugg-main"><div class="name">${esc(ex.name)}</div>${p.note ? `<div class="sub">${esc(p.note)}</div>` : ''}
      <div class="mini"><b>Next time: ${p.weights.map((x) => fmt(x)).join(' · ')} lb</b></div></div>
      ${done ? '<span class="logged-ok">✓ Saved</span>' : `<button class="btn primary sm" data-act="coach-plan" data-m="${mi}" data-p="${pi}">Use it</button>`}</div>`;
  }).join('')}</div>`;
}
function applyPlan(mi, pi) {
  const m = coachMsgs[mi], p = m && m.plan && m.plan[pi]; if (!p || !findExercise(p.exercise_id)) return;
  W().nextWeights[p.exercise_id] = p.weights.map(String);
  const s = sessionOn(todayStr()); // a workout already open today? update its unfinished sets right away
  const e = s && s.exercises.find((x) => x.exId === p.exercise_id);
  if (e && !e.sets.every((x) => x.done)) {
    e.sets.forEach((x, i) => { if (!x.done) x.w = String(p.weights[i] !== undefined ? p.weights[i] : p.weights[p.weights.length - 1]); });
    delByExercise(p.exercise_id);
    if (workoutEl) renderWorkout();
  }
  m.applied = m.applied || {}; m.applied[pi] = true;
  save(); coachSave(); if (coachEl) renderCoachBody(false);
  toast(e ? 'Updated today’s workout' : 'Saved — it will be pre-filled next time you train it');
}
function delByExercise(id) { delete W().nextWeights[id]; }

function renderCoachHead() {
  const left = $('#coach-left', coachEl); if (!left) return;
  const t = dayTotals(coachDate), T = S.targets, rem = (m) => fmt(T[m] - t[m]);
  left.innerHTML = `<span class="small muted">${coachDate === todayStr() ? 'Left today' : 'Left on ' + dayName(coachDate, { month: 'short', day: 'numeric' })}</span>
    <span class="nums"><b>${fmtK(T.k - t.k)} kcal</b><b class="p-c">P ${rem('p')}</b><b class="c-c">C ${rem('c')}</b><b class="f-c">F ${rem('f')}</b></span>`;
}

function renderCoachBody(scroll) {
  const body = $('#chat-body', coachEl); if (!body) return;
  let html = '';
  if (!coachMsgs.length) {
    html += `<div class="msg ai">Hey! I can see your food log, your targets, and your lift history. Ask me what to eat next, or how to progress your weights, or tap a question below.</div>`;
  }
  coachMsgs.forEach((m, i) => {
    html += `<div class="msg ${m.role === 'user' ? 'user' : 'ai'}${m.error ? ' err' : ''}">${fmtChat(m.text)}</div>`;
    if (m.role === 'ai' && !m.error) html += suggestionRows(m, i) + planRows(m, i);
  });
  if (coachBusy) html += `<div class="msg ai typing"><i></i><i></i><i></i></div>`;
  body.innerHTML = html;
  const chips = $('#chat-chips', coachEl);
  if (chips) chips.innerHTML = COACH_PROMPTS.map((q) => `<button class="pill" data-act="coach-ask" data-q="${esc(q)}" ${coachBusy ? 'disabled' : ''}>${esc(q)}</button>`).join('');
  if (scroll) body.scrollTop = body.scrollHeight;
}

function openCoach() {
  if (!scanReady()) { scanSetupSheet(); return; }
  coachDate = viewDate; coachLoad(coachDate); coachBusy = false;
  coachEl = openLayer(`
    <div class="add-head"><div style="flex:1;padding-left:2px"><b style="font-size:18px">Coach</b><div class="small muted">${relLabel(coachDate)} · ${dayName(coachDate, { month: 'short', day: 'numeric' })}</div></div>
      <button class="ghost" data-act="coach-clear">Clear</button><button class="ghost" data-act="close-layer">Done</button></div>
    <div class="coach-left" id="coach-left"></div>
    <div class="chat-body" id="chat-body"></div>
    <div class="hscroll" id="chat-chips" style="padding-top:8px"></div>
    <div class="chat-input"><textarea id="chat-text" rows="1" maxlength="1000" placeholder="Ask what to eat…" autocomplete="off"></textarea>
      <button class="send" data-act="coach-send" aria-label="Send">${SEND_SVG}</button></div>`, { full: true });
  const ta = $('#chat-text', coachEl);
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); actions['coach-send'](); } });
  renderCoachHead(); renderCoachBody(true);
}

function coachLogItems(mi, indexes) {
  const m = coachMsgs[mi]; if (!m) return;
  const items = indexes.map((si) => ({ si, s: m.suggestions[si], f: foodById(m.suggestions[si] && m.suggestions[si].food_id) })).filter((x) => x.f && !(m.logged && m.logged[x.si]));
  if (!items.length) return;
  m.logged = m.logged || {};
  change(items.length === 1 ? `Added ${items[0].f.name}` : `Added ${items.length} foods`, () => {
    const list = (S.log[coachDate] = S.log[coachDate] || []);
    let ts = Date.now();
    for (const { s, f, si } of items) { list.push(makeEntry(f, s.qty, ts++)); S.usual[f.id] = s.qty; m.logged[si] = true; }
  });
  coachSave(); if (coachEl) renderCoachBody(false);
}

/* ---------- TRAIN: routine, set logging, rest timer, progress ---------- */
const EX = (id, name, sets, variants) => ({ id, name, sets, variants: variants || [] });
const ROUTINE_VERSION = 4; // v4: bar dips replace close-grip bench; v3: no abs; v2: arms live only on the Arms day
const OLD_ROUTINE_HASHES = [1551759032, -964817554, 1172889878]; // fingerprints of the untouched v1/v2/v3 routines: only an unedited routine gets upgraded
const DEFAULT_REPS = [12, 10, 8, 8]; // rep target per set until you set your own (Train -> Routine)
const repsFor = (ex, i) => { const a = ex.reps && ex.reps.length ? ex.reps : DEFAULT_REPS; return a[i] !== undefined ? a[i] : a[a.length - 1]; };
const repsList = (ex) => Array.from({ length: ex.sets }, (_, i) => repsFor(ex, i));
const DEFAULT_ROUTINE = {
  v: ROUTINE_VERSION,
  days: [
    { id: 'mon', dow: 1, name: 'Chest', exercises: [
      EX('flat-bench', 'Flat bench (variation)', 4),
      EX('incline-db', 'Incline DB press', 4),
      EX('decline-pullover', 'Decline press / DB pullover', 4, ['Decline press', 'DB pullover']),
      EX('pec-deck', 'Pec deck', 4),
      EX('cable-crossover', 'Cable crossover', 4),
    ] },
    { id: 'tue', dow: 2, name: 'Back', exercises: [
      EX('lat-pulldown', 'Lat pulldown', 4),
      EX('tbar-row', 'T-bar row / Barbell row', 4, ['T-bar row', 'Barbell row']),
      EX('single-arm-row', 'Single-arm row', 4),
      EX('rack-pull', 'Rack pull', 4),
      EX('seated-row', 'Seated cable row', 4),
    ] },
    { id: 'thu', dow: 4, name: 'Legs', exercises: [
      EX('leg-ext', 'Leg extension / Hamstring curl', 4, ['Leg extension', 'Hamstring curl']),
      EX('leg-press', 'Leg press (narrow / wide)', 4, ['Leg press - narrow', 'Leg press - wide']),
      EX('squat', 'Squat / Stiff-leg deadlift', 4, ['Squat', 'Stiff-leg deadlift']),
      EX('lunges', 'Walking lunges (reps per leg)', 4),
      EX('calves', 'Calf raises', 4),
    ] },
    { id: 'fri', dow: 5, name: 'Shoulders', exercises: [
      EX('shoulder-press', 'Shoulder press', 4),
      EX('side-lateral', 'Side laterals', 4),
      EX('reverse-pec', 'Reverse pec deck', 4),
      EX('face-pull', 'Cable face pulls', 4),
      EX('shrugs', 'Shrugs', 4),
    ] },
    { id: 'sat', dow: 6, name: 'Arms', exercises: [
      EX('dips', 'Bar dips / Biceps curl', 4, ['Bar dips', 'Biceps curl']),
      EX('oh-triceps', 'Overhead triceps / Pushdowns', 4, ['Overhead triceps press', 'Triceps pushdown']),
      EX('curl', 'DB curls / Barbell curls', 4, ['DB curls', 'Barbell curls']),
      EX('hammer', 'Hammer curls', 4),
    ] },
  ],
};

function ensureWorkouts() {
  if (!S.workouts || typeof S.workouts !== 'object') S.workouts = {};
  const w = S.workouts;
  if (!w.routine || !Array.isArray(w.routine.days)) w.routine = JSON.parse(JSON.stringify(DEFAULT_ROUTINE));
  else if ((w.routine.v || 1) < ROUTINE_VERSION) {
    // upgrade only if the user never edited the original routine; a customised one is left alone
    const sig = JSON.stringify(w.routine.days.map((d) => [d.id, d.name, d.exercises.map((e) => [e.id, e.name, e.sets, (e.variants || []).join('|')])]));
    let h = 5381; for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) | 0;
    if (OLD_ROUTINE_HASHES.includes(h)) w.routine = JSON.parse(JSON.stringify(DEFAULT_ROUTINE));
    else w.routine.v = ROUTINE_VERSION;
  }
  w.sessions = w.sessions || {}; w.baseline = w.baseline || {}; w.prefs = w.prefs || { rest: 90 }; w.nextWeights = w.nextWeights || {};
  if (!S.coachStyle || typeof S.coachStyle !== 'object') S.coachStyle = { preset: 'default', custom: '', principles: '' };
  return w;
}
const W = () => ensureWorkouts();
const dowOf = (d) => parseYmd(d).getDay();
/* Rotation: the next workout is whichever day follows the one you last trained, not a fixed weekday. */
function plannedDay(d) {
  const w = W(), days = w.routine.days;
  if (!days.length) return null;
  const prior = Object.keys(w.sessions).filter((x) => x < d && doneSets(w.sessions[x]) > 0).sort().pop();
  const i = prior ? days.findIndex((x) => x.id === w.sessions[prior].dayId) : -1;
  return days[(i + 1) % days.length];
}
function lastDoneByDay() {
  const out = {};
  for (const d of Object.keys(W().sessions).sort()) if (doneSets(W().sessions[d]) > 0) out[W().sessions[d].dayId] = d;
  return out;
}
function moveDay(id, dir) {
  const a = W().routine.days, i = a.findIndex((x) => x.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]]; save();
}
const sessionOn = (d) => W().sessions[d] || null;
const e1rm = (w, r) => (w > 0 && r > 0 ? w * (1 + r / 30) : 0);
const numOf = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const doneSets = (s) => s.exercises.reduce((n, e) => n + e.sets.filter((x) => x.done).length, 0);
const totalSets = (s) => s.exercises.reduce((n, e) => n + e.sets.length, 0);
const volumeOf = (s) => s.exercises.reduce((v, e) => v + e.sets.filter((x) => x.done).reduce((a, x) => a + numOf(x.w) * numOf(x.r), 0), 0);
const setTxt = (sets) => sets.map((x) => `${x.w === '' || x.w == null ? 'BW' : fmt(numOf(x.w))}×${fmt(numOf(x.r))}`).join('  ');
function findExercise(id) { for (const d of W().routine.days) { const e = d.exercises.find((x) => x.id === id); if (e) return e; } return null; }
const sessionsBefore = (date) => Object.keys(W().sessions).filter((d) => d < date).sort().reverse();
function priorSets(exId, variant, date) {
  for (const d of sessionsBefore(date)) {
    const ex = W().sessions[d].exercises.find((e) => e.exId === exId && (e.variant || '') === (variant || '') && e.sets.some((s) => s.done));
    if (ex) return ex.sets.filter((s) => s.done).map((s) => ({ w: s.w, r: s.r }));
  }
  return null;
}
function lastVariant(exId, date) {
  for (const d of sessionsBefore(date)) {
    const ex = W().sessions[d].exercises.find((e) => e.exId === exId && e.sets.some((s) => s.done));
    if (ex) return ex.variant || '';
  }
  return null;
}
function bestE1rm(exId, variant, date) {
  let best = 0;
  for (const d of sessionsBefore(date)) {
    const ex = W().sessions[d].exercises.find((e) => e.exId === exId && (e.variant || '') === (variant || ''));
    if (ex) for (const s of ex.sets) if (s.done) best = Math.max(best, e1rm(numOf(s.w), numOf(s.r)));
  }
  return best;
}
function nextVariant(ex, date) {
  const i = ex.variants.indexOf(lastVariant(ex.id, date)); // alternate week to week; unknown -> first
  return ex.variants[(i + 1) % ex.variants.length];
}
function prefillSets(ex, v, date, n) {
  const last = priorSets(ex.id, v, date);
  const base = !ex.variants.length || v === ex.variants[0] ? W().baseline[ex.id] : null;
  const out = [];
  let pw = '', pr = '';
  for (let i = 0; i < n; i++) {
    const l = last ? (last[i] || last[last.length - 1]) : null;
    const b = base && base.length ? (base[i] !== undefined ? base[i] : base[base.length - 1]) : null;
    const nwList = W().nextWeights[ex.id]; // weights the coach suggested and you accepted win over everything else
    const nw = nwList && nwList.length ? (nwList[i] !== undefined ? nwList[i] : nwList[nwList.length - 1]) : null;
    const w = nw !== null ? nw : l ? l.w : b !== null && b !== undefined ? b : pw;
    const r = l ? l.r : repsFor(ex, i); // last session's reps, else the exercise's rep scheme (12/10/8/8 by default)
    out.push({ w, r, done: false });
    pw = w; pr = r;
  }
  return out;
}
function buildExercise(ex, date) {
  const v = ex.variants.length ? nextVariant(ex, date) : '';
  const sets = prefillSets(ex, v, date, ex.sets);
  delete W().nextWeights[ex.id]; // accepted coach weights are used once, then normal history takes over
  return { exId: ex.id, name: ex.name, variant: v, sets };
}

let workoutEl = null, workoutDate = null, workoutTick = null, wakeLock = null;
let restEnd = 0, restTick = null, restFired = false, saveTimer = null;
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };
async function requestWake() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ } }
function releaseWake() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }

function startSession(dayId, date) {
  const w = W(), cur = w.sessions[date];
  if (cur && doneSets(cur) > 0 && cur.dayId !== dayId) { toast('Finish or discard today’s workout before starting another'); return; }
  if (!cur || cur.dayId !== dayId) {
    const day = w.routine.days.find((d) => d.id === dayId);
    if (!day) return;
    w.sessions[date] = { dayId: day.id, dayName: day.name, startedAt: Date.now(), exercises: day.exercises.map((ex) => buildExercise(ex, date)) };
    save();
  }
  openWorkout(date);
}

function openWorkout(date) {
  const s = sessionOn(date); if (!s) return;
  workoutDate = date;
  workoutEl = openLayer(`
    <div class="add-head"><div style="flex:1;padding-left:2px;min-width:0"><b style="font-size:18px" id="w-title"></b><div class="small muted" id="w-sub"></div></div>
      <button class="ghost" data-act="w-finish">Finish</button><button class="ghost" data-act="close-layer">Close</button></div>
    <div class="w-body" id="w-body"></div>
    <div class="rest-bar" id="rest-bar" hidden></div>`, { full: true });
  renderWorkout();
  workoutTick = setInterval(updateWorkoutClock, 1000);
  requestWake();
}

function updateWorkoutClock() {
  const s = workoutEl && sessionOn(workoutDate); if (!s) return;
  const mins = Math.max(0, Math.round((Date.now() - s.startedAt) / 60000));
  const sub = $('#w-sub', workoutEl);
  if (sub) sub.textContent = `${dayName(workoutDate, { weekday: 'short', month: 'short', day: 'numeric' })} · ${s.finishedAt ? 'finished' : mins + ' min'} · ${doneSets(s)}/${totalSets(s)} sets`;
}

function exerciseCard(s, e, ei) {
  const ex = findExercise(e.exId), variants = ex ? ex.variants : [];
  const last = priorSets(e.exId, e.variant, workoutDate), base = W().baseline[e.exId];
  const hint = last && last.length ? `Last time: ${setTxt(last)}` : base && (!variants.length || e.variant === variants[0]) ? `Starting weights from your sheet: ${base.map((x) => fmt(x)).join(' · ')}` : 'First time — enter your weights and reps once.';
  return `<div class="xcard" data-ei="${ei}">
    <div class="xhead"><b>${esc(e.variant || e.name)}</b><button class="ghost sm0" data-act="ex-progress" data-id="${esc(e.exId)}">History</button></div>
    ${variants.length > 1 ? `<div class="chips" style="margin:6px 0">${variants.map((v) => `<button class="pill sm1 ${v === e.variant ? 'on' : ''}" data-act="w-variant" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>` : ''}
    <div class="xlast">${esc(hint)}</div>
    <div class="sgrid">
      <div class="lbls"><span></span><span>lb</span><span>reps</span><span></span></div>
      ${e.sets.map((st, si) => `<div class="scol ${st.done ? 'done' : ''}" data-si="${si}"><span class="sn">${si + 1}</span>
        <input data-f="w" inputmode="decimal" enterkeyhint="next" value="${esc(st.w)}" placeholder="–" aria-label="Weight, set ${si + 1}">
        <input data-f="r" inputmode="numeric" enterkeyhint="next" value="${esc(st.r)}" placeholder="–" aria-label="Reps, set ${si + 1}">
        <button class="chk" data-act="w-done" aria-label="Mark set ${si + 1} done">✓</button></div>`).join('')}
    </div>
    <div class="xfoot"><button class="btn primary sm" data-act="w-all">${e.sets.length && e.sets.every((x) => x.done) ? 'Undo all' : 'All sets ✓'}</button><button class="btn sm" data-act="w-bump" data-d="5">+5 lb</button><button class="btn sm" data-act="w-bump" data-d="-5">−5 lb</button><button class="btn sm" data-act="w-addset">+ Set</button><button class="btn sm" data-act="w-delset">− Set</button></div></div>`;
}
function repaintCard(ei) {
  const s = sessionOn(workoutDate), card = workoutEl && $$('.xcard', workoutEl)[ei];
  if (s && card) card.outerHTML = exerciseCard(s, s.exercises[ei], ei);
}

function renderWorkout() {
  const s = workoutEl && sessionOn(workoutDate); if (!s) return;
  $('#w-title', workoutEl).textContent = s.dayName;
  updateWorkoutClock();
  $('#w-body', workoutEl).innerHTML = s.exercises.map((e, ei) => exerciseCard(s, e, ei)).join('') +
    `<div class="card" style="margin:10px 2px"><div class="field" style="margin:0"><label>Cardio / walk (minutes, optional)</label><input id="w-cardio" inputmode="numeric" value="${s.cardioMin || ''}" placeholder="0"></div></div>`;
}

function beep() {
  try { const AC = window.AudioContext || window.webkitAudioContext, c = new AC(), o = c.createOscillator(), g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.15; o.start(); setTimeout(() => { o.stop(); c.close(); }, 350); } catch (e) { /* optional */ }
}
function startRest(sec) {
  const bar = workoutEl && $('#rest-bar', workoutEl); if (!bar) return;
  restEnd = Date.now() + sec * 1000; restFired = false;
  bar.hidden = false; bar.classList.remove('over');
  bar.innerHTML = `<div><b id="rest-t" style="font-size:26px;font-variant-numeric:tabular-nums"></b><span class="small muted" id="rest-l" style="margin-left:8px">rest</span></div>
    <div class="rest-btns"><button class="btn sm" data-act="rest-add" data-s="-15">−15</button><button class="btn sm" data-act="rest-add" data-s="15">+15</button><button class="btn sm" data-act="rest-cycle">${W().prefs.rest}s</button><button class="btn sm" data-act="rest-skip">Skip</button></div>`;
  clearInterval(restTick); restTick = setInterval(restUpdate, 250); restUpdate();
}
function restUpdate() {
  const bar = workoutEl && $('#rest-bar', workoutEl), t = bar && $('#rest-t', bar); if (!t) { clearInterval(restTick); return; }
  const left = Math.ceil((restEnd - Date.now()) / 1000);
  if (left > 0) { t.textContent = `${Math.floor(left / 60)}:${pad(left % 60)}`; return; }
  t.textContent = 'Go!'; $('#rest-l', bar).textContent = 'next set'; bar.classList.add('over');
  if (!restFired) { restFired = true; try { if (navigator.vibrate) navigator.vibrate([250, 120, 250]); } catch (e) { /* optional */ } beep(); }
  clearInterval(restTick);
  setTimeout(() => { if (Date.now() >= restEnd + 3500 && bar) bar.hidden = true; }, 4000);
}

function prToast(e, set) { toast(`🏆 New PR · ${e.variant || e.name}: ${fmt(numOf(set.w))} × ${fmt(numOf(set.r))}`); }

function toggleDone(col) {
  const card = col.closest('.xcard'), ei = +card.dataset.ei, s = sessionOn(workoutDate), e = s.exercises[ei], si = +col.dataset.si, set = e.sets[si];
  if (set.done) { set.done = false; save(); repaintCard(ei); updateWorkoutClock(); return; }
  if (numOf(set.r) <= 0) { toast('Enter the reps first'); $('input[data-f="r"]', col).focus(); return; }
  const had = bestE1rm(e.exId, e.variant, workoutDate);
  const prev = Math.max(had, ...e.sets.filter((x, i) => x.done && i !== si).map((x) => e1rm(numOf(x.w), numOf(x.r))));
  set.done = true;
  const nxt = e.sets[si + 1]; // carry the weight forward if the next set is still empty
  if (nxt && !nxt.done && nxt.w === '' && set.w !== '') nxt.w = set.w;
  save(); repaintCard(ei); updateWorkoutClock();
  if (had > 0 && e1rm(numOf(set.w), numOf(set.r)) > prev) prToast(e, set);
  startRest(W().prefs.rest);
}

/* one tap logs the whole exercise exactly as shown (the usual case); edit any box first if a set differed */
function markAll(ei) {
  const s = sessionOn(workoutDate), e = s.exercises[ei];
  if (e.sets.every((x) => x.done)) { e.sets.forEach((x) => { x.done = false; }); save(); repaintCard(ei); updateWorkoutClock(); return; }
  if (e.sets.some((x) => !x.done && numOf(x.r) <= 0)) { toast('A set has no reps — fill it in, or remove the set'); return; }
  const had = bestE1rm(e.exId, e.variant, workoutDate);
  let top = null;
  for (const x of e.sets) { if (!x.done) x.done = true; if (!top || e1rm(numOf(x.w), numOf(x.r)) > e1rm(numOf(top.w), numOf(top.r))) top = x; }
  save(); repaintCard(ei); updateWorkoutClock();
  if (had > 0 && top && e1rm(numOf(top.w), numOf(top.r)) > had) prToast(e, top);
}
function bumpWeights(ei, d) {
  const e = sessionOn(workoutDate).exercises[ei];
  for (const x of e.sets) if (!x.done && numOf(x.w) > 0) x.w = String(Math.max(0, Math.round((numOf(x.w) + d) * 100) / 100));
  save(); repaintCard(ei);
}

function finishSheet() {
  const s = sessionOn(workoutDate); if (!s) return;
  const n = doneSets(s);
  const el = openLayer(`<div class="sheet-title">${n ? 'Finish workout?' : 'No sets logged yet'}</div>
    <div class="muted" style="margin:6px 0 12px">${n} of ${totalSets(s)} sets done · ${fmtK(volumeOf(s))} lb total volume${s.cardioMin ? ` · ${s.cardioMin} min cardio` : ''}</div>
    <div class="btn-row"><button class="btn danger" id="w-discard">Discard</button><button class="btn primary" id="w-save" ${n ? '' : 'disabled'}>Finish</button></div>`);
  $('#w-save', el).onclick = () => { s.finishedAt = Date.now(); save(); closeLayer(); closeLayer(); toast(`Workout saved · ${n} sets, ${fmtK(volumeOf(s))} lb`); };
  $('#w-discard', el).onclick = () => { delete W().sessions[workoutDate]; save(); closeLayer(); closeLayer(); toast('Workout discarded'); };
}

function viewTrain() {
  const w = W(), today = todayStr(), planned = plannedDay(today), sess = sessionOn(today);
  let html = `<div class="top"><div><h1>Train</h1><div class="sub">${dayName(today, { weekday: 'long', month: 'short', day: 'numeric' })}</div></div><button class="btn" data-act="edit-routine">Routine</button></div>`;
  if (sess) {
    const n = doneSets(sess);
    html += `<div class="card"><h2>${sess.finishedAt ? 'Done today ✓' : 'In progress'}</h2><div style="font-size:19px;font-weight:700">${esc(sess.dayName)}</div>
      <div class="muted" style="margin:4px 0 12px">${n}/${totalSets(sess)} sets · ${fmtK(volumeOf(sess))} lb volume${sess.cardioMin ? ` · ${sess.cardioMin} min cardio` : ''}</div>
      <button class="btn primary block" data-act="w-open" data-d="${today}">${sess.finishedAt ? 'View / edit' : 'Continue workout'}</button></div>`;
  } else if (planned) {
    const lastDone = lastDoneByDay()[planned.id];
    html += `<div class="card"><h2>Up next</h2><div style="font-size:19px;font-weight:700">${esc(planned.name)}</div>
      <div class="muted small" style="margin:4px 0 12px">${planned.exercises.map((x) => esc(x.name.split(' / ')[0])).join(' · ')}${lastDone ? ` · last done ${dayName(lastDone, { month: 'short', day: 'numeric' })}` : ''}</div>
      <button class="btn primary block" data-act="w-start" data-day="${planned.id}">Start ${esc(planned.name)}</button>
      <div class="small muted" style="margin-top:8px">Workouts follow a rotation, not the calendar. Skip a day and the next one simply waits for you.</div></div>`;
  }
  html += `<button class="card coach-card" data-act="open-coach"><span class="coach-ic">${CHAT_SVG}</span><span style="flex:1;min-width:0"><b>Ask your coach about your lifts</b><span class="small muted" style="display:block">Weight progression, plateaus, what to add next</span></span><span class="muted">›</span></button>`;
  const lastBy = lastDoneByDay();
  html += `<div class="list"><div class="list-h"><h2>Rotation</h2></div>${w.routine.days.map((d, i) => {
    const isNext = planned && d.id === planned.id && !sess;
    return `<button class="row" data-act="w-start" data-day="${d.id}"><div class="row-main"><div class="name">${i + 1}. ${esc(d.name)}</div><div class="sub">${d.exercises.length} exercises · ${lastBy[d.id] ? 'last ' + dayName(lastBy[d.id], { month: 'short', day: 'numeric' }) : 'not done yet'}</div></div>${isNext ? '<span class="pill on" style="padding:5px 11px;font-size:13px">Up next</span>' : '<span class="ghost" style="padding:0">Start</span>'}</button>`;
  }).join('')}</div>`;
  const past = Object.keys(w.sessions).sort().reverse().filter((d) => d !== today || w.sessions[d].finishedAt).slice(0, 10);
  html += `<div class="list"><div class="list-h"><h2>Recent workouts</h2></div>${past.length ? past.map((d) => { const s = w.sessions[d]; return `<button class="row" data-act="sess-view" data-d="${d}"><div class="row-main"><div class="name">${esc(s.dayName)}</div><div class="sub">${dayName(d, { weekday: 'short', month: 'short', day: 'numeric' })} · ${doneSets(s)} sets</div></div><div class="row-right"><div class="kcal">${fmtK(volumeOf(s))}</div><div class="mini">lb volume</div></div></button>`; }).join('') : '<div class="empty">Your finished workouts show up here.</div>'}</div>`;
  const ids = []; w.routine.days.forEach((d) => d.exercises.forEach((x) => { if (!ids.includes(x.id)) ids.push(x.id); }));
  html += `<div class="list"><div class="list-h"><h2>Exercise progress</h2></div>${ids.map((id) => {
    const ex = findExercise(id); let top = '';
    for (const d of Object.keys(w.sessions).sort().reverse()) { const e = w.sessions[d].exercises.find((x) => x.exId === id && x.sets.some((s) => s.done)); if (e) { const best = e.sets.filter((s) => s.done).sort((a, b) => e1rm(numOf(b.w), numOf(b.r)) - e1rm(numOf(a.w), numOf(a.r)))[0]; top = `Last top set: ${fmt(numOf(best.w))} × ${fmt(numOf(best.r))}`; break; } }
    return `<button class="row" data-act="ex-progress" data-id="${esc(id)}"><div class="row-main"><div class="name">${esc(ex.name)}</div><div class="sub">${top || 'No sessions logged yet'}</div></div><span class="muted">›</span></button>`;
  }).join('')}</div>`;
  return html;
}

function sparkline(vals) {
  if (vals.length < 2) return '';
  const wd = 280, ht = 56, mn = Math.min(...vals), mx = Math.max(...vals), rg = mx - mn || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * wd},${ht - 6 - ((v - mn) / rg) * (ht - 12)}`).join(' ');
  return `<svg viewBox="0 0 ${wd} ${ht}" width="100%" height="${ht}" preserveAspectRatio="none" style="margin:8px 0"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function exProgressSheet(exId) {
  const ex = findExercise(exId); if (!ex) return;
  const hist = Object.keys(W().sessions).sort().map((d) => ({ d, e: W().sessions[d].exercises.find((x) => x.exId === exId) })).filter((x) => x.e && x.e.sets.some((s) => s.done));
  const topOf = (e) => Math.max(...e.sets.filter((s) => s.done).map((s) => e1rm(numOf(s.w), numOf(s.r))));
  const best = hist.length ? Math.max(...hist.map((h) => topOf(h.e))) : 0;
  openLayer(`<div class="sheet-title">${esc(ex.name)}</div>
    <div class="muted small">${hist.length} session${hist.length === 1 ? '' : 's'} logged${best ? ` · best estimated 1-rep max ${fmtK(best)} lb` : ''}</div>
    ${sparkline(hist.map((h) => topOf(h.e)))}
    <div class="list" style="margin:8px 0 0">${hist.slice().reverse().slice(0, 12).map((h) => `<div class="row"><div class="row-main"><div class="name">${dayName(h.d, { month: 'short', day: 'numeric' })}${h.e.variant ? ` · ${esc(h.e.variant)}` : ''}</div><div class="sub">${esc(setTxt(h.e.sets.filter((s) => s.done)))}</div></div></div>`).join('') || '<div class="empty">Nothing logged yet.</div>'}</div>`);
}
function sessionViewSheet(d) {
  const s = sessionOn(d); if (!s) return;
  const el = openLayer(`<div class="sheet-title">${esc(s.dayName)}</div>
    <div class="muted small">${dayName(d, { weekday: 'long', month: 'short', day: 'numeric' })} · ${doneSets(s)} sets · ${fmtK(volumeOf(s))} lb${s.cardioMin ? ` · ${s.cardioMin} min cardio` : ''}</div>
    <div class="list" style="margin:10px 0 0">${s.exercises.filter((e) => e.sets.some((x) => x.done)).map((e) => `<div class="row"><div class="row-main"><div class="name">${esc(e.variant || e.name)}</div><div class="sub">${esc(setTxt(e.sets.filter((x) => x.done)))}</div></div></div>`).join('') || '<div class="empty">No sets were logged.</div>'}</div>
    <div class="btn-row"><button class="btn danger" id="sv-del">Delete</button><button class="btn primary" id="sv-edit">Edit</button></div>`);
  $('#sv-edit', el).onclick = () => { closeLayer(); setTimeout(() => openWorkout(d), 280); };
  $('#sv-del', el).onclick = () => { closeLayer(); setTimeout(() => askConfirm(`Delete this ${s.dayName} workout?`, 'Delete', () => { delete W().sessions[d]; save(); refresh(); toast('Workout deleted'); }), 280); };
}

function paintRoutine() {
  const box = $('#rt-list'); if (!box) return;
  const days = W().routine.days;
  box.innerHTML = days.map((d, i) => `<div class="row"><button class="row-main" data-act="edit-day" data-id="${d.id}" style="text-align:left"><div class="name">${i + 1}. ${esc(d.name)}</div><div class="sub">${d.exercises.map((x) => esc(x.name.split(' / ')[0])).join(', ')}</div></button>
    <div class="rx-btns" style="margin:0"><button data-act="day-move" data-id="${d.id}" data-dir="-1" aria-label="Move earlier" ${i === 0 ? 'disabled' : ''}>↑</button><button data-act="day-move" data-id="${d.id}" data-dir="1" aria-label="Move later" ${i === days.length - 1 ? 'disabled' : ''}>↓</button></div></div>`).join('');
}
function routineSheet() {
  openLayer(`<div class="sheet-title">Your rotation</div><div class="muted small">Workouts repeat in this order, whatever day of the week it is. Use ↑ ↓ to reorder, or tap a day to rename it or change its exercises. History stays attached to each exercise.</div>
    <div class="list" style="margin:12px 0 0" id="rt-list"></div>`);
  paintRoutine();
}
function editDaySheet(dayId) {
  const day = W().routine.days.find((d) => d.id === dayId); if (!day) return;
  const draft = JSON.parse(JSON.stringify(day));
  const el = openLayer(`<div class="sheet-title">Edit day</div>
    <div class="field" style="margin-top:10px"><label>Day name</label><input id="rd-name" value="${esc(draft.name)}"></div>
    <div id="rd-list"></div>
    <button class="btn block" id="rd-add" style="margin-top:6px">+ Add exercise</button>
    <div class="muted small" style="margin:10px 0">Variants: separate with commas to alternate between versions week to week (e.g. “T-bar row, Barbell row”).</div>
    <div class="btn-row"><button class="btn primary" id="rd-save">Save</button></div>`);
  const list = $('#rd-list', el);
  const read = () => { draft.name = $('#rd-name', el).value.trim() || day.name; $$('.rx', el).forEach((box, i) => { const e = draft.exercises[i]; e.name = $('.rx-name', box).value.trim() || e.name; const reps = $('.rx-reps', box).value.split(/[^0-9]+/).map(Number).filter((n) => n > 0).slice(0, 8); if (reps.length) { e.reps = reps; e.sets = reps.length; } e.variants = $('.rx-var', box).value.split(',').map((x) => x.trim()).filter(Boolean); }); };
  const paint = () => {
    list.innerHTML = draft.exercises.map((e, i) => `<div class="rx" data-i="${i}"><input class="rx-name" value="${esc(e.name)}" aria-label="Exercise name">
      <div class="rx-row"><label style="width:46%">Reps per set<input class="rx-reps" inputmode="numeric" placeholder="12, 10, 8, 8" value="${esc(repsList(e).join(', '))}"></label><label style="flex:1">Variants (optional)<input class="rx-var" value="${esc(e.variants.join(', '))}"></label></div>
      <div class="rx-btns"><button data-rx="up">↑ Up</button><button data-rx="down">↓ Down</button><button data-rx="del" style="color:var(--danger)">✕ Remove</button></div></div>`).join('');
  };
  paint();
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-rx]'); if (!b) return;
    read(); const i = +b.closest('.rx').dataset.i, a = draft.exercises;
    if (b.dataset.rx === 'del') a.splice(i, 1);
    if (b.dataset.rx === 'up' && i > 0) [a[i - 1], a[i]] = [a[i], a[i - 1]];
    if (b.dataset.rx === 'down' && i < a.length - 1) [a[i + 1], a[i]] = [a[i], a[i + 1]];
    paint();
  });
  $('#rd-add', el).onclick = () => { read(); draft.exercises.push(EX('x' + uid(), 'New exercise', 4)); paint(); };
  $('#rd-save', el).onclick = () => {
    read();
    if (!draft.exercises.length) { toast('Keep at least one exercise'); return; }
    day.name = draft.name; day.exercises = draft.exercises;
    save(); closeLayer(); refresh(); toast('Routine saved');
  };
}

function exportWorkoutsCsv() {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Date', 'Workout', 'Exercise', 'Variant', 'Set', 'Weight (lb)', 'Reps', 'Est. 1RM (lb)', 'Cardio (min)']];
  for (const d of Object.keys(W().sessions).sort()) {
    const s = W().sessions[d];
    for (const e of s.exercises) e.sets.forEach((x, i) => { if (x.done) rows.push([d, s.dayName, e.name, e.variant || '', i + 1, numOf(x.w), numOf(x.r), Math.round(e1rm(numOf(x.w), numOf(x.r))), s.cardioMin || '']); });
  }
  download(`lean-bulk-log-workouts-${todayStr()}.csv`, '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n'), 'text/csv');
  toast(rows.length > 1 ? 'Workouts CSV exported' : 'No finished sets to export yet');
}

/* what the coach needs to talk about progression: per exercise, the last few sessions' sets, best 1RM estimate, rep scheme */
function exerciseHistoryContext() {
  const w = W(), seen = new Set(), out = [];
  const dates = Object.keys(w.sessions).sort().reverse();
  for (const d of w.routine.days) for (const ex of d.exercises) {
    if (seen.has(ex.id)) continue;
    seen.add(ex.id);
    const recent = [];
    let best = 0;
    for (const date of dates) {
      const e = w.sessions[date].exercises.find((x) => x.exId === ex.id && x.sets.some((s) => s.done));
      if (!e) continue;
      for (const s of e.sets) if (s.done) best = Math.max(best, e1rm(numOf(s.w), numOf(s.r)));
      if (recent.length < 6) recent.push({ date, variant: e.variant || undefined, sets: e.sets.filter((s) => s.done).map((s) => `${numOf(s.w)}x${numOf(s.r)}`).join(' ') });
    }
    out.push({
      id: ex.id, name: ex.name, variants: ex.variants.length ? ex.variants : undefined, day: d.name, planned_reps_per_set: repsList(ex),
      sessions_logged: recent.length, recent_sessions: recent, best_estimated_1rm_lb: Math.round(best) || undefined,
      starting_weights_lb: !recent.length && w.baseline[ex.id] ? w.baseline[ex.id] : undefined,
    });
  }
  return out;
}

function workoutContext(date) {
  const w = W(), planned = plannedDay(date), s = sessionOn(date);
  const last7 = [...Array(7)].map((_, i) => addDays(todayStr(), -i)).filter((d) => w.sessions[d] && doneSets(w.sessions[d])).map((d) => ({ date: d, workout: w.sessions[d].dayName, sets: doneSets(w.sessions[d]), volume_lb: Math.round(volumeOf(w.sessions[d])) }));
  return {
    nextInRotation: planned ? planned.name : null,
    today: s ? { workout: s.dayName, finished: !!s.finishedAt, sets_done: doneSets(s), volume_lb: Math.round(volumeOf(s)), cardio_min: s.cardioMin || 0, exercises: s.exercises.filter((e) => e.sets.some((x) => x.done)).map((e) => ({ name: e.variant || e.name, sets: setTxt(e.sets.filter((x) => x.done)) })) } : null,
    last7Days: last7,
  };
}

/* ---------- DATABASE CHECK: find likely mistakes in your foods and fix them in one tap ---------- */
let checkEl = null, checkIssues = [];
const baseName = (n) => String(n).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const parenOf = (n) => ((String(n).match(/\((.*?)\)/) || [])[1] || '').toLowerCase().trim();
const pastCount = (id) => Object.values(S.log).reduce((n, es) => n + es.filter((e) => e.foodId === id).length, 0);
const macroSnap = (f) => ({ k: f.k, p: f.p, c: f.c, f: f.f, s: f.s });

/* push a food's current numbers into every logged entry that used it */
function applyPast(food) {
  let n = 0;
  for (const es of Object.values(S.log)) for (const e of es) if (e.foodId === food.id) { e.per = macroSnap(food); e.serving = food.serving; e.g = food.g || null; n++; }
  return n;
}

function findIssues() {
  S.checkIgnored = S.checkIgnored || [];
  const ign = new Set(S.checkIgnored), out = [], covered = new Set();
  const add = (key, o) => { if (!ign.has(key)) out.push({ key, ...o }); };
  const ok = (v) => Math.round(v * 10) / 10;

  for (const f of S.foods) { // known problem from the original spreadsheet: honey stored with tablespoon numbers
    if (f.name.trim().toLowerCase() === 'honey' && /tsp|teaspoon/i.test(f.serving) && f.k >= 55) {
      covered.add(f.id);
      add(`honey:${f.id}`, { kind: 'Known problem', foods: [f.id], title: `${f.name} has tablespoon numbers`,
        detail: `“${f.serving}” is stored as ${f.k} kcal and ${ok(f.c)} g carbs. Those are the numbers for a tablespoon (21 g). A real teaspoon is about 21 kcal and 5.8 g carbs, so every teaspoon you log is overcounted by roughly ${Math.round(f.k - 21)} kcal.`,
        actions: [{ label: 'Make it a real teaspoon', fix: 'honey-tsp', primary: true }, { label: 'I measure tablespoons', fix: 'honey-tbsp' }] });
    }
  }

  const buckets = {};
  for (const f of S.foods) { const key = `${baseName(f.name)}|${String(f.serving).toLowerCase().replace(/\s+/g, '')}`; (buckets[key] = buckets[key] || []).push(f); }
  for (const list of Object.values(buckets)) {
    if (list.length < 2) continue;
    if (new Set(list.map((f) => parenOf(f.name)).filter(Boolean)).size >= 2) continue; // e.g. Grilled vs Steamed are genuinely different foods
    add(`dupe:${list.map((f) => f.id).sort().join(',')}`, { kind: 'Possible duplicate', foods: list.map((f) => f.id), title: `${list.length} entries look like the same food`,
      detail: list.map((f) => `${f.name}: ${f.k} kcal · P ${ok(f.p)} · C ${ok(f.c)} · F ${ok(f.f)} · logged ${pastCount(f.id)}×`).join('\n'),
      actions: list.map((f) => ({ label: `Keep “${f.name}”`, fix: 'keep', id: f.id })).concat([{ label: 'They’re different', fix: 'ignore' }]) });
  }

  for (const f of S.foods) {
    if (covered.has(f.id)) continue;
    const calc = 4 * f.p + 4 * f.c + 9 * f.f, tol = Math.max(35, 0.2 * f.k);
    if (f.k > 0 && f.p + f.c + f.f === 0) add(`nomac:${f.id}`, { kind: 'Missing numbers', foods: [f.id], title: `${f.name} has calories but no macros`, detail: `${f.k} kcal, but protein, carbs and fat are all 0.`, actions: [{ label: 'Edit', fix: 'edit', primary: true }, { label: 'Looks fine', fix: 'ignore' }] });
    else if (f.k === 0 && f.p + f.c + f.f > 1) add(`nokcal:${f.id}`, { kind: 'Missing numbers', foods: [f.id], title: `${f.name} has macros but 0 calories`, detail: `Its macros add up to about ${Math.round(calc)} kcal.`, actions: [{ label: `Set calories to ${Math.round(calc)}`, fix: 'kcal', primary: true }, { label: 'Edit', fix: 'edit' }, { label: 'Looks fine', fix: 'ignore' }] });
    else if (Math.abs(f.k - calc) > tol) add(`kcal:${f.id}`, { kind: 'Calories don’t match macros', foods: [f.id], title: f.name,
      detail: `${f.serving}: listed ${f.k} kcal, but ${ok(f.p)} g protein + ${ok(f.c)} g carbs + ${ok(f.f)} g fat adds up to about ${Math.round(calc)} kcal. Fibre or sugar alcohols can explain a gap — if the label says so, tap “Looks fine”.`,
      actions: [{ label: `Set calories to ${Math.round(calc)}`, fix: 'kcal', primary: true }, { label: 'Edit', fix: 'edit' }, { label: 'Looks fine', fix: 'ignore' }] });
    if (f.s > f.c + 0.5) add(`sugar:${f.id}`, { kind: 'Sugar above carbs', foods: [f.id], title: f.name, detail: `Sugar (${ok(f.s)} g) can’t be more than total carbs (${ok(f.c)} g).`, actions: [{ label: `Set sugar to ${ok(f.c)} g`, fix: 'sugar', primary: true }, { label: 'Edit', fix: 'edit' }, { label: 'Looks fine', fix: 'ignore' }] });
    if (f.g && f.p + f.c + f.f > f.g * 1.02) add(`mass:${f.id}`, { kind: 'Serving weight looks wrong', foods: [f.id], title: f.name, detail: `${f.serving} weighs ${f.g} g, but the protein, carbs and fat add up to ${ok(f.p + f.c + f.f)} g — more than the whole serving. Either the weight or the macros are off.`, actions: [{ label: 'Edit', fix: 'edit', primary: true }, { label: 'Looks fine', fix: 'ignore' }] });
    else if (f.g && (f.k / f.g > 9.3 || (f.k > 30 && f.k / f.g < 0.08))) add(`dens:${f.id}`, { kind: 'Serving weight looks wrong', foods: [f.id], title: f.name, detail: `${f.k} kcal in ${f.g} g is ${ok(f.k / f.g)} kcal per gram, which isn’t realistic for food.`, actions: [{ label: 'Edit', fix: 'edit', primary: true }, { label: 'Looks fine', fix: 'ignore' }] });
    if (f.cat === 'Other') add(`cat:${f.id}`, { kind: 'No category', foods: [f.id], title: f.name, detail: 'Filed under “Other”, so it’s harder to find when you browse by category.', actions: [{ label: 'Edit', fix: 'edit', primary: true }, { label: 'Fine as is', fix: 'ignore' }] });
  }
  const order = ['Known problem', 'Possible duplicate', 'Missing numbers', 'Calories don’t match macros', 'Sugar above carbs', 'Serving weight looks wrong', 'No category'];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

function paintCheck() {
  const box = checkEl && $('#chk-body', checkEl); if (!box) return;
  checkIssues = findIssues();
  if (!checkIssues.length) { box.innerHTML = `<div class="empty">✓ Nothing to review.<br><span class="small">Checked ${S.foods.length} foods: calories vs macros, serving weights, duplicates, categories.</span></div>`; return; }
  let html = `<div class="muted small" style="margin-bottom:8px">${checkIssues.length} thing${checkIssues.length === 1 ? '' : 's'} to review across ${S.foods.length} foods. Nothing changes until you tap a fix.</div>`, last = '';
  checkIssues.forEach((it, i) => {
    if (it.kind !== last) { html += `<div class="sect" style="padding:12px 2px 4px">${esc(it.kind)}</div>`; last = it.kind; }
    html += `<div class="issue"><div class="name">${esc(it.title)}</div><div class="small muted" style="white-space:pre-line;margin:3px 0 8px">${esc(it.detail)}</div>
      <div class="xfoot" style="margin-top:0">${it.actions.map((a) => `<button class="btn sm ${a.primary ? 'primary' : ''}" data-act="chk-fix" data-i="${i}" data-fix="${a.fix}" data-id="${esc(a.id || '')}">${esc(a.label)}</button>`).join('')}</div></div>`;
  });
  box.innerHTML = html;
}

function openCheck() {
  checkEl = openLayer(`<div class="sheet-title">Check my database</div><div id="chk-body" style="margin-top:6px"></div>`);
  paintCheck();
}

function applyFoodPatch(f, patch, alsoPast, msg) {
  snapshotBefore('database fix');
  Object.assign(f, patch);
  const n = alsoPast ? applyPast(f) : 0;
  save(); refresh(); if (checkEl) paintCheck(); if (addEl) renderAddBody();
  toast(`${msg}${n ? ` · ${n} past entries recalculated` : ''}`, () => undoImport());
}
function askPast(f, patch, msg) {
  const n = pastCount(f.id);
  if (!n) { applyFoodPatch(f, patch, false, msg); return; }
  const el = openLayer(`<div class="sheet-title">Also fix your past entries?</div>
    <div class="muted" style="margin:6px 0 12px">You’ve logged “${esc(f.name)}” ${n} time${n === 1 ? '' : 's'} with the old numbers. Recalculating changes those days’ totals; leaving them keeps your history exactly as it was logged.</div>
    <div class="btn-row" style="flex-wrap:wrap"><button class="btn" id="ap-no">Fix food only</button><button class="btn primary" id="ap-yes">Fix food + ${n} past</button></div>`);
  $('#ap-no', el).onclick = () => { closeLayer(); setTimeout(() => applyFoodPatch(f, patch, false, msg), 280); };
  $('#ap-yes', el).onclick = () => { closeLayer(); setTimeout(() => applyFoodPatch(f, patch, true, msg), 280); };
}

function runCheckFix(i, fix, id) {
  const it = checkIssues[i]; if (!it) return;
  const f = foodById(it.foods[0]);
  if (fix === 'ignore') { S.checkIgnored.push(it.key); save(); paintCheck(); refresh(); return; }
  if (fix === 'edit') { if (f) openFoodForm(f); return; }
  if (fix === 'keep') {
    const keep = foodById(id), drop = it.foods.filter((x) => x !== id).map(foodById).filter(Boolean); if (!keep) return;
    snapshotBefore('duplicate cleanup');
    const dropIds = new Set(drop.map((d) => d.id));
    for (const es of Object.values(S.log)) for (const e of es) if (dropIds.has(e.foodId)) e.foodId = keep.id; // history now counts toward the one you kept
    for (const m of S.meals) for (const x of m.items) if (dropIds.has(x.foodId)) x.foodId = keep.id;
    S.foods = S.foods.filter((x) => !dropIds.has(x.id));
    S.pins = [...new Set(S.pins.map((p) => (dropIds.has(p) ? keep.id : p)))];
    save(); refresh(); paintCheck(); if (addEl) renderAddBody();
    toast(`Kept “${keep.name}” and removed ${drop.length} duplicate`, () => undoImport()); return;
  }
  if (!f) return;
  if (fix === 'kcal') return askPast(f, { k: Math.round(4 * f.p + 4 * f.c + 9 * f.f) }, `${f.name}: calories set to ${Math.round(4 * f.p + 4 * f.c + 9 * f.f)}`);
  if (fix === 'sugar') return askPast(f, { s: f.c }, `${f.name}: sugar set to ${f.c} g`);
  if (fix === 'honey-tsp') return askPast(f, { serving: '1 tsp (7g)', g: 7, k: 21, p: 0, c: 5.8, f: 0, s: 5.8 }, 'Honey is now a real teaspoon (21 kcal)');
  if (fix === 'honey-tbsp') return askPast(f, { serving: '1 tbsp (21 g)', g: 21, k: 64, p: 0, c: 17.3, f: 0, s: 17.2 }, 'Honey is now 1 tbsp (64 kcal)');
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
  <div class="card"><h2>AI proxy (scanner &amp; coach)</h2><div class="small muted" style="margin-bottom:10px">Powers the label scanner and the coach chat. Needs your own proxy — see the README. The token stays on this phone and is not included in backups.</div>
    <div class="field"><label>Proxy address</label><input id="scan-url" data-scan="url" inputmode="url" autocomplete="off" placeholder="https://lean-bulk-log-scan.your-name.workers.dev" value="${esc(scanCfg().url || '')}"></div>
    <div class="field"><label>App token</label><input id="scan-token" data-scan="token" type="password" autocomplete="off" value="${esc(scanCfg().token || '')}"></div>
    <div class="btn-row" style="margin-top:0"><button class="btn" data-act="scan-test">Test connection</button></div>
    <div class="small muted" id="scan-test-result" style="margin-top:8px"></div></div>
  <div class="card"><h2>Coach personality</h2><div class="small muted" style="margin-bottom:10px">Sets how your coach talks. The advice itself always comes from your real food log, targets and lift history.</div>
    <div class="chips" style="margin-bottom:12px">${Object.entries(COACH_PRESETS).map(([k, p]) => `<button class="pill ${(S.coachStyle.preset || 'default') === k ? 'on' : ''}" data-act="coach-preset" data-p="${k}">${esc(p.label)}</button>`).join('')}</div>
    <div class="field"><label>Your own style notes (optional) — e.g. a YouTuber’s vibe, swearing, answer length</label><textarea data-cs="custom" rows="3" maxlength="500" placeholder="e.g. Style inspiration: … high-energy, funny, swears casually, punchy first line then a few sentences of why.">${esc(S.coachStyle.custom || '')}</textarea></div>
    <div class="field" style="margin-bottom:0"><label>Your coaching principles (optional) — your own notes, in your words</label><textarea data-cs="principles" rows="5" maxlength="2000" placeholder="e.g. Add weight only when I hit the top reps on every set. Keep 1–2 reps in reserve. Don't junk volume.">${esc(S.coachStyle.principles || '')}</textarea></div>
    <button class="btn sm" style="margin-top:8px" data-act="starter-principles">Insert starter principles</button>
    <div class="small muted" style="margin-top:8px">Saved as you type. Your principles take priority over the coach’s default progression rules, but never over safety or your real data.</div></div>
  <div class="card"><h2>Food database</h2><div class="small muted" style="margin-bottom:10px">Looks for wrong calories, impossible serving weights, duplicates and uncategorised foods — including the ones you scanned or added here.</div><button class="btn block" data-act="open-check">Check my database</button></div>
  <div class="card"><h2>Backup &amp; export</h2><div class="small muted" style="margin-bottom:10px">Last backup: <b>${last}</b>. Clearing browser data erases everything here, so export now and then and keep the file in Drive/Photos.</div>
    <div class="btn-row" style="margin-top:0"><button class="btn primary" data-act="export-json">Backup (JSON)</button><button class="btn" data-act="import-json">Restore…</button></div>
    <button class="btn block" style="margin-top:8px" data-act="merge-json">Import history (keep my data)…</button>
    <div class="small muted" style="margin-top:6px"><b>Restore</b> replaces everything. <b>Import history</b> only adds what’s missing — use it to load an old backup without losing newer logs.</div>
    <input type="file" id="merge-file" accept=".json,application/json" hidden>
    ${(() => { const p = readPrev(); return p && p.data ? `<button class="btn block" style="margin-top:8px;color:var(--warn)" data-act="undo-import">Undo last ${esc(p.label)} · ${new Date(p.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</button>` : ''; })()}
    <button class="btn block" style="margin-top:8px" data-act="export-csv">Export food log for Excel (CSV)</button>
    <button class="btn block" style="margin-top:8px" data-act="export-workouts">Export workouts for Excel (CSV)</button>
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
  S = p.data; ensureWorkouts();
  try { localStorage.removeItem(PREV_KEY); } catch (e) { /* ignore */ }
  save(); viewDate = todayStr(); refresh(); if (checkEl) paintCheck(); toast(`Undid the ${p.label} — your data is back`);
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
  // workouts: add sessions for dates you don't already have, and starting weights for exercises without any
  let addedSessions = 0, addedBase = 0;
  if (o.workouts && typeof o.workouts === 'object') {
    const w = ensureWorkouts();
    for (const [d, s] of Object.entries(o.workouts.sessions || {})) if (s && Array.isArray(s.exercises) && !w.sessions[d]) { w.sessions[d] = s; addedSessions++; }
    for (const [k, v] of Object.entries(o.workouts.baseline || {})) if (Array.isArray(v) && v.length && !w.baseline[k]) { w.baseline[k] = v; addedBase++; }
  }
  save(); refresh();
  const anything = addedEntries || addedFoods || addedSessions || addedBase;
  toast(anything ? `Merged ${addedEntries} food entries (${addedDays} new days), ${addedFoods} new foods${addedSessions || addedBase ? `, ${addedSessions} workouts, ${addedBase} starting weights` : ''}` : 'Nothing new to merge — it’s already in the app', anything ? () => { S = JSON.parse(snap); ensureWorkouts(); save(); refresh(); } : null);
  return { addedEntries, addedDays, addedFoods, addedMeals, addedSessions, addedBase };
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
        S = o; ensureWorkouts(); save(); viewDate = todayStr(); refresh();
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
  'goto-train': () => { tab = 'train'; window.scrollTo(0, 0); render(); },
  'w-start': (el) => startSession(el.dataset.day, todayStr()),
  'w-open': (el) => openWorkout(el.dataset.d),
  'w-finish': () => finishSheet(),
  'w-done': (el) => toggleDone(el.closest('.scol')),
  'w-all': (el) => markAll(+el.closest('.xcard').dataset.ei),
  'w-bump': (el) => bumpWeights(+el.closest('.xcard').dataset.ei, +el.dataset.d),
  'w-variant': (el) => {
    const s = sessionOn(workoutDate), ei = +el.closest('.xcard').dataset.ei, e = s.exercises[ei], ex = findExercise(e.exId);
    if (e.variant === el.dataset.v) return;
    if (e.sets.some((x) => x.done)) { toast('Finish or undo this exercise’s sets before switching'); return; }
    e.variant = el.dataset.v; e.sets = prefillSets(ex, e.variant, workoutDate, e.sets.length); save(); renderWorkout();
  },
  'w-addset': (el) => { const s = sessionOn(workoutDate), e = s.exercises[+el.closest('.xcard').dataset.ei], l = e.sets[e.sets.length - 1] || { w: '', r: '' }; e.sets.push({ w: l.w, r: l.r, done: false }); save(); renderWorkout(); },
  'w-delset': (el) => { const s = sessionOn(workoutDate), e = s.exercises[+el.closest('.xcard').dataset.ei]; if (e.sets.length > 1) { e.sets.pop(); save(); renderWorkout(); } },
  'rest-add': (el) => { restEnd += +el.dataset.s * 1000; restFired = false; clearInterval(restTick); restTick = setInterval(restUpdate, 250); const bar = $('#rest-bar', workoutEl); if (bar) bar.classList.remove('over'); restUpdate(); },
  'rest-cycle': (el) => { const o = [60, 90, 120, 180], p = W().prefs; p.rest = o[(o.indexOf(p.rest) + 1) % o.length] || 90; save(); el.textContent = p.rest + 's'; toast(`Default rest: ${p.rest} seconds`); },
  'rest-skip': () => { clearInterval(restTick); restEnd = 0; const bar = $('#rest-bar', workoutEl); if (bar) bar.hidden = true; },
  'ex-progress': (el) => exProgressSheet(el.dataset.id),
  'sess-view': (el) => sessionViewSheet(el.dataset.d),
  'edit-routine': () => routineSheet(),
  'day-move': (el) => { moveDay(el.dataset.id, +el.dataset.dir); paintRoutine(); refresh(); },
  'edit-day': (el) => { const id = el.dataset.id; closeLayer(); setTimeout(() => editDaySheet(id), 280); },
  'export-workouts': () => exportWorkoutsCsv(),
  'open-coach': () => openCoach(),
  'coach-send': () => { const ta = $('#chat-text', coachEl); if (!ta) return; const v = ta.value; ta.value = ''; ta.style.height = 'auto'; coachSend(v); },
  'coach-ask': (el) => coachSend(el.dataset.q),
  'coach-log': (el) => coachLogItems(+el.dataset.m, [+el.dataset.s]),
  'coach-log-all': (el) => { const m = coachMsgs[+el.dataset.m]; if (m) coachLogItems(+el.dataset.m, m.suggestions.map((_, i) => i)); },
  'starter-principles': () => {
    const put = () => { S.coachStyle.principles = STARTER_PRINCIPLES; save(); render(); toast('Starter principles added — edit them to match what you believe'); };
    if ((S.coachStyle.principles || '').trim()) askConfirm('Replace what you wrote in “Your coaching principles” with the starter set?', 'Replace', put); else put();
  },
  'coach-preset': (el) => { S.coachStyle.preset = el.dataset.p; save(); render(); toast(`Coach voice: ${COACH_PRESETS[el.dataset.p].label}`); },
  'open-check': () => openCheck(),
  'chk-fix': (el) => runCheckFix(+el.dataset.i, el.dataset.fix, el.dataset.id),
  'coach-plan': (el) => applyPlan(+el.dataset.m, +el.dataset.p),
  'coach-clear': () => askConfirm('Clear this conversation?', 'Clear', () => { coachMsgs = []; coachSave(); if (coachEl) renderCoachBody(true); }),
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
  const t = e.target;
  if (t.id === 'food-q') { foodQ = t.value; renderFoodList(); }
  if (workoutEl && t.dataset && t.dataset.f && t.closest('.scol')) {
    const col = t.closest('.scol'), card = t.closest('.xcard'), s = sessionOn(workoutDate);
    if (s) { s.exercises[+card.dataset.ei].sets[+col.dataset.si][t.dataset.f] = t.value.replace(',', '.'); saveSoon(); }
  }
  if (t.dataset && t.dataset.cs) { S.coachStyle[t.dataset.cs] = t.value; saveSoon(); }
  if (t.id === 'w-cardio' && workoutEl) { const s = sessionOn(workoutDate); if (s) { s.cardioMin = parseInt(t.value, 10) || 0; saveSoon(); } }
});
// Enter jumps to the same box in the next set (type a whole weights line, like your sheet)
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (e.key !== 'Enter' || !workoutEl || !t.dataset || !t.dataset.f || !t.closest('.scol')) return;
  e.preventDefault();
  const next = t.closest('.scol').nextElementSibling && $(`input[data-f="${t.dataset.f}"]`, t.closest('.scol').nextElementSibling);
  if (next) { next.focus(); next.select(); } else t.blur();
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
  if (document.visibilityState === 'hidden' && S) { clearTimeout(saveTimer); save(); }
  if (document.visibilityState === 'visible' && workoutEl) { requestWake(); if (restEnd) restUpdate(); }
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

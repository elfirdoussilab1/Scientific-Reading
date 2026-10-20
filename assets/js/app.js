// Scientific Reading — a personal library of research papers and LaTeX notes.

import { clickCompletion, closeCompletions, editorKeydown, insertAt, updateCompletions, wrapSelection } from './editor.js';
import { icon } from './icons.js';
import { citeKey, lookup, makeBibtex } from './meta.js';
import { DEFAULT_SETTINGS, Store, serialize } from './store.js';
import { parseMacros, renderInline, renderTeX, texPlain } from './tex.js';
import {
  authorsList, citeAuthors, copyText, debounce, download, esc, fmtDate, lastName, parseDate,
  slugify, splitAuthors, splitTags, timeAgo, todayISO,
} from './util.js';

const store = new Store();
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? '⌘' : 'Ctrl+';

const TOPIC_COLORS = [
  ['Blue', '#5b8def'], ['Teal', '#2bb3a3'], ['Violet', '#9b7bf0'], ['Rose', '#e86a8a'], ['Green', '#5fbf6a'],
  ['Sky', '#4cb8e6'], ['Indigo', '#7c7ff2'], ['Pink', '#d46ad0'], ['Lime', '#a3c94a'], ['Grey', '#9aa0a6'],
];
const NO_TOPIC = '#8b8d94';
const STATUS = {
  'to-read': { label: 'To read', icon: 'bookmark' },
  reading: { label: 'Reading', icon: 'reading' },
  read: { label: 'Read', icon: 'check' },
};
const SUGGESTED_TOPICS = [
  'Reinforcement Learning', 'RLHF & Alignment', 'Diffusion Models', 'Large Language Models',
  'Optimization', 'Learning Theory', 'Generative Models', 'Representation Learning',
];
const LINKS = [['pdf', 'PDF', 'file'], ['arxiv', 'arXiv', 'external'], ['code', 'Code', 'code'], ['url', 'Website', 'link'], ['doi', 'DOI', 'link']];

const pref = {
  get(k, d) { try { return localStorage.getItem(`exlibris:${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`exlibris:${k}`, v); } catch { /* ignore */ } },
};

const ui = {
  route: { name: 'home' },
  view: pref.get('view', 'papers') === 'table' ? 'table' : 'papers',
  group: pref.get('group', 'added') === 'year' ? 'year' : 'added',
  sort: pref.get('sort', 'added'),
  status: 'all',
  draft: null,
  draftKey: null,
  dirty: false,
  writerTab: 'notes',
  writerLayout: 'split',
  pdfOn: pref.get('pdf-on', '1') === '1',
  pdfWidth: +pref.get('pdf-width', 50) || 50,
  abstractOpen: false,
  topicCallback: null,
  currentHash: location.hash,
  ignoreHash: false,
};

// ---------------------------------------------------------------------------
// Data helpers

const lib = () => store.lib;
const S = () => store.lib.settings;
const topicById = (id) => lib().topics.find((t) => t.id === id);
const paperById = (id) => lib().papers.find((p) => p.id === id);
const paperColor = (p) => topicById(p.topics[0])?.color || NO_TOPIC;
const papersIn = (topicId) => lib().papers.filter((p) => p.topics.includes(topicId));
const words = (tex) => (tex ? texPlain(tex).split(/\s+/).filter(Boolean).length : 0);
const fmtWords = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const href = (name, id, q = '') => `#/${name}/${encodeURIComponent(id)}${q}`;

let macroCache = { src: null, macros: {} };
function macros() {
  if (macroCache.src !== S().macros) macroCache = { src: S().macros, macros: parseMacros(S().macros) };
  return macroCache.macros;
}
// Citations: \cite{key} finds a library paper by its BibTeX key, its generated key or its id.
const bibKey = (p) => /@\w+\s*\{\s*([^,\s]+)\s*,/.exec(p.bibtex || '')?.[1] || citeKey(p);
let citeMap = null; // reset whenever the library changes
let citeLib = null;
function resolveCite(key) {
  if (!citeMap || citeLib !== lib()) {
    citeMap = new Map();
    citeLib = lib();
    const papers = lib().papers;
    for (const keyOf of [bibKey, (p) => p.id, citeKey]) for (const p of papers) if (!citeMap.has(keyOf(p))) citeMap.set(keyOf(p), p);
  }
  const p = citeMap.get(key);
  if (p) return { id: p.id, href: href('paper', p.id), title: p.title, authors: p.authors, year: p.year, venue: p.venue };
  const r = lib().references.find((x) => x.key === key);
  return r ? { id: `ref:${r.key}`, href: refUrl(r), external: true, title: r.title, authors: r.authors, year: r.year, venue: r.venue } : null;
}
const refUrl = (r) => r.links?.arxiv || (r.links?.doi && (/^https?:/.test(r.links.doi) ? r.links.doi : `https://doi.org/${r.links.doi}`)) || r.links?.url || r.links?.pdf || '';
/** Papers offered by the \cite{ autocomplete, most recently touched first. */
function citeItems() {
  return lib().papers
    .filter((p) => p.id !== ui.draft?.id)
    .sort((a, b) => (b.updated || b.added || '').localeCompare(a.updated || a.added || ''))
    .map((p) => {
      const key = bibKey(p);
      const title = texPlain(p.title);
      const who = `${citeAuthors(p.authors)}${p.year ? ` ${p.year}` : ''}`;
      return { key, label: title, hint: `${who} · ${key}`, search: `${key} ${title} ${(p.authors || []).join(' ')} ${p.year || ''} ${p.id}`.toLowerCase() };
    })
    .concat([...lib().references].reverse().map((r) => {
      const title = texPlain(r.title);
      const who = `${citeAuthors(r.authors)}${r.year ? ` ${r.year}` : ''}`;
      return { key: r.key, label: title, hint: `${who} · ${r.key} · not in library`, search: `${r.key} ${title} ${(r.authors || []).join(' ')} ${r.year || ''}`.toLowerCase() };
    }));
}

// -- citing a paper that is not in the library

function referenceDialog(query, from, to) {
  ui.refTarget = { from, to };
  ui.refFound = null;
  openDialog(`<form class="dlg" data-form="reference">
    <h2 class="dlg-title">Cite a paper</h2>
    <p class="dlg-text">Paste an arXiv link or ID, a DOI, a BibTeX entry or the title. It is saved as a reference you can cite from any note, without going on your reading list.</p>
    <label class="field"><span>Paper</span><textarea name="q" rows="3" required placeholder="https://arxiv.org/abs/1706.03762">${esc(query)}</textarea></label>
    <div class="ref-found" id="ref-found" hidden></div>
    <label class="check"><input type="checkbox" name="toRead"> Also add it to my reading list (To read)</label>
    <div class="dlg-actions"><span class="grow"></span><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button><button class="btn primary">Find</button></div>
  </form>`);
  if (query.trim()) findReference($('form', dialog()));
}

async function findReference(f) {
  const q = f.elements.q.value.trim();
  const btn = f.querySelector('button.primary');
  const out = $('#ref-found');
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const m = await lookup(q);
    if (!m.title) throw new Error('No paper found');
    ui.refFound = { q, m };
    out.innerHTML = `<b>${inl(m.title)}</b>${esc(authorsList(m.authors || []))}${m.venue || m.year ? ` · ${esc(m.venue || String(m.year))}` : ''}`;
    out.hidden = false;
    btn.textContent = 'Cite';
  } catch (e) {
    ui.refFound = null;
    out.hidden = true;
    btn.textContent = 'Find';
    toast(e.message || 'Lookup failed', 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

/** Saves the paper found by referenceDialog (or reuses a matching one) and cites it. */
function citeReference(m, toRead) {
  const same = (x) => texPlain(x.title).toLowerCase() === texPlain(m.title).toLowerCase();
  const fields = {
    title: m.title, authors: m.authors || [], year: m.year || '', venue: m.venue || '', abstract: m.abstract || '',
    links: Object.fromEntries(Object.entries(m.links || {}).filter(([, v]) => v)), bibtex: m.bibtex || '',
  };
  let key;
  const paper = lib().papers.find(same);
  const ref = !paper && lib().references.find(same);
  if (paper) key = bibKey(paper);
  else if (toRead) {
    const p = { ...newDraft(), ...fields, id: uniqueId(slugify(m.title, 48), new Set(lib().papers.map((x) => x.id))), updated: new Date().toISOString() };
    if (ref) p.bibtex = ref.bibtex; // keeps its key, so earlier citations still resolve
    store.update((l) => {
      l.papers.push(p);
      if (ref) l.references = l.references.filter((x) => x.key !== ref.key);
    }, `Add "${texPlain(p.title).slice(0, 60)}"`);
    key = bibKey(p);
  } else if (ref) key = ref.key;
  else {
    const base = /@\w+\s*\{\s*([^,\s]+)\s*,/.exec(fields.bibtex)?.[1] || citeKey(fields);
    const taken = new Set([...lib().papers.flatMap((p) => [p.id, bibKey(p), citeKey(p)]), ...lib().references.map((r) => r.key)]);
    key = base;
    for (let i = 2; taken.has(key); i++) key = `${base}${i}`;
    const bibtex = (fields.bibtex || makeBibtex(fields)).replace(/(@\w+\s*\{\s*)[^,\s]+/, `$1${key}`);
    store.update((l) => l.references.push({ key, ...fields, bibtex, added: todayISO() }), `Add reference "${texPlain(m.title).slice(0, 60)}"`);
  }
  closeDialog();
  const ta = $('#writer-input');
  if (ta && ui.refTarget) insertAt(ta, ui.refTarget.from, ui.refTarget.to, `${key}$0`);
  toast(paper ? 'Already in your library: cited it' : toRead ? 'Added to your reading list and cited' : 'Cited', 'ok');
}
const texOpts = (prefix) => ({ macros: macros(), prefix, numberSections: S().numberSections, cite: resolveCite });
const inl = (s) => renderInline(s, texOpts('i-'));

function uniqueId(base, taken) {
  let id = base;
  let k = 2;
  while (taken.has(id)) id = `${base}-${k++}`;
  return id;
}

function sortPapers(papers, how = ui.sort) {
  const by = {
    added: (a, b) => (b.added || '').localeCompare(a.added || '') || (b.updated || '').localeCompare(a.updated || ''),
    updated: (a, b) => (b.updated || b.added || '').localeCompare(a.updated || a.added || ''),
    title: (a, b) => texPlain(a.title).localeCompare(texPlain(b.title)),
    year: (a, b) => (+b.year || 0) - (+a.year || 0),
    rating: (a, b) => b.rating - a.rating || (b.added || '').localeCompare(a.added || ''),
  }[how] || (() => 0);
  return [...papers].sort(by);
}

function groupPapers(papers) {
  const groups = new Map();
  const now = new Date();
  for (const p of sortPapers(papers)) {
    let key;
    let label;
    let sub = '';
    if (ui.group === 'year') {
      key = p.year ? String(p.year) : '0000';
      label = p.year ? String(p.year) : 'Year unknown';
    } else {
      const d = parseDate(p.added);
      key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '0000';
      label = d ? d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'Date unknown';
      if (d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) sub = 'this month';
    }
    if (!groups.has(key)) groups.set(key, { key, label, sub, items: [] });
    groups.get(key).items.push(p);
  }
  return [...groups.values()].sort((a, b) => b.key.localeCompare(a.key));
}

function tagCounts() {
  const m = new Map();
  for (const p of lib().papers) for (const t of p.tags) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function pdfUrl(p) {
  if (p.links?.pdf) return p.links.pdf;
  const ax = /arxiv\.org\/abs\/(.+)$/.exec(p.links?.arxiv || '');
  return ax ? `https://arxiv.org/pdf/${ax[1]}` : '';
}

// ---------------------------------------------------------------------------
// Small UI pieces

const venueYear = (p) => [p.venue, p.year && !String(p.venue).includes(String(p.year)) ? p.year : ''].filter(Boolean).join(' · ');
const badge = (s) => `<span class="badge st-${s}">${icon(STATUS[s].icon)}${STATUS[s].label}</span>`;
const stars = (n) => (n ? `<span class="stars" title="${n} / 5">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>` : '');
const topicChip = (t) => `<span class="tchip" style="--c:${t.color}"><i></i>${esc(t.name)}</span>`;
const tagChip = (t) => `<a class="chip" href="${href('tag', t)}">#${esc(t)}</a>`;

function authorsLine(a = []) {
  if (a.length <= 4) return a.map(lastName).join(', ');
  return `${a.slice(0, 3).map(lastName).join(', ')} et al.`;
}

function blurb(p) {
  if (p.tldr) return `<b>TL;DR</b> ${inl(p.tldr)}`;
  const text = texPlain(p.summary || p.abstract || '');
  if (!text) return '';
  return esc(text.length > 240 ? `${text.slice(0, 240).replace(/\s+\S*$/, '')}…` : text);
}

function sheet(p) {
  const t = topicById(p.topics[0]);
  const w = words(p.notes) + words(p.summary);
  const b = blurb(p);
  return `<a class="sheet" href="${href('paper', p.id)}" style="--c:${paperColor(p)}">
    <div class="sheet-head"><span class="sheet-venue">${esc(venueYear(p)) || '&nbsp;'}</span>${badge(p.status)}</div>
    <h3 class="sheet-title">${inl(p.title)}</h3>
    <p class="sheet-authors">${esc(authorsLine(p.authors))}</p>
    ${b ? `<p class="sheet-abstract">${b}</p>` : '<div class="sheet-lines"><i></i><i></i><i></i></div>'}
    <div class="sheet-foot">${t ? topicChip(t) : ''}<span class="grow"></span>
      ${w ? `<span class="sheet-notes" title="Words in your summary and notes">${icon('pen')}${fmtWords(w)}</span>` : ''}
      ${p.favorite ? '<span class="fav-mark" title="Favorite">♥</span>' : ''}${stars(p.rating)}</div>
  </a>`;
}

function table(papers) {
  return `<div class="table-wrap"><table class="ptable">
    <thead><tr><th>Title</th><th class="hide-sm">Topic</th><th class="hide-sm">Venue</th><th>Year</th><th>Status</th><th class="hide-sm">Notes</th><th class="hide-sm">Added</th></tr></thead>
    <tbody>${papers
      .map((p) => {
        const t = topicById(p.topics[0]);
        const w = words(p.notes) + words(p.summary);
        return `<tr data-href="${href('paper', p.id)}">
          <td><a class="pt-title" href="${href('paper', p.id)}">${inl(p.title)}</a><div class="pt-authors">${esc(authorsLine(p.authors))}</div></td>
          <td class="hide-sm">${t ? topicChip(t) : ''}</td>
          <td class="hide-sm muted">${esc(p.venue)}</td><td class="muted num">${esc(p.year || '')}</td>
          <td>${badge(p.status)}</td><td class="hide-sm muted num">${w ? `${fmtWords(w)} w` : '—'}</td>
          <td class="hide-sm muted">${esc(fmtDate(p.added, { month: 'short', day: 'numeric', year: 'numeric' }))}</td></tr>`;
      })
      .join('')}</tbody></table></div>`;
}

const emptyArt = `<svg viewBox="0 0 120 90" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
  <path d="M40 14h34l12 12v52H40z" opacity=".4"/><path d="M30 10h34l12 12v54H30z"/><path d="M64 10v12h12"/>
  <path d="M38 32h30M38 39h30M38 46h22M38 56h30M38 63h18" stroke-linecap="round" opacity=".7"/></g></svg>`;

function emptyState(title, text, actions = '') {
  return `<div class="empty"><div class="empty-art">${emptyArt}</div><h3>${title}</h3>${text ? `<p>${text}</p>` : ''}${actions ? `<div class="empty-actions">${actions}</div>` : ''}</div>`;
}

const logo = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="10" y="3.5" width="17" height="22" rx="2.5" fill="none" stroke="var(--ink-3)" stroke-width="1.6"/>
  <rect x="5.5" y="7" width="17" height="22" rx="2.5" fill="var(--surface)" stroke="var(--accent)" stroke-width="1.8"/>
  <path d="M9.5 13.5h9M9.5 17.5h9M9.5 21.5h6" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round"/></svg>`;

// ---------------------------------------------------------------------------
// Sidebar & top bar

function renderSidebar() {
  const L = lib();
  const r = ui.route;
  const count = (f) => L.papers.filter(f).length;
  const nav = (link, ic, label, n, active) =>
    `<a href="${link}" class="nav-link${active ? ' active' : ''}">${icon(ic)}<span class="label">${label}</span>${n != null ? `<span class="count">${n}</span>` : ''}</a>`;
  const tags = tagCounts().slice(0, 16);
  $('#sidebar').innerHTML = `
    <a href="#/" class="brand"><span class="brand-mark">${logo}</span>
      <span class="brand-text"><span class="brand-title">${esc(S().title || 'My Library')}</span><span class="brand-sub">${S().owner ? `${esc(S().owner)} · ` : ''}${L.papers.length} papers</span></span></a>
    <button class="side-search" data-action="search">${icon('search')}<span>Search</span><kbd>${MAC ? '⌘' : 'Ctrl '}K</kbd></button>
    <nav class="side-nav">
      ${nav('#/', 'library', 'All papers', L.papers.length, r.name === 'home')}
      ${nav('#/list/reading', 'reading', 'Reading now', count((p) => p.status === 'reading'), r.name === 'list' && r.id === 'reading')}
      ${nav('#/list/to-read', 'bookmark', 'Reading list', count((p) => p.status === 'to-read'), r.name === 'list' && r.id === 'to-read')}
      ${nav('#/list/favorites', 'heart', 'Favorites', count((p) => p.favorite), r.name === 'list' && r.id === 'favorites')}
    </nav>
    <div class="side-section">
      <div class="side-head"><span>Topics</span>${store.canEdit ? `<button class="icon-btn sm" data-action="new-topic" title="New topic">${icon('plus')}</button>` : ''}</div>
      <nav>${L.topics
        .map((t) => `<a href="${href('topic', t.id)}" class="nav-link topic${r.name === 'topic' && r.id === t.id ? ' active' : ''}" style="--c:${t.color}">
            <span class="tdot"></span><span class="label">${esc(t.name)}</span><span class="count">${papersIn(t.id).length}</span></a>`)
        .join('') || `<p class="side-hint">${store.canEdit ? 'No topics yet. Create one per research area.' : 'No topics yet.'}</p>`}</nav>
    </div>
    ${tags.length ? `<div class="side-section"><div class="side-head"><span>Tags</span></div><div class="side-tags">${tags
      .map(([t, n]) => `<a class="chip sm${r.name === 'tag' && r.id === t ? ' active' : ''}" href="${href('tag', t)}">#${esc(t)}<span class="n">${n}</span></a>`)
      .join('')}</div></div>` : ''}
    <div class="side-foot">
      <button class="sync" id="sync" data-action="sync-info"></button>
      <button class="icon-btn" data-action="theme" title="Toggle light / dark">${icon(effectiveTheme() === 'dark' ? 'sun' : 'moon')}</button>
      <button class="icon-btn" data-action="settings" title="Settings">${icon('settings')}</button>
    </div>`;
  renderSync();
}

function renderSync() {
  const el = $('#sync');
  if (el) {
    const { state, text } = store.status;
    const ic = { local: 'disk', github: 'github', browser: 'disk', readonly: 'lock' }[store.mode];
    const label = store.mode === 'readonly' ? 'Read-only · Sign in' : state === 'error' ? 'Not synced · Retry' : text;
    el.className = `sync sync-${state} mode-${store.mode}`;
    el.title = state === 'error' ? `${text}\nYour changes are kept in this browser. Click to retry.` : text;
    el.innerHTML = `${icon(state === 'saving' ? 'cloud' : ic)}<span>${esc(label)}</span>`;
  }
  renderSaveState();
}

function renderSaveState() {
  const el = $('#save-state');
  if (!el) return;
  let text;
  let cls = 'ok';
  if (ui.dirty && !ui.draft?.id && !ui.draft?.title.trim()) { text = 'Saves once it has a title'; cls = 'pending'; }
  else if (ui.dirty) { text = 'Editing…'; cls = 'pending'; }
  else if (!ui.draft?.id) { text = 'Saves once it has a title'; cls = 'pending'; }
  else if (store.status.state === 'saving') { text = 'Saving…'; cls = 'pending'; }
  else if (store.status.state === 'error') { text = 'Not synced — kept in this browser'; cls = 'error'; }
  else if (store.dirty && store.mode === 'github') text = 'Saved · committing to GitHub shortly';
  else text = store.mode === 'browser' ? 'Saved in this browser' : 'All changes saved';
  el.className = `save-state ${cls}`;
  el.innerHTML = `<i></i>${text}`;
}

function renderTopbar() {
  $('#topbar').innerHTML = `
    <button class="icon-btn menu-btn" data-action="open-sidebar" aria-label="Open menu">${icon('menu')}</button>
    <button class="top-search" data-action="search">${icon('search')}<span>Search titles, authors, notes…</span><kbd>${MAC ? '⌘' : 'Ctrl '}K</kbd></button>
    <span class="grow"></span>
    ${store.canEdit ? `<a class="btn primary" href="#/new${ui.route.name === 'topic' ? `?topic=${encodeURIComponent(ui.route.id)}` : ''}">${icon('plus')}<span>Add paper</span></a>` : ''}`;
}

// ---------------------------------------------------------------------------
// Library views

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function heatmap(papers) {
  const weeks = 20;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (weeks - 1) * 7);
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const counts = {};
  for (const p of papers) {
    for (const d of [p.added, p.finished, p.updated]) {
      const dd = parseDate(d);
      if (dd) counts[key(dd)] = (counts[key(dd)] || 0) + 1;
    }
  }
  let cells = '';
  const d = new Date(start);
  for (let i = 0; i < weeks * 7; i++) {
    const n = counts[key(d)] || 0;
    const future = d > today;
    cells += `<span class="hm l${Math.min(4, n)}${future ? ' future' : ''}" title="${future ? '' : `${n} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}"></span>`;
    d.setDate(d.getDate() + 1);
  }
  return `<div class="heatmap-card"><div class="heatmap-head"><span>Activity</span><span class="muted">last ${weeks} weeks</span></div>
    <div class="heatmap">${cells}</div>
    <div class="heatmap-legend"><span>Less</span><span class="hm l0"></span><span class="hm l1"></span><span class="hm l2"></span><span class="hm l3"></span><span class="hm l4"></span><span>More</span></div></div>`;
}

/** Toolbar + grouped papers. Shared by every list view. */
function papersSection(papers, { showStatus = true, topicId = null } = {}) {
  const counts = { all: papers.length };
  for (const s of Object.keys(STATUS)) counts[s] = papers.filter((p) => p.status === s).length;
  const shown = showStatus && ui.status !== 'all' ? papers.filter((p) => p.status === ui.status) : papers;
  const seg = (action, cur, v, label, extra = '') => `<button class="seg-btn${cur === v ? ' on' : ''}" data-action="${action}" data-v="${v}">${label}${extra}</button>`;
  const opt = (v, label) => `<option value="${v}"${ui.sort === v ? ' selected' : ''}>${label}</option>`;
  return `
    <div class="toolbar">
      ${showStatus ? `<div class="seg">${['all', 'to-read', 'reading', 'read']
        .map((s) => seg('filter-status', ui.status, s, s === 'all' ? 'All' : STATUS[s].label, `<span class="n">${counts[s]}</span>`)).join('')}</div>` : '<span></span>'}
      <div class="toolbar-right">
        <div class="seg labelled"><span class="seg-label">Group by</span>${seg('set-group', ui.group, 'year', 'Year')}${seg('set-group', ui.group, 'added', 'Date added')}</div>
        <label class="select" title="Order within each group">${icon('list')}<select data-action="sort" aria-label="Sort">
          ${opt('added', 'Recently added')}${opt('updated', 'Recently edited')}${opt('title', 'Title A–Z')}${opt('rating', 'Rating')}${opt('year', 'Year')}</select></label>
        <div class="seg">
          <button class="seg-btn${ui.view === 'papers' ? ' on' : ''}" data-action="set-view" data-v="papers" title="Papers">${icon('grid')}</button>
          <button class="seg-btn${ui.view === 'table' ? ' on' : ''}" data-action="set-view" data-v="table" title="Table">${icon('list')}</button>
        </div>
      </div>
    </div>
    ${shown.length
      ? groupPapers(shown)
          .map((g) => `<section class="group">
              <h2 class="group-head"><span class="group-label">${esc(g.label)}</span>${g.sub ? `<span class="group-sub">${g.sub}</span>` : ''}<span class="group-count">${g.items.length} paper${g.items.length === 1 ? '' : 's'}</span></h2>
              ${ui.view === 'table' ? table(g.items) : `<div class="sheets">${g.items.map(sheet).join('')}</div>`}
            </section>`)
          .join('')
      : emptyState(
          papers.length ? 'Nothing matches this filter' : 'No papers here yet',
          papers.length ? 'Try another status.' : store.canEdit ? 'Add a paper — paste an arXiv link and the details fill themselves in.' : '',
          store.canEdit && !papers.length ? `<a class="btn primary" href="#/new${topicId ? `?topic=${encodeURIComponent(topicId)}` : ''}">${icon('plus')}Add paper</a>` : '',
        )}`;
}

function viewHome() {
  const L = lib();
  const papers = L.papers;
  const name = (S().owner || '').split(' ')[0];
  const head = `<p class="eyebrow">${esc(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
    <h1 class="display">${greeting()}${name ? `, ${esc(name)}` : ''}.</h1>`;
  if (!papers.length && !L.topics.length) {
    return `<section class="hero"><div>${head}<p class="lede">Start with a few topics — one per research area — then add papers to them.</p></div></section>
      ${emptyState('Your library is empty', store.canEdit ? 'Pick some topics to start with, or create your own.' : 'Nothing has been added yet.',
        store.canEdit ? `<div class="suggest">${SUGGESTED_TOPICS.map((n) => `<button class="chip" data-action="quick-topic" data-name="${esc(n)}">${icon('plus')}${esc(n)}</button>`).join('')}</div>
          <button class="btn primary" data-action="new-topic">${icon('plus')}New topic</button>` : '')}`;
  }
  const year = new Date().getFullYear();
  const n = (s) => papers.filter((p) => p.status === s).length;
  const finished = papers.filter((p) => p.status === 'read' && String(p.finished || '').startsWith(year)).length;
  const reading = sortPapers(papers.filter((p) => p.status === 'reading'), 'updated').slice(0, 3);
  return `
    <section class="hero">
      <div>
        ${head}
        <div class="stat-row">
          <a class="stat" href="#/list/reading"><span class="stat-n">${n('reading')}</span><span class="stat-l">reading now</span></a>
          <a class="stat" href="#/list/to-read"><span class="stat-n">${n('to-read')}</span><span class="stat-l">to read</span></a>
          <div class="stat"><span class="stat-n">${finished}</span><span class="stat-l">finished in ${year}</span></div>
        </div>
      </div>
      ${heatmap(papers)}
    </section>
    ${reading.length && store.canEdit ? `<section class="continue"><h2 class="section-title">Continue taking notes</h2><div class="continue-row">${reading
      .map((p) => `<a class="continue-card" href="${href('notes', p.id)}" style="--c:${paperColor(p)}">
          <span class="cc-title">${inl(p.title)}</span><span class="cc-meta">${esc(authorsLine(p.authors))}${p.year ? ` · ${esc(p.year)}` : ''}</span>
          <span class="cc-action">${icon('pen')}Open notes${words(p.notes) ? ` · ${fmtWords(words(p.notes))} words so far` : ''}</span></a>`)
      .join('')}</div></section>` : ''}
    <h2 class="section-title">All papers</h2>
    ${papersSection(papers)}`;
}

function viewCollection(kind, id) {
  const L = lib();
  let title;
  let eyebrow;
  let sub = '';
  let papers;
  let color = 'var(--ink-3)';
  let topic = null;
  let showStatus = true;
  if (kind === 'topic') {
    topic = topicById(id);
    if (!topic) return notFound('This topic does not exist.');
    papers = papersIn(id);
    title = esc(topic.name);
    eyebrow = 'Topic';
    sub = topic.description ? `<p class="lede">${esc(topic.description)}</p>` : '';
    color = topic.color;
  } else if (kind === 'tag') {
    papers = L.papers.filter((p) => p.tags.includes(id));
    title = `#${esc(id)}`;
    eyebrow = 'Tag';
  } else {
    const lists = {
      reading: ['Reading now', 'Status', (p) => p.status === 'reading'],
      'to-read': ['Reading list', 'Status', (p) => p.status === 'to-read'],
      favorites: ['Favorites', 'Collection', (p) => p.favorite],
      all: ['All papers', 'Collection', () => true],
    };
    const def = lists[id];
    if (!def) return notFound();
    [title, eyebrow] = def;
    papers = L.papers.filter(def[2]);
    showStatus = id === 'favorites' || id === 'all';
  }
  return `
    <header class="col-head" style="--c:${color}">
      <div class="col-head-main"><p class="eyebrow">${topic ? '<span class="tdot"></span>' : ''}${eyebrow}</p><h1 class="display">${title}</h1>${sub}</div>
      ${topic && store.canEdit ? `<button class="btn ghost" data-action="edit-topic" data-id="${esc(topic.id)}">${icon('edit')}Edit topic</button>` : ''}
    </header>
    ${papersSection(papers, { showStatus, topicId: topic?.id })}`;
}

function viewPaper(id) {
  const p = paperById(id);
  if (!p) return notFound('This paper is not in your library.');
  const sum = renderTeX(p.summary, texOpts('s-'));
  const notes = renderTeX(p.notes, texOpts('n-'));
  const abs = p.abstract ? renderTeX(p.abstract, texOpts('a-')).html : '';
  const bib = p.bibtex || makeBibtex(p);
  const edit = store.canEdit;
  const links = LINKS.filter(([k]) => p.links[k])
    .map(([k, label, ic]) => `<a class="btn" href="${esc(p.links[k])}" target="_blank" rel="noopener">${icon(ic)}${label}</a>`)
    .join('');
  const tocList = (toc) => (toc.length ? `<ul>${toc.map((t) => `<li class="lv${t.level}"><a data-scroll="${t.id}">${t.num ? `<span class="secnum">${t.num}</span>` : ''}${t.html}</a></li>`).join('')}</ul>` : '');
  const related = lib().papers.filter((q) => q.id !== p.id && q.topics.some((t) => p.topics.includes(t)))
    .sort((a, b) => (b.added || '').localeCompare(a.added || '')).slice(0, 4);
  const statusCtl = Object.entries(STATUS)
    .map(([k, s]) => `<button class="seg-btn${p.status === k ? ' on' : ''}" ${edit ? `data-action="set-status" data-v="${k}"` : 'disabled'}>${icon(s.icon)}${s.label}</button>`).join('');
  const rating = [1, 2, 3, 4, 5]
    .map((k) => `<button class="star${k <= p.rating ? ' on' : ''}" ${edit ? `data-action="rate" data-v="${k}"` : 'disabled'} aria-label="${k} stars">★</button>`).join('');
  const docBody = (r, tab, emptyText) =>
    r.html
      ? `<div class="tex-doc"${edit ? ` data-dbl-edit="${tab}" title="Double-click to edit"` : ''}>${r.html}</div>`
      : `<p class="doc-empty">${emptyText}${edit ? ` <a href="${href('notes', p.id, `?tab=${tab}`)}">Start writing</a>` : ''}</p>`;
  return `
  <article class="paper" style="--c:${paperColor(p)}">
    <nav class="crumbs"><a href="#/">Library</a>${p.topics.map(topicById).filter(Boolean)
      .map((t) => `<span class="sep">/</span><a href="${href('topic', t.id)}" style="--c:${t.color}" class="crumb-topic"><span class="tdot"></span>${esc(t.name)}</a>`).join('')}</nav>
    <header class="paper-head">
      ${venueYear(p) ? `<p class="eyebrow">${esc(venueYear(p))}</p>` : ''}
      <h1 class="paper-title">${inl(p.title)}</h1>
      <p class="paper-authors">${esc(authorsList(p.authors, 14))}</p>
      <div class="paper-controls">
        <div class="seg">${statusCtl}</div>
        <div class="rating">${rating}</div>
        <button class="icon-btn fav${p.favorite ? ' on' : ''}" ${edit ? 'data-action="toggle-fav"' : 'disabled'} title="Favorite">${icon('heart')}</button>
      </div>
      <div class="paper-links">
        ${edit ? `<a class="btn primary" href="${href('notes', p.id)}">${icon('pen')}Take notes<kbd>W</kbd></a>` : ''}
        ${links}
        <button class="btn" data-action="copy-bib">${icon('quote')}Cite</button>
        ${edit ? `<a class="btn ghost" href="${href('edit', p.id)}">${icon('edit')}Edit details<kbd>E</kbd></a><button class="icon-btn danger" data-action="delete-paper" title="Delete paper">${icon('trash')}</button>` : ''}
      </div>
    </header>
    <div class="paper-body">
      <div class="paper-main">
        ${p.tldr ? `<div class="tldr" id="tldr"><span class="tldr-label">TL;DR</span><p>${inl(p.tldr)}</p></div>` : ''}
        ${abs ? `<details class="abstract" data-abstract${ui.abstractOpen ? ' open' : ''}><summary>${icon('chevronRight')}Abstract</summary><div class="tex-doc small">${abs}</div></details>` : ''}
        <section class="doc" id="summary"><h2 class="doc-title"><span>Summary</span>${edit ? `<a class="doc-edit" href="${href('notes', p.id, '?tab=summary')}">${icon('edit')}Edit</a>` : ''}</h2>
          ${docBody(sum, 'summary', 'No summary yet.')}</section>
        <section class="doc" id="notes"><h2 class="doc-title"><span>Notes</span>${edit ? `<a class="doc-edit" href="${href('notes', p.id, '?tab=notes')}">${icon('edit')}Edit</a>` : ''}</h2>
          ${docBody(notes, 'notes', 'No notes yet.')}</section>
        <section class="doc" id="cite"><h2 class="doc-title"><span>BibTeX</span></h2>
          <div class="bibtex"><pre>${esc(bib)}</pre><button class="icon-btn" data-action="copy-bib" title="Copy BibTeX">${icon('copy')}</button></div></section>
      </div>
      <aside class="paper-aside">
        <div class="aside-card toc"><p class="aside-title">On this page</p><ul>
          ${p.tldr ? '<li><a data-scroll="tldr">TL;DR</a></li>' : ''}
          <li><a data-scroll="summary">Summary</a>${tocList(sum.toc)}</li>
          <li><a data-scroll="notes">Notes</a>${tocList(notes.toc)}</li>
          <li><a data-scroll="cite">BibTeX</a></li></ul></div>
        <div class="aside-card"><dl class="facts">
          <dt>Added</dt><dd>${esc(fmtDate(p.added) || '—')}</dd>
          ${p.started ? `<dt>Started</dt><dd>${esc(fmtDate(p.started))}</dd>` : ''}
          ${p.finished ? `<dt>Finished</dt><dd>${esc(fmtDate(p.finished))}</dd>` : ''}
          ${p.updated ? `<dt>Edited</dt><dd>${esc(timeAgo(p.updated))}</dd>` : ''}
          <dt>Written</dt><dd>${fmtWords(words(p.notes) + words(p.summary))} words</dd></dl>
          ${p.tags.length ? `<div class="aside-tags">${p.tags.map(tagChip).join('')}</div>` : ''}</div>
        ${related.length ? `<div class="aside-card"><p class="aside-title">Same topic</p><div class="related">${related
          .map((q) => `<a href="${href('paper', q.id)}"><span class="r-title">${inl(q.title)}</span><span class="r-meta">${esc(authorsLine(q.authors))}${q.year ? ` · ${esc(q.year)}` : ''}</span></a>`).join('')}</div></div>` : ''}
      </aside>
    </div>
  </article>`;
}

function notFound(text = 'Nothing lives at this address.') {
  return emptyState('Not found', esc(text), '<a class="btn" href="#/">Back to the library</a>');
}

// ---------------------------------------------------------------------------
// Editing: one draft shared by the details editor and the notes workspace, autosaved.

function newDraft(topic) {
  return {
    id: '', title: '', authors: [], year: '', venue: '', topics: topic && topicById(topic) ? [topic] : [],
    tags: [], status: 'to-read', rating: 0, favorite: false, links: {}, abstract: '', tldr: '',
    summary: '', notes: S().notesTemplate || DEFAULT_SETTINGS.notesTemplate, bibtex: '', added: todayISO(),
  };
}

function ensureDraft(id, mode, params) {
  if (ui.draftKey === location.hash && ui.draft) return true;
  const existing = id ? paperById(id) : null;
  if (id && !existing) return false;
  ui.draft = existing ? structuredClone(existing) : newDraft(params.get('topic'));
  ui.draftKey = location.hash;
  ui.dirty = false;
  ui.writerTab = params.get('tab') || (mode === 'notes' ? 'notes' : existing && !existing.summary ? 'summary' : 'notes');
  ui.writerLayout = pref.get(`layout-${mode}`, mode === 'notes' ? 'write' : 'split');
  return true;
}

let autosaveTimer = 0;
function draftChanged() {
  ui.dirty = true;
  renderSaveState();
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveDraftNow, 800);
}

function draftHasContent(d) {
  return !!(d.title.trim() || d.authors.length || d.summary.trim() || (d.notes.trim() && d.notes !== (S().notesTemplate || '')));
}

/** Writes the draft into the library. New papers are created as soon as they have a title. */
function saveDraftNow() {
  clearTimeout(autosaveTimer);
  const d = ui.draft;
  if (!d || !ui.dirty) return true;
  if (!d.id && !d.title.trim()) return false;
  const copy = structuredClone(d);
  copy.title = copy.title.replace(/\s+/g, ' ').trim();
  for (const k of Object.keys(copy.links)) if (!copy.links[k]) delete copy.links[k];
  const isNew = !copy.id;
  if (isNew) copy.id = uniqueId(slugify(copy.title, 48), new Set(lib().papers.map((p) => p.id)));
  if (copy.status === 'read' && !copy.finished) copy.finished = todayISO();
  if (copy.status !== 'to-read' && !copy.started) copy.started = copy.finished || todayISO();
  copy.updated = new Date().toISOString();
  const prev = paperById(copy.id);
  const what = isNew ? 'Add' : prev && prev.notes !== copy.notes ? 'Update notes on' : prev && prev.summary !== copy.summary ? 'Update summary of' : 'Update';
  store.update((l) => {
    const i = l.papers.findIndex((p) => p.id === copy.id);
    if (i >= 0) l.papers[i] = copy;
    else l.papers.push(copy);
  }, `${what} "${texPlain(copy.title).slice(0, 60)}"`, { delay: store.mode === 'github' ? 20000 : 300 });
  Object.assign(d, { id: copy.id, finished: copy.finished, started: copy.started, updated: copy.updated });
  ui.dirty = false;
  if (isNew) {
    // Keep editing, now at the paper's permanent address.
    history.replaceState(null, '', href(ui.route.name === 'notes' ? 'notes' : 'edit', copy.id));
    ui.draftKey = ui.currentHash = location.hash;
    ui.route = parseRoute();
    const back = $('#editor-back');
    if (back) back.href = href('paper', copy.id);
  }
  renderSaveState();
  return true;
}

function finishEditing() {
  const d = ui.draft;
  if (!d) return;
  if (!d.id && !d.title.trim()) {
    toast('Give the paper a title first.', 'error');
    $('.title-input')?.focus();
    return;
  }
  saveDraftNow();
  go(href('paper', d.id));
}

function setDraftField(name, value) {
  const d = ui.draft;
  if (name.startsWith('links.')) d.links[name.slice(6)] = value.trim();
  else if (name === 'authors') d.authors = splitAuthors(value);
  else if (name === 'tags') d.tags = splitTags(value);
  else if (name === 'year') d.year = value.trim() ? +value.replace(/\D/g, '') || '' : '';
  else d[name] = value;
}

// -- the LaTeX writer

const TOOLBAR = [
  [['bold', '<b>B</b>', `Bold (${MOD}B)`, '\\textbf{', '}'], ['italic', '<i>I</i>', `Emphasis (${MOD}I)`, '\\emph{', '}'], ['code', '<code>tt</code>', 'Monospace', '\\texttt{', '}']],
  [['math', '$x$', `Inline math (${MOD}M)`, '$', '$'], ['display', '\\[ \\]', 'Display math', '\\[\n  ', '\n\\]'], ['equation', 'eq', 'Numbered equation', '\\begin{equation}\\label{eq:}\n  ', '\n\\end{equation}'], ['align', 'align', 'Aligned equations', '\\begin{align}\n  ', ' &= \\\\\n  &= \n\\end{align}']],
  [['section', '§', 'Section', '\\section{', '}\n'], ['subsection', '§§', 'Subsection', '\\subsection{', '}\n'], ['itemize', '•', 'Bullet list', '\\begin{itemize}\n  \\item ', '\n\\end{itemize}'], ['enumerate', '1.', 'Numbered list', '\\begin{enumerate}\n  \\item ', '\n\\end{enumerate}']],
  [['definition', 'Def', 'Definition', '\\begin{definition}[]\n  ', '\n\\end{definition}'], ['theorem', 'Thm', 'Theorem', '\\begin{theorem}[]\n  ', '\n\\end{theorem}'], ['idea', 'Idea', 'Idea box', '\\begin{idea}\n  ', '\n\\end{idea}'], ['question', '?', 'Open question', '\\begin{question}\n  ', '\n\\end{question}']],
  [['table', 'Tab', 'Table', '\\begin{tabular}{lcc}\n  \\toprule\n  Method & Metric & Metric \\\\\n  \\midrule\n  ', 'Baseline & 0.0 & 0.0 \\\\\n  \\bottomrule\n\\end{tabular}'], ['algorithm', 'Alg', 'Algorithm', '\\begin{algorithmic}\n  \\Require ', '\n  \\For{$t = 1, \\dots, T$}\n    \\State \n  \\EndFor\n\\end{algorithmic}'], ['link', icon('link'), 'Link', '\\href{https://}{', '}'], ['cite', '[1]', 'Citation', '\\cite{', '}'], ['footnote', 'fn', 'Footnote', '\\footnote{', '}'], ['todo', '!', 'TODO', '\\todo{', '}']],
];
const SNIPPETS = Object.fromEntries(TOOLBAR.flat().map(([k, , , a, b]) => [k, [a, b]]));

function writerPlaceholder(tab) {
  return {
    summary: 'What problem, what idea, what result — in a few paragraphs.\n\nType \\ for command suggestions (\\eq → equation, \\al → \\alpha …).\nMath: $\\E_{x\\sim p}[f(x)]$',
    notes: '\\section{Method}\n…\n\nType \\ for command suggestions. Brackets and $…$ close automatically.',
    abstract: 'Paste the abstract (fetched automatically from arXiv).',
    bibtex: 'Leave empty to generate BibTeX from the details, or paste the official entry.',
  }[tab];
}

function writerHTML(tabs) {
  ui.writerTabs = tabs;
  const d = ui.draft;
  const tab = ui.writerTab;
  const lay = (v, ic, t) => `<button class="seg-btn${ui.writerLayout === v ? ' on' : ''}" data-action="writer-layout" data-v="${v}" title="${t}">${icon(ic)}</button>`;
  return `<section class="writer layout-${ui.writerLayout}">
    <div class="writer-bar">
      <div class="tabs">${tabs.map(([k, label]) => `<button class="tab${tab === k ? ' on' : ''}" data-action="writer-tab" data-tab="${k}">${label}</button>`).join('')}</div>
      <span class="grow"></span>
      <span class="save-state" id="save-state"></span>
      <div class="seg small">${lay('write', 'pen', 'Write only')}${lay('split', 'columns', 'Write + preview')}${lay('preview', 'eye', 'Preview only')}</div>
    </div>
    <div class="tex-toolbar"${tab === 'bibtex' ? ' hidden' : ''}>${TOOLBAR.map((g) => `<div class="tb-group">${g.map(([k, label, title]) => `<button class="tb" data-action="snip" data-snip="${k}" title="${esc(title)}">${label}</button>`).join('')}</div>`).join('')}</div>
    <div class="writer-panes">
      <div class="input-wrap">
        <textarea id="writer-input" class="tex-input" spellcheck="${tab === 'bibtex' ? 'false' : 'true'}" data-text="${tab}" placeholder="${esc(writerPlaceholder(tab))}">${esc(d[tab] || '')}</textarea>
        <div class="ac" id="ac" hidden></div>
      </div>
      <div class="tex-preview" id="writer-preview"></div>
    </div>
    <div class="writer-status"><span id="word-count"></span><span class="grow"></span><span class="hide-sm">\\ commands · ${MOD}B bold · ${MOD}I italic · ${MOD}M math · saves automatically</span></div>
  </section>`;
}

function renderPreview() {
  const el = $('#writer-preview');
  if (!el || !ui.draft) return;
  const tab = ui.writerTab;
  const src = ui.draft[tab] || '';
  const wc = $('#word-count');
  if (wc) wc.textContent = tab === 'bibtex' ? '' : `${words(src)} words`;
  if (tab === 'bibtex') {
    const bib = src.trim() || makeBibtex(ui.draft);
    el.innerHTML = `<p class="preview-note">${src.trim() ? 'Your BibTeX entry:' : 'Generated from the details:'}</p><pre class="bib-preview">${esc(bib)}</pre>
      ${src.trim() ? '' : `<button class="btn" data-action="bib-fill">${icon('copy')}Use as starting point</button>`}`;
    return;
  }
  const { html } = renderTeX(src, texOpts('p-'));
  el.innerHTML = html ? `<div class="tex-doc">${html}</div>` : `<p class="preview-note">The rendered ${tab} appears here as you type.</p>`;
}
const renderPreviewSoon = debounce(renderPreview, 150);

// -- details editor (new paper / edit metadata)

const topicPicker = () =>
  lib().topics.map((t) => `<button class="topic-opt${ui.draft.topics.includes(t.id) ? ' on' : ''}" style="--c:${t.color}" data-action="draft-topic" data-id="${esc(t.id)}"><span class="tdot"></span>${esc(t.name)}</button>`).join('') +
  `<button class="topic-opt add" data-action="new-topic" data-for-draft="1">${icon('plus')}New topic</button>`;
const statusPicker = () => Object.entries(STATUS).map(([k, s]) => `<button class="seg-btn${ui.draft.status === k ? ' on' : ''}" data-action="draft-status" data-v="${k}">${icon(s.icon)}${s.label}</button>`).join('');
const ratingPicker = () => [1, 2, 3, 4, 5].map((k) => `<button class="star${k <= ui.draft.rating ? ' on' : ''}" data-action="draft-rating" data-v="${k}">★</button>`).join('');

function viewEditor(id, params) {
  if (!ensureDraft(id, 'edit', params)) return notFound('This paper is not in your library.');
  const d = ui.draft;
  const isNew = !d.id;
  const field = (name, label, value, attrs = '') => `<label class="field"><span>${label}</span><input data-field="${name}" value="${esc(value ?? '')}" ${attrs}></label>`;
  return `
  <div class="editor">
    <header class="editor-head">
      <a class="icon-btn" id="editor-back" href="${isNew ? '#/' : href('paper', d.id)}" title="Back">${icon('chevronLeft')}</a>
      <div class="grow"><p class="eyebrow">${isNew ? 'New paper' : 'Edit details'}</p><h1 class="editor-title">${isNew ? 'Add a paper' : inl(d.title)}</h1></div>
      <button class="btn primary" data-action="finish-edit">${icon('check')}Done</button>
    </header>
    <section class="import">
      <div class="import-icon">${icon('wand')}</div>
      <div class="import-main">
        <p class="import-title">Fill in the details automatically</p>
        <div class="import-row">
          <input id="import-input" placeholder="Paste an arXiv link or ID, a DOI, a BibTeX entry, or a title…" autocomplete="off" spellcheck="false">
          <button class="btn" data-action="fetch-meta">${icon('sparkles')}Fetch</button>
        </div>
      </div>
    </section>
    <section class="form-card">
      <label class="field wide"><span>Title</span><textarea data-field="title" rows="1" class="title-input" placeholder="Attention Is All You Need">${esc(d.title)}</textarea></label>
      ${field('authors', 'Authors <em>comma-separated</em>', d.authors.join(', '), 'placeholder="Ashish Vaswani, Noam Shazeer, …"')}
      <div class="field-row">
        ${field('venue', 'Venue', d.venue, 'placeholder="NeurIPS 2017" list="venues"')}
        ${field('year', 'Year', d.year, 'inputmode="numeric" placeholder="2017"')}
        ${field('added', 'Added on', d.added, 'type="date"')}
      </div>
      <div class="field wide"><span>Topics</span><div class="topic-picker" id="draft-topics">${topicPicker()}</div></div>
      <div class="field-row">
        <div class="field"><span>Status</span><div class="seg" id="draft-status">${statusPicker()}</div></div>
        <div class="field"><span>Rating</span><div class="rating" id="draft-rating">${ratingPicker()}</div></div>
        <div class="field"><span>Favorite</span><button class="icon-btn fav${d.favorite ? ' on' : ''}" data-action="draft-fav">${icon('heart')}</button></div>
      </div>
      ${field('tags', 'Tags <em>comma-separated</em>', d.tags.join(', '), 'placeholder="ppo, policy-gradient, theory"')}
      <div class="field-row">
        ${field('links.pdf', 'PDF', d.links.pdf, 'placeholder="https://…"')}
        ${field('links.arxiv', 'arXiv / paper page', d.links.arxiv, 'placeholder="https://arxiv.org/abs/…"')}
        ${field('links.code', 'Code', d.links.code, 'placeholder="https://github.com/…"')}
        ${field('links.url', 'Website / blog', d.links.url, 'placeholder="https://…"')}
      </div>
      <label class="field wide"><span>TL;DR <em>one sentence — inline math allowed</em></span><input data-field="tldr" value="${esc(d.tldr)}" placeholder="The one sentence you'd tell a labmate."></label>
      <datalist id="venues">${['NeurIPS', 'ICML', 'ICLR', 'CVPR', 'ACL', 'EMNLP', 'COLT', 'AISTATS', 'TMLR', 'JMLR', 'arXiv'].map((v) => `<option value="${v} ${new Date().getFullYear()}">`).join('')}</datalist>
    </section>
    ${writerHTML([['summary', 'Summary'], ['notes', 'Notes'], ['abstract', 'Abstract'], ['bibtex', 'BibTeX']])}
    ${isNew ? '' : `<div class="editor-danger"><button class="btn ghost danger" data-action="delete-paper">${icon('trash')}Delete this paper</button></div>`}
  </div>`;
}

// -- notes workspace: the PDF next to the editor

function viewNotes(id, params) {
  if (!ensureDraft(id, 'notes', params)) return notFound('This paper is not in your library.');
  const d = ui.draft;
  const pdf = pdfUrl(d);
  const showPdf = !!(ui.pdfOn && pdf);
  return `
  <div class="reader${showPdf ? '' : ' no-pdf'}" style="--pdf-w:${ui.pdfWidth}%;--c:${paperColor(d)}">
    <header class="reader-head">
      <a class="icon-btn" href="${href('paper', d.id)}" title="Back to the paper (Esc)">${icon('chevronLeft')}</a>
      <div class="reader-title"><span class="tdot"></span><span class="rt">${inl(d.title)}</span></div>
      <span class="grow"></span>
      <div class="seg small hide-sm" id="draft-status">${statusPicker()}</div>
      ${pdf ? `<button class="btn ghost sm" data-action="toggle-pdf">${icon('file')}${showPdf ? 'Hide PDF' : 'Show PDF'}</button>` : ''}
      <a class="btn ghost sm hide-sm" href="${href('edit', d.id)}">${icon('edit')}Details</a>
      <button class="btn primary sm" data-action="finish-edit">${icon('check')}Done</button>
    </header>
    <div class="reader-body">
      ${showPdf ? `<section class="reader-pdf"><iframe src="${esc(pdf)}#view=FitH" title="PDF"></iframe>
        <a class="pdf-out" href="${esc(pdf)}" target="_blank" rel="noopener">${icon('external')}Open in a new tab</a></section>
        <div class="reader-handle" data-drag="pdf" title="Drag to resize"></div>` : ''}
      <section class="reader-notes">
        ${!pdf ? `<div class="pdf-missing">${icon('file')}<input data-field="links.pdf" data-apply="pdf" placeholder="Paste a PDF link to read it side by side with your notes"></div>` : ''}
        <label class="tldr-field"><span>TL;DR</span><input data-field="tldr" value="${esc(d.tldr)}" placeholder="The one sentence you'd tell a labmate — inline $math$ works"></label>
        ${writerHTML([['notes', 'Notes'], ['summary', 'Summary']])}
      </section>
    </div>
  </div>`;
}

async function fetchMeta() {
  const input = $('#import-input');
  const btn = $('[data-action="fetch-meta"]');
  const q = input.value.trim();
  if (!q) { input.focus(); return; }
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const m = await lookup(q);
    const d = ui.draft;
    for (const k of ['title', 'year', 'venue', 'abstract']) if (m[k]) d[k] = m[k];
    if (m.authors?.length) d.authors = m.authors;
    d.links = { ...d.links, ...Object.fromEntries(Object.entries(m.links || {}).filter(([, v]) => v)) };
    if (m.bibtex) d.bibtex = m.bibtex;
    draftChanged();
    renderView({ keepScroll: true });
    toast(`Filled in from ${m.source}`, 'ok');
  } catch (e) {
    toast(e.message || 'Lookup failed', 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

// ---------------------------------------------------------------------------
// Dialogs, toasts, search

const dialog = () => $('#dialog');

function openDialog(html, cls = '') {
  const dlg = dialog();
  dlg.className = `dialog ${cls}`;
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $('input:not([type=radio]):not([type=hidden]), textarea', dlg)?.focus(), 30);
}

function closeDialog() {
  if (dialog().open) dialog().close();
}

function confirmDialog(title, text, { ok = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    openDialog(`<div class="dlg narrow"><h2 class="dlg-title">${title}</h2><p class="dlg-text">${text}</p>
      <div class="dlg-actions"><span class="grow"></span><button class="btn ghost" data-confirm="0">Cancel</button><button class="btn ${danger ? 'danger-solid' : 'primary'}" data-confirm="1">${ok}</button></div></div>`);
    const dlg = dialog();
    const done = (v) => { dlg.removeEventListener('click', onClick); dlg.removeEventListener('close', onClose); closeDialog(); resolve(v); };
    const onClick = (e) => { const b = e.target.closest('[data-confirm]'); if (b) done(b.dataset.confirm === '1'); };
    const onClose = () => done(false);
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('close', onClose);
  });
}

function topicDialog(topic, forDraft = false) {
  ui.topicCallback = forDraft ? (id) => { ui.draft?.topics.push(id); draftChanged(); } : null;
  const used = new Set(lib().topics.map((t) => t.color));
  const color = topic?.color || TOPIC_COLORS.find(([, c]) => !used.has(c))?.[1] || TOPIC_COLORS[0][1];
  openDialog(`<form class="dlg" data-form="topic" data-id="${esc(topic?.id || '')}">
    <h2 class="dlg-title">${topic ? 'Edit topic' : 'New topic'}</h2>
    <p class="dlg-text">Topics group the papers of one research area. A paper can belong to several.</p>
    <label class="field"><span>Name</span><input name="name" required maxlength="60" value="${esc(topic?.name || '')}" placeholder="e.g. Diffusion Models"></label>
    <label class="field"><span>Description <em>optional</em></span><input name="description" maxlength="140" value="${esc(topic?.description || '')}" placeholder="Score-based & denoising generative models"></label>
    <div class="field"><span>Colour</span><div class="swatches">${TOPIC_COLORS.map(([n, c]) => `<label class="swatch" title="${n}" style="--c:${c}"><input type="radio" name="color" value="${c}"${c === color ? ' checked' : ''}><span></span></label>`).join('')}</div></div>
    <div class="dlg-actions">${topic ? `<button type="button" class="btn ghost danger" data-action="delete-topic" data-id="${esc(topic.id)}">${icon('trash')}Delete</button>` : ''}
      <span class="grow"></span><button type="button" class="btn ghost" data-action="close-dialog">Cancel</button><button class="btn primary">${topic ? 'Save' : 'Create topic'}</button></div>
  </form>`);
}

function createTopic(name, description = '', color) {
  const used = new Set(lib().topics.map((t) => t.color));
  const id = uniqueId(slugify(name, 40), new Set(lib().topics.map((t) => t.id)));
  const c = color || TOPIC_COLORS.find(([, v]) => !used.has(v))?.[1] || TOPIC_COLORS[lib().topics.length % TOPIC_COLORS.length][1];
  store.update((l) => l.topics.push({ id, name, description, color: c }), `Add topic "${name}"`);
  return id;
}

function settingsDialog(focus) {
  const s = S();
  const gh = store.gh;
  const ro = !store.canEdit;
  const modeText = {
    local: `${icon('disk')}<div><b>Local mode.</b> Every change is written to <code>data/library.json</code> on your disk by <code>serve.py</code>. Commit &amp; push to publish.</div>`,
    github: `${icon('github')}<div><b>GitHub sync.</b> Changes are committed to <code>${esc(gh.owner)}/${esc(gh.repo)}</code>; while you type notes, saves are batched into one commit about every 20&nbsp;s.</div>`,
    browser: `${icon('disk')}<div><b>Browser-only.</b> Changes are kept in this browser’s storage. Run <code>python3 serve.py</code> to save to disk, connect GitHub below, or export a backup.</div>`,
    readonly: `${icon('lock')}<div><b>Read-only.</b> Visitors can browse this library. If it is yours, connect a GitHub token below to edit from this browser.</div>`,
  }[store.mode];
  openDialog(`<div class="dlg wide">
    <div class="dlg-head"><h2 class="dlg-title">Settings</h2><button class="icon-btn" data-action="close-dialog">${icon('x')}</button></div>
    <div class="mode-banner">${modeText}</div>
    <form data-form="settings" class="settings-grid">
      <fieldset ${ro ? 'disabled' : ''}><legend>Library</legend>
        <div class="field-row">
          <label class="field"><span>Library name</span><input name="title" value="${esc(s.title)}"></label>
          <label class="field"><span>Your name</span><input name="owner" value="${esc(s.owner)}" placeholder="Shown in the greeting"></label>
        </div></fieldset>
      <fieldset ${ro ? 'disabled' : ''}><legend>Writing</legend>
        <label class="field"><span>LaTeX macros <em>available in every note and suggested by autocomplete</em></span><textarea name="macros" rows="6" class="mono" spellcheck="false">${esc(s.macros)}</textarea></label>
        <label class="field"><span>Template for new notes</span><textarea name="notesTemplate" rows="6" class="mono" spellcheck="false">${esc(s.notesTemplate)}</textarea></label>
        <label class="check"><input type="checkbox" name="numberSections"${s.numberSections ? ' checked' : ''}> Number sections (1, 1.1, …)</label>
        <div class="dlg-actions"><span class="grow"></span><button class="btn primary">Save settings</button></div></fieldset>
    </form>
    <form data-form="github" class="settings-grid" id="gh-form">
      <fieldset><legend>GitHub sync ${store.mode === 'github' ? '<span class="pill ok">connected</span>' : ''}</legend>
        <p class="help">Edit from any browser: your library is read from and committed to a GitHub repository with a
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>
          limited to that repository with <b>Contents: read &amp; write</b>. <b>Use a private repository</b> (e.g. <code>my-paper-notes</code>)
          so your notes stay private. The token and these settings stay in this browser and are never written to the library.</p>
        <div class="field-row">
          <label class="field"><span>Owner</span><input name="owner" value="${esc(gh.owner)}" placeholder="your-username" required></label>
          <label class="field"><span>Repository</span><input name="repo" value="${esc(gh.repo)}" placeholder="my-paper-notes" required></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Branch</span><input name="branch" value="${esc(gh.branch || 'main')}"></label>
          <label class="field"><span>Data file</span><input name="path" value="${esc(gh.path || 'data/library.json')}"></label>
        </div>
        <label class="field"><span>Token</span><input name="token" type="password" autocomplete="off" placeholder="${store.mode === 'github' ? '•••••••• (saved in this browser)' : 'github_pat_…'}"></label>
        <div class="dlg-actions">${store.mode === 'github' ? '<button type="button" class="btn ghost danger" data-action="gh-disconnect">Disconnect</button>' : ''}
          <span class="grow"></span><button class="btn primary">${icon('github')}${store.mode === 'github' ? 'Update connection' : 'Connect'}</button></div></fieldset>
    </form>
    <div class="settings-grid">
      <fieldset><legend>Data</legend><div class="data-actions">
        <button class="btn" data-action="export-json">${icon('download')}Export library (.json)</button>
        <button class="btn" data-action="export-bib">${icon('quote')}Export all BibTeX</button>
        ${ro ? '' : `<label class="btn">${icon('upload')}Import library…<input type="file" accept=".json,application/json" id="import-file" hidden></label>`}
      </div></fieldset>
      <fieldset><legend>Keyboard</legend><div class="keys">
        <span><kbd>/</kbd> <kbd>${MOD}K</kbd></span><span>Search</span>
        <span><kbd>N</kbd></span><span>Add a paper</span>
        <span><kbd>W</kbd></span><span>Take notes on the open paper (PDF + editor)</span>
        <span><kbd>E</kbd></span><span>Edit the open paper’s details</span>
        <span><kbd>\\</kbd></span><span>LaTeX suggestions while writing (↑ ↓, Tab or ↵)</span>
        <span><kbd>${MOD}B</kbd> <kbd>${MOD}I</kbd> <kbd>${MOD}M</kbd></span><span>Bold, emphasis, inline math</span>
        <span><kbd>${MOD}S</kbd></span><span>Save now (it also saves automatically)</span>
        <span><kbd>Esc</kbd></span><span>Leave the notes workspace</span>
      </div></fieldset>
    </div>
  </div>`, 'settings');
  if (focus === 'github') setTimeout(() => $('#gh-form input[name=token]')?.focus(), 50);
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'error' ? 'x' : type === 'ok' ? 'check' : 'sparkles')}<span>${esc(msg)}</span>`;
  $('#toasts').append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 300); }, type === 'error' ? 5000 : 2200);
}

// -- search palette

let palSel = 0;
let palItems = [];

function openSearch() {
  const pal = $('#palette');
  pal.innerHTML = `<div class="palette">
    <div class="pal-input">${icon('search')}<input id="pal-q" placeholder="Search titles, authors, tags, notes…" autocomplete="off" spellcheck="false"><kbd>esc</kbd></div>
    <div class="pal-results" id="pal-results"></div>
    <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span>${store.canEdit ? `<span><kbd>${MOD}↵</kbd> take notes</span>` : ''}</div>
  </div>`;
  if (!pal.open) pal.showModal();
  const q = $('#pal-q');
  q.addEventListener('input', () => renderResults(q.value));
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % Math.max(1, palItems.length);
      highlightSel();
    } else if (e.key === 'Enter' && palItems[palSel]) {
      e.preventDefault();
      pal.close();
      const target = palItems[palSel];
      go((e.metaKey || e.ctrlKey) && store.canEdit && target.startsWith('#/paper/') ? target.replace('#/paper/', '#/notes/') : target);
    }
  });
  renderResults('');
  q.focus();
}

function highlightSel() {
  $$('#pal-results .pal-item').forEach((el, i) => el.classList.toggle('sel', i === palSel));
  $('#pal-results .pal-item.sel')?.scrollIntoView({ block: 'nearest' });
}

function searchPapers(q) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return sortPapers(lib().papers, 'updated').slice(0, 7).map((p) => ({ p, snippet: '' }));
  const W = { title: 6, authors: 4, tags: 4, venue: 2, tldr: 2, body: 1 };
  const out = [];
  for (const p of lib().papers) {
    const f = {
      title: texPlain(p.title).toLowerCase(), authors: p.authors.join(' ').toLowerCase(), tags: p.tags.join(' '),
      venue: `${p.venue} ${p.year}`.toLowerCase(), tldr: texPlain(p.tldr).toLowerCase(), body: `${p.summary}\n${p.notes}\n${p.abstract}`.toLowerCase(),
    };
    let score = 0;
    let ok = true;
    for (const t of toks) {
      let hit = 0;
      for (const [k, v] of Object.entries(f)) if (v.includes(t)) hit += W[k];
      if (!hit) { ok = false; break; }
      score += hit;
    }
    if (!ok) continue;
    let snippet = '';
    if (!toks.every((t) => f.title.includes(t))) {
      const body = texPlain(`${p.tldr} ${p.summary} ${p.notes} ${p.abstract}`);
      const low = body.toLowerCase();
      const i = low.indexOf(toks.find((t) => low.includes(t)) || '\0');
      if (i >= 0) snippet = `${i > 40 ? '…' : ''}${body.slice(Math.max(0, i - 40), i + 90)}…`;
    }
    out.push({ p, score, snippet });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 12);
}

function renderResults(q) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  const mark = (s) => {
    let h = esc(s);
    for (const t of toks) h = h.replace(new RegExp(`(${esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
    return h;
  };
  const papers = searchPapers(q);
  const topics = lib().topics.filter((t) => !toks.length || toks.every((tk) => t.name.toLowerCase().includes(tk)));
  palItems = [];
  let html = '';
  if (papers.length) {
    html += `<p class="pal-group">${toks.length ? 'Papers' : 'Recently edited'}</p>`;
    html += papers.map(({ p, snippet }) => {
      palItems.push(href('paper', p.id));
      return `<a class="pal-item" href="${href('paper', p.id)}" style="--c:${paperColor(p)}"><span class="tdot"></span><span class="pal-text">
        <span class="pal-title">${mark(texPlain(p.title))}</span><span class="pal-meta">${mark(authorsLine(p.authors))}${p.year ? ` · ${esc(p.year)}` : ''}${p.tags.length ? ` · ${mark(p.tags.map((t) => `#${t}`).join(' '))}` : ''}</span>
        ${snippet ? `<span class="pal-snippet">${mark(snippet)}</span>` : ''}</span>${badge(p.status)}</a>`;
    }).join('');
  }
  if (topics.length) {
    html += '<p class="pal-group">Topics</p>';
    html += topics.slice(0, 6).map((t) => {
      palItems.push(href('topic', t.id));
      return `<a class="pal-item" href="${href('topic', t.id)}" style="--c:${t.color}"><span class="tdot"></span><span class="pal-text"><span class="pal-title">${mark(t.name)}</span><span class="pal-meta">${papersIn(t.id).length} papers</span></span></a>`;
    }).join('');
  }
  if (store.canEdit) {
    palItems.push('#/new');
    html += `<p class="pal-group">Actions</p><a class="pal-item" href="#/new">${icon('plus')}<span class="pal-text"><span class="pal-title">Add a paper</span></span><kbd>N</kbd></a>`;
  }
  if (!papers.length && toks.length) html = `<p class="pal-empty">No papers match “${esc(q)}”.</p>${html}`;
  $('#pal-results').innerHTML = html;
  palSel = 0;
  highlightSel();
}

// ---------------------------------------------------------------------------
// Routing & rendering

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  let name = parts[0] || 'home';
  if (name === 'shelf') name = 'topic'; // links from the first version
  return { name, id: parts[1], params: new URLSearchParams(query || '') };
}

function go(h) {
  if (location.hash === h) renderView();
  else location.hash = h;
}

const EDITING = ['new', 'edit', 'notes'];

function renderView({ keepScroll = false } = {}) {
  const r = ui.route;
  const y = window.scrollY;
  let html;
  const base = S().title || 'My Library';
  let title = base;
  const paperTitle = () => texPlain(paperById(r.id)?.title || ui.draft?.title || 'Paper');
  switch (r.name) {
    case 'home': html = viewHome(); break;
    case 'topic': html = viewCollection('topic', r.id); title = `${topicById(r.id)?.name || 'Topic'} · ${base}`; break;
    case 'list': html = viewCollection('list', r.id); break;
    case 'tag': html = viewCollection('tag', r.id); title = `#${r.id} · ${base}`; break;
    case 'paper': html = viewPaper(r.id); title = `${paperTitle()} · ${base}`; break;
    case 'new':
    case 'edit':
    case 'notes':
      if (!store.canEdit) {
        html = emptyState('Read-only library', 'Connect GitHub in Settings to edit.', `<button class="btn" data-action="settings-github">${icon('github')}Connect</button>`);
      } else {
        html = r.name === 'notes' ? viewNotes(r.id, r.params) : viewEditor(r.name === 'edit' ? r.id : null, r.params);
        title = `${r.name === 'notes' ? `Notes · ${paperTitle()}` : r.name === 'new' ? 'New paper' : 'Edit'} · ${base}`;
      }
      break;
    default: html = notFound();
  }
  document.title = title;
  document.body.classList.toggle('focus-mode', r.name === 'notes' && store.canEdit && !!ui.draft);
  const view = $('#view');
  view.innerHTML = html;
  view.dataset.route = r.name;
  if (EDITING.includes(r.name) && ui.draft) {
    autosizeTitle();
    renderPreview();
    renderSaveState();
  }
  if (keepScroll) window.scrollTo(0, y);
}

function autosizeTitle() {
  const t = $('.title-input');
  if (t) { t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }
}

function onRoute() {
  if (ui.ignoreHash) { ui.ignoreHash = false; return; }
  if (ui.draft && location.hash !== ui.draftKey) {
    if (!saveDraftNow() && draftHasContent(ui.draft) && !window.confirm('This new paper has no title yet, so it was not saved. Discard it?')) {
      ui.ignoreHash = true;
      location.hash = ui.currentHash;
      return;
    }
    ui.draft = null;
    ui.draftKey = null;
    ui.dirty = false;
    closeCompletions();
  }
  const prev = ui.route;
  ui.route = parseRoute();
  ui.currentHash = location.hash;
  if (prev.name !== ui.route.name || prev.id !== ui.route.id) { ui.status = 'all'; ui.abstractOpen = false; }
  document.body.classList.remove('sidebar-open');
  renderSidebar();
  renderTopbar();
  renderView();
  window.scrollTo(0, 0);
  if (ui.route.name === 'notes') setTimeout(() => $('#writer-input')?.focus({ preventScroll: true }), 50);
}

function scrollToId(id) {
  const el = document.getElementById(id);
  if (!el) return;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 84, behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}

// ---------------------------------------------------------------------------
// Theme: blue & white by default, navy dark mode on request

const effectiveTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  pref.set('theme', next);
  renderSidebar();
}

// ---------------------------------------------------------------------------
// Events

function updatePaper(id, fn, msg) {
  store.update((l) => {
    const p = l.papers.find((x) => x.id === id);
    if (p) { fn(p); p.updated = new Date().toISOString(); }
  }, msg);
}

const actions = {
  search: openSearch,
  settings: () => settingsDialog(),
  'settings-github': () => settingsDialog('github'),
  theme: toggleTheme,
  'open-sidebar': () => document.body.classList.add('sidebar-open'),
  'close-sidebar': () => document.body.classList.remove('sidebar-open'),
  'close-dialog': closeDialog,
  'sync-info': () => {
    if (store.mode === 'readonly') settingsDialog('github');
    else if (store.status.state === 'error') { store.dirty = true; store.flush(); }
    else settingsDialog();
  },
  'new-topic': (el) => topicDialog(null, !!el.dataset.forDraft),
  'edit-topic': (el) => topicDialog(topicById(el.dataset.id)),
  'quick-topic': (el) => { createTopic(el.dataset.name); toast(`Topic “${el.dataset.name}” added`, 'ok'); },
  'delete-topic': async (el) => {
    const t = topicById(el.dataset.id);
    const n = papersIn(t.id).length;
    if (!(await confirmDialog(`Delete “${esc(t.name)}”?`, n ? `Its ${n} paper${n === 1 ? '' : 's'} stay in your library, just without this topic.` : 'This topic has no papers.'))) return;
    store.update((l) => {
      l.topics = l.topics.filter((x) => x.id !== t.id);
      for (const p of l.papers) p.topics = p.topics.filter((x) => x !== t.id);
    }, `Remove topic "${t.name}"`);
    if (ui.route.name === 'topic') go('#/');
  },
  'set-view': (el) => { ui.view = el.dataset.v; pref.set('view', ui.view); renderView({ keepScroll: true }); },
  'set-group': (el) => { ui.group = el.dataset.v; pref.set('group', ui.group); renderView({ keepScroll: true }); },
  'filter-status': (el) => { ui.status = el.dataset.v; renderView({ keepScroll: true }); },
  'set-status': (el) => {
    const v = el.dataset.v;
    updatePaper(ui.route.id, (p) => {
      p.status = v;
      if (v !== 'to-read' && !p.started) p.started = todayISO();
      if (v === 'read' && !p.finished) p.finished = todayISO();
    }, `Mark "${texPlain(paperById(ui.route.id).title).slice(0, 50)}" as ${STATUS[v].label.toLowerCase()}`);
  },
  rate: (el) => {
    const p = paperById(ui.route.id);
    const v = +el.dataset.v === p.rating ? 0 : +el.dataset.v;
    updatePaper(p.id, (x) => { x.rating = v; }, `Rate "${texPlain(p.title).slice(0, 50)}" ${v}/5`);
  },
  'toggle-fav': () => {
    const p = paperById(ui.route.id);
    updatePaper(p.id, (x) => { x.favorite = !x.favorite; }, `${p.favorite ? 'Unfavorite' : 'Favorite'} "${texPlain(p.title).slice(0, 50)}"`);
  },
  'copy-bib': async () => {
    const p = paperById(ui.route.id);
    if (p && (await copyText(p.bibtex || makeBibtex(p)))) toast('BibTeX copied', 'ok');
  },
  'delete-paper': async () => {
    const p = paperById(ui.route.id);
    if (!p) return;
    if (!(await confirmDialog('Delete this paper?', `“${esc(texPlain(p.title))}” and its notes will be removed from your library.`))) return;
    ui.dirty = false;
    ui.draft = null;
    ui.draftKey = null;
    store.update((l) => { l.papers = l.papers.filter((x) => x.id !== p.id); }, `Remove "${texPlain(p.title).slice(0, 60)}"`);
    toast('Paper removed');
    go(p.topics[0] && topicById(p.topics[0]) ? href('topic', p.topics[0]) : '#/');
  },
  // editing
  'finish-edit': finishEditing,
  'fetch-meta': fetchMeta,
  snip: (el) => { const ta = $('#writer-input'); if (ta) wrapSelection(ta, ...SNIPPETS[el.dataset.snip]); },
  'writer-tab': (el) => {
    ui.writerTab = el.dataset.tab;
    // Redraw only the writer: re-rendering the view would reload the PDF and lose its scroll position.
    $('.writer').outerHTML = writerHTML(ui.writerTabs);
    renderPreview();
    renderSaveState();
    $('#writer-input')?.focus({ preventScroll: true });
  },
  'writer-layout': (el) => {
    ui.writerLayout = el.dataset.v;
    pref.set(`layout-${ui.route.name === 'notes' ? 'notes' : 'edit'}`, ui.writerLayout);
    $('.writer').className = `writer layout-${ui.writerLayout}`;
    $$('[data-action="writer-layout"]').forEach((b) => b.classList.toggle('on', b.dataset.v === ui.writerLayout));
    renderPreview();
  },
  'toggle-pdf': () => { ui.pdfOn = !ui.pdfOn; pref.set('pdf-on', ui.pdfOn ? '1' : '0'); renderView(); },
  'draft-topic': (el) => {
    const id = el.dataset.id;
    const t = ui.draft.topics;
    ui.draft.topics = t.includes(id) ? t.filter((x) => x !== id) : [...t, id];
    $('#draft-topics').innerHTML = topicPicker();
    draftChanged();
  },
  'draft-status': (el) => { ui.draft.status = el.dataset.v; $('#draft-status').innerHTML = statusPicker(); draftChanged(); },
  'draft-rating': (el) => {
    const v = +el.dataset.v;
    ui.draft.rating = ui.draft.rating === v ? 0 : v;
    $('#draft-rating').innerHTML = ratingPicker();
    draftChanged();
  },
  'draft-fav': (el) => { ui.draft.favorite = !ui.draft.favorite; el.classList.toggle('on', ui.draft.favorite); draftChanged(); },
  'bib-fill': () => {
    ui.draft.bibtex = makeBibtex(ui.draft);
    $('#writer-input').value = ui.draft.bibtex;
    renderPreview();
    draftChanged();
  },
  // settings
  'gh-disconnect': () => { store.disconnectGithub(); closeDialog(); toast('GitHub disconnected'); onRoute(); },
  'export-json': () => download(`library-${todayISO()}.json`, serialize(lib())),
  'export-bib': () => download(`library-${todayISO()}.bib`, [...lib().papers.map((p) => p.bibtex || makeBibtex(p)), ...lib().references.map((r) => r.bibtex)].join('\n\n'), 'application/x-bibtex'),
};

function startPdfDrag(e) {
  const reader = $('.reader');
  const box = $('.reader-body').getBoundingClientRect();
  reader.classList.add('dragging');
  const move = (ev) => {
    ui.pdfWidth = Math.round(Math.max(25, Math.min(75, ((ev.clientX - box.left) / box.width) * 100)));
    reader.style.setProperty('--pdf-w', `${ui.pdfWidth}%`);
  };
  const up = () => {
    reader.classList.remove('dragging');
    pref.set('pdf-width', ui.pdfWidth);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  e.preventDefault();
}

function bindEvents() {
  document.addEventListener('mousedown', (e) => {
    // Keep focus (and the caret) in the editor when picking a suggestion.
    if (e.target.closest('#ac')) e.preventDefault();
  });

  document.addEventListener('click', (e) => {
    const scroll = e.target.closest('[data-scroll]');
    if (scroll) { e.preventDefault(); scrollToId(scroll.dataset.scroll); return; }
    if (e.target.closest('#ac')) { e.preventDefault(); clickCompletion(e.target); return; }
    const a = e.target.closest('[data-action]');
    if (a && a.tagName !== 'SELECT') {
      const fn = actions[a.dataset.action];
      if (fn) { e.preventDefault(); fn(a, e); }
      return;
    }
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a')) go(row.dataset.href);
    if (e.target.closest('#palette a.pal-item') || e.target === $('#palette')) $('#palette').close();
    if (e.target === dialog()) closeDialog();
    if (!e.target.closest('#writer-input')) closeCompletions();
  });

  document.addEventListener('dblclick', (e) => {
    const el = e.target.closest('[data-dbl-edit]');
    if (el && ui.route.name === 'paper') go(href('notes', ui.route.id, `?tab=${el.dataset.dblEdit}`));
  });

  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-drag="pdf"]')) startPdfDrag(e);
  });

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.matches('select[data-action="sort"]')) {
      ui.sort = t.value;
      pref.set('sort', ui.sort);
      renderView({ keepScroll: true });
    } else if (t.dataset.apply === 'pdf' && ui.draft) {
      saveDraftNow();
      renderView();
    } else if (t.id === 'import-file' && t.files[0]) {
      try {
        const json = JSON.parse(await t.files[0].text());
        if (!Array.isArray(json.papers)) throw new Error('Not a library file');
        if (await confirmDialog('Replace your library?', `This replaces your ${lib().papers.length} papers with the ${json.papers.length} in the file.`, { ok: 'Replace' })) {
          store.replace(json, 'Import library');
          toast('Library imported', 'ok');
          go('#/');
        }
      } catch (err) {
        toast(`Import failed: ${err.message}`, 'error');
      }
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!ui.draft) return;
    if (t.dataset.field) {
      setDraftField(t.dataset.field, t.value);
      if (t.dataset.field === 'title') autosizeTitle();
      draftChanged();
    } else if (t.name === 'q' && t.form?.dataset.form === 'reference') {
      t.form.querySelector('button.primary').textContent = 'Find';
    } else if (t.id === 'writer-input') {
      ui.draft[t.dataset.text] = t.value;
      draftChanged();
      renderPreviewSoon();
      if (t.dataset.text !== 'bibtex') updateCompletions(t, $('#ac'), macros(), { cites: citeItems, addCite: referenceDialog });
    }
  });

  document.addEventListener('scroll', (e) => {
    if (e.target.id === 'writer-input') {
      closeCompletions();
      if (ui.writerLayout === 'split') {
        const ta = e.target;
        const pv = $('#writer-preview');
        pv.scrollTop = (ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight)) * (pv.scrollHeight - pv.clientHeight);
      }
    }
  }, true);

  document.addEventListener('toggle', (e) => {
    if (e.target.matches?.('[data-abstract]')) ui.abstractOpen = e.target.open;
  }, true);

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    const kind = f.dataset.form;
    if (!kind) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f));
    if (kind === 'reference') {
      if (ui.refFound?.q === data.q.trim()) citeReference(ui.refFound.m, !!data.toRead);
      else await findReference(f);
    } else if (kind === 'topic') {
      const name = data.name.trim();
      if (!name) return;
      if (f.dataset.id) {
        store.update((l) => Object.assign(l.topics.find((x) => x.id === f.dataset.id), { name, description: data.description.trim(), color: data.color }), `Edit topic "${name}"`);
      } else {
        const id = createTopic(name, data.description.trim(), data.color);
        if (ui.topicCallback) {
          ui.topicCallback(id);
          ui.topicCallback = null;
          if ($('#draft-topics')) $('#draft-topics').innerHTML = topicPicker();
        }
      }
      closeDialog();
    } else if (kind === 'settings') {
      store.update((l) => Object.assign(l.settings, {
        title: data.title.trim() || 'My Library', owner: data.owner.trim(), macros: data.macros,
        notesTemplate: data.notesTemplate, numberSections: !!data.numberSections,
      }), 'Update settings');
      closeDialog();
      toast('Settings saved', 'ok');
      if (EDITING.includes(ui.route.name)) renderPreview();
      else renderView({ keepScroll: true });
    } else if (kind === 'github') {
      const gh = { owner: data.owner.trim(), repo: data.repo.trim(), branch: data.branch.trim() || 'main', path: data.path.trim() || 'data/library.json' };
      const token = data.token.trim() || store.token;
      if (!token) { toast('Paste a token first', 'error'); return; }
      const btn = f.querySelector('button.primary');
      btn.disabled = true;
      btn.classList.add('loading');
      try {
        const info = await store.connectGithub(token, gh);
        closeDialog();
        toast(`Connected to ${info.name}`, 'ok');
        if (!info.isPrivate) toast(`${info.name} is public: anything synced there (your notes) is visible to everyone.`, 'error');
        onRoute();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.target.id === 'writer-input') {
      if (editorKeydown(e, e.target, { onSave: () => { saveDraftNow(); toast('Saved', 'ok'); } })) return;
      if (e.key === 'Escape' && ui.route.name === 'notes') { e.preventDefault(); finishEditing(); }
      return;
    }
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
    if (mod && e.key.toLowerCase() === 's' && ui.draft) { e.preventDefault(); saveDraftNow(); toast('Saved', 'ok'); return; }
    if (e.target.id === 'import-input' && e.key === 'Enter') { e.preventDefault(); fetchMeta(); return; }
    if (e.target.matches('[data-form="reference"] textarea') && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); return; }
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if (typing || mod || e.altKey || dialog().open || $('#palette').open) return;
    const r = ui.route;
    if (e.key === '/') { e.preventDefault(); openSearch(); }
    else if (e.key === 'n' && store.canEdit) go(`#/new${r.name === 'topic' ? `?topic=${encodeURIComponent(r.id)}` : ''}`);
    else if (e.key === 'e' && r.name === 'paper' && store.canEdit) go(href('edit', r.id));
    else if (e.key === 'w' && r.name === 'paper' && store.canEdit) go(href('notes', r.id));
    else if (e.key === 'Escape' && r.name === 'notes') { e.preventDefault(); finishEditing(); }
    else if (e.key === 'Escape') document.body.classList.remove('sidebar-open');
  });

  window.addEventListener('hashchange', onRoute);
  window.addEventListener('beforeunload', (e) => {
    if (ui.draft && ui.dirty) saveDraftNow(); // lands in localStorage at once; synced on the next load if needed
    if (store.saving || (store.dirty && store.mode === 'local')) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ---------------------------------------------------------------------------

async function main() {
  if (pref.get('theme', null) === 'dark') document.documentElement.dataset.theme = 'dark';
  bindEvents();
  try {
    await store.init();
  } catch (e) {
    $('#view').innerHTML = emptyState('Could not open the library', esc(e.message));
    return;
  }
  store.onStatus(renderSync);
  store.on(() => {
    citeMap = null;
    renderSidebar();
    if (!EDITING.includes(ui.route.name)) renderView({ keepScroll: true });
  });
  document.body.classList.add(store.canEdit ? 'can-edit' : 'read-only');
  ui.route = parseRoute();
  onRoute();
  document.body.classList.remove('loading');
  if (store.status.state === 'error') toast(store.status.text, 'error');
}

main();

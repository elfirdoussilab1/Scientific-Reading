// Library storage.
//
// Modes:
//   local    – served by serve.py: every change is written to data/library.json on disk.
//   github   – a GitHub token is configured: changes are committed to the repo via the API.
//   browser  – opened from some other local static server: changes live in localStorage.
//   readonly – hosted (e.g. GitHub Pages) without a token: visitors can browse only.
//
// Unsynced changes are always mirrored to localStorage so nothing is lost on errors.

import { isLocalHost } from './util.js';

const DRAFT_KEY = 'exlibris:draft';
const TOKEN_KEY = 'exlibris:github-token';
const GH_KEY = 'exlibris:github-config';
const DATA_URL = 'data/library.json';
// data/library.json is git-ignored (personal). A fresh clone or the public site shows this instead.
const EXAMPLE_URL = 'data/example-library.json';

export const DEFAULT_SETTINGS = {
  title: 'My Library',
  owner: '',
  numberSections: true,
  macros: [
    '\\newcommand{\\E}{\\mathbb{E}}',
    '\\newcommand{\\R}{\\mathbb{R}}',
    '\\newcommand{\\KL}{D_{\\mathrm{KL}}}',
    '\\newcommand{\\norm}[1]{\\left\\lVert #1 \\right\\rVert}',
    '\\DeclareMathOperator*{\\argmax}{arg\\,max}',
    '\\DeclareMathOperator*{\\argmin}{arg\\,min}',
  ].join('\n'),
  notesTemplate: [
    '\\section{Problem}',
    '',
    '\\section{Method}',
    '',
    '\\section{Results}',
    '',
    '\\section{Strengths \\& weaknesses}',
    '\\begin{itemize}',
    '  \\item[+] ',
    '  \\item[--] ',
    '\\end{itemize}',
    '',
    '\\section{Ideas \\& open questions}',
    '',
  ].join('\n'),
  github: { owner: '', repo: '', branch: 'main', path: DATA_URL },
};

export function emptyLibrary() {
  return { version: 1, settings: structuredClone(DEFAULT_SETTINGS), topics: [], papers: [] };
}

export function normalize(lib) {
  lib = lib && typeof lib === 'object' ? lib : emptyLibrary();
  lib.version = 1;
  lib.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(lib.settings || {}) };
  lib.settings.github = { ...DEFAULT_SETTINGS.github, ...(lib.settings.github || {}) };
  lib.topics = Array.isArray(lib.topics) ? lib.topics : [];
  lib.papers = Array.isArray(lib.papers) ? lib.papers : [];
  for (const p of lib.papers) {
    p.authors = Array.isArray(p.authors) ? p.authors : [];
    p.topics = Array.isArray(p.topics) ? p.topics : [];
    p.tags = Array.isArray(p.tags) ? p.tags : [];
    p.links = p.links || {};
    p.status = p.status || 'to-read';
    p.rating = +p.rating || 0;
    for (const k of ['abstract', 'tldr', 'summary', 'notes', 'bibtex', 'venue']) p[k] = p[k] || '';
  }
  return lib;
}

export const serialize = (lib) => `${JSON.stringify(lib, null, 2)}\n`;

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export class Store {
  constructor() {
    this.lib = null;
    this.mode = 'readonly';
    this.sha = null;
    this.dirty = false;
    this.saving = false;
    this.again = false;
    this.timer = null;
    this.messages = [];
    this.status = { state: 'idle', text: '' };
    this.listeners = new Set();
    this.statusListeners = new Set();
  }

  get token() { return ls.get(TOKEN_KEY) || ''; }
  // Sync settings live in this browser, not in the library, so the library can sit in a private repo.
  get gh() {
    try {
      const local = JSON.parse(ls.get(GH_KEY) || 'null');
      if (local?.owner && local?.repo) return { ...DEFAULT_SETTINGS.github, ...local };
    } catch { /* ignore */ }
    return this.lib?.settings.github || DEFAULT_SETTINGS.github;
  }
  get canEdit() { return this.mode !== 'readonly'; }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onStatus(fn) { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => fn(this.lib)); }
  setStatus(state, text = '') {
    this.status = { state, text };
    this.statusListeners.forEach((fn) => fn(this.status));
  }

  async init() {
    let lib = null;
    if (isLocalHost()) {
      try {
        const r = await fetch('api/status', { cache: 'no-store' });
        if (r.ok && (await r.json()).app === 'exlibris') this.mode = 'local';
      } catch { /* no local server */ }
      if (this.mode !== 'local') this.mode = 'browser';
    }
    if (this.mode === 'local') {
      lib = await (await fetch('api/library', { cache: 'no-store' })).json();
      // Heartbeat: lets a server started with --idle-exit (the Mac app) know the page is still open.
      setInterval(() => fetch('api/status', { cache: 'no-store' }).catch(() => {}), 60000);
    } else {
      for (const url of [DATA_URL, EXAMPLE_URL]) {
        try {
          const r = await fetch(url, { cache: 'no-cache' });
          if (r.ok) { lib = await r.json(); break; }
        } catch { /* try the next one */ }
      }
    }
    this.lib = normalize(lib);

    if (this.mode !== 'local' && this.token && this.gh.owner && this.gh.repo) {
      try {
        const { json, sha } = await this.ghGet();
        if (json) this.lib = normalize(json);
        this.sha = sha;
        this.mode = 'github';
      } catch (e) {
        this.mode = 'github';
        this.setStatus('error', `GitHub: ${e.message}`);
      }
    }

    const draft = ls.get(DRAFT_KEY);
    if (draft && this.canEdit) {
      try {
        const d = JSON.parse(draft);
        if (serialize(d) !== serialize(this.lib)) {
          this.lib = normalize(d);
          this.dirty = true;
          this.messages.push('Restore unsynced changes');
        } else ls.del(DRAFT_KEY);
      } catch { ls.del(DRAFT_KEY); }
    }
    if (this.dirty) this.flush();
    else this.setStatus('saved', this.describe());
    return this.lib;
  }

  describe() {
    return {
      local: 'Saved to data/library.json',
      github: 'Synced with GitHub',
      browser: 'Saved in this browser',
      readonly: 'Read-only',
    }[this.mode];
  }

  /** Apply a mutation, persist it, and notify listeners. */
  // `delay` lets frequent autosaves (typing notes) batch into fewer GitHub commits.
  update(mutator, message = 'Update library', { delay } = {}) {
    if (!this.canEdit) return;
    mutator(this.lib);
    this.dirty = true;
    ls.set(DRAFT_KEY, JSON.stringify(this.lib));
    this.messages.push(message);
    this.emit();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay ?? (this.mode === 'github' ? 1500 : 250));
  }

  replace(lib, message = 'Import library') {
    this.update((l) => {
      const fresh = normalize(structuredClone(lib));
      fresh.settings.github = l.settings.github;
      Object.assign(l, fresh);
    }, message);
  }

  async flush() {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    if (this.mode === 'browser') {
      this.messages = [];
      this.setStatus('saved', this.describe());
      return;
    }
    if (this.saving) { this.again = true; return; }
    this.saving = true;
    this.setStatus('saving', this.mode === 'github' ? 'Committing to GitHub…' : 'Saving…');
    const msgs = this.messages.splice(0);
    let failed = false;
    try {
      if (this.mode === 'local') {
        const r = await fetch('api/library', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: serialize(this.lib),
        });
        if (!r.ok) throw new Error(`Server returned ${r.status}`);
      } else if (this.mode === 'github') {
        await this.ghPut(commitMessage(msgs));
      }
      this.dirty = false;
      if (!this.messages.length) ls.del(DRAFT_KEY);
      this.setStatus('saved', this.describe());
    } catch (e) {
      failed = true;
      this.messages.unshift(...msgs);
      this.setStatus('error', e.message || String(e));
    } finally {
      this.saving = false;
      const more = this.again || (!failed && this.messages.length > 0);
      this.again = false;
      if (more) { this.dirty = true; setTimeout(() => this.flush(), 400); }
    }
  }

  // -- GitHub ---------------------------------------------------------------

  ghUrl() {
    const { owner, repo, path } = this.gh;
    const p = String(path || DATA_URL).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p}`;
  }

  ghHeaders(token = this.token, accept = 'application/vnd.github+json') {
    return { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  }

  async ghGet() {
    const url = `${this.ghUrl()}?ref=${encodeURIComponent(this.gh.branch || 'main')}`;
    const r = await fetch(url, { headers: this.ghHeaders(), cache: 'no-store' });
    if (r.status === 404) return { json: null, sha: null };
    if (!r.ok) throw new Error(await ghError(r));
    const meta = await r.json();
    let text;
    if (meta.content && meta.encoding === 'base64') text = b64decode(meta.content);
    else {
      const raw = await fetch(url, { headers: this.ghHeaders(this.token, 'application/vnd.github.raw+json'), cache: 'no-store' });
      text = await raw.text();
    }
    return { json: JSON.parse(text), sha: meta.sha };
  }

  async ghPut(message) {
    const body = { message, content: b64encode(serialize(this.lib)), branch: this.gh.branch || 'main' };
    const put = () =>
      fetch(this.ghUrl(), {
        method: 'PUT',
        headers: { ...this.ghHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(this.sha ? { ...body, sha: this.sha } : body),
      });
    let r = await put();
    if (r.status === 409 || r.status === 422) {
      // Our sha is stale (e.g. edited from another device). Last write wins.
      this.sha = (await this.ghGet()).sha;
      r = await put();
    }
    if (!r.ok) throw new Error(await ghError(r));
    this.sha = (await r.json()).content.sha;
  }

  /** Validates a token against the configured repo; returns a short description. */
  async testGithub(token, gh) {
    const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}`, {
      headers: this.ghHeaders(token),
    });
    if (!r.ok) throw new Error(await ghError(r));
    const repo = await r.json();
    if (repo.permissions && !repo.permissions.push) throw new Error('This token cannot push to the repository');
    return { name: repo.full_name, isPrivate: !!repo.private };
  }

  async connectGithub(token, gh) {
    const info = await this.testGithub(token, gh);
    ls.set(TOKEN_KEY, token);
    ls.set(GH_KEY, JSON.stringify({ ...DEFAULT_SETTINGS.github, ...gh }));
    this.mode = 'github';
    const { json, sha } = await this.ghGet();
    this.sha = sha;
    if (json && !this.dirty) this.lib = normalize(json);
    this.emit();
    if (this.dirty || !json) {
      this.dirty = true;
      this.messages.push('Create library');
      await this.flush();
    } else this.setStatus('saved', this.describe());
    return info;
  }

  disconnectGithub() {
    ls.del(TOKEN_KEY);
    this.sha = null;
    this.mode = isLocalHost() ? 'browser' : 'readonly';
    this.setStatus('saved', this.describe());
    this.emit();
  }

  discardDraft() {
    ls.del(DRAFT_KEY);
  }
}

function commitMessage(msgs) {
  const uniq = [...new Set(msgs)];
  if (uniq.length <= 1) return uniq[0] || 'Update library';
  return `Update library (${uniq.length} changes)\n\n${uniq.map((m) => `- ${m}`).join('\n')}`;
}

async function ghError(r) {
  let msg = `GitHub returned ${r.status}`;
  try {
    const j = await r.json();
    if (j.message) msg = `${j.message} (${r.status})`;
  } catch { /* ignore */ }
  if (r.status === 401) msg = 'Invalid or expired token (401)';
  return msg;
}

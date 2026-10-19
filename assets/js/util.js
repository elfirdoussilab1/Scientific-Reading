// Small shared helpers.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function slugify(s, max = 60) {
  return (
    String(s ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\\[a-z]+/g, ' ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'item'
  );
}

export function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function parseDate(iso) {
  if (!iso) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDate(iso, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  const d = parseDate(iso);
  return d ? d.toLocaleDateString(undefined, opts) : '';
}

export function timeAgo(iso) {
  const d = parseDate(iso);
  if (!d) return '';
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(iso);
}

export function lastName(name = '') {
  const n = name.trim();
  if (n.includes(',')) return n.split(',')[0].trim();
  const parts = n.split(/\s+/);
  return parts[parts.length - 1] || n;
}

export function authorsShort(authors = []) {
  if (!authors.length) return '';
  if (authors.length === 1) return lastName(authors[0]);
  if (authors.length === 2) return `${lastName(authors[0])} & ${lastName(authors[1])}`;
  return `${lastName(authors[0])} et al.`;
}

export function authorsList(authors = [], max = 8) {
  if (authors.length <= max) return authors.join(', ');
  return `${authors.slice(0, max).join(', ')}, … +${authors.length - max}`;
}

export function splitAuthors(s = '') {
  const str = String(s).trim();
  if (!str) return [];
  const parts = /\sand\s/i.test(str) && !str.includes(';') ? str.split(/\s+and\s+/i) : str.split(/[;,]\s*(?![^()]*\))/);
  return parts.map((a) => a.trim()).filter(Boolean);
}

export function splitTags(s = '') {
  return [...new Set(String(s).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export const isLocalHost = () =>
  ['localhost', '127.0.0.1', '[::1]', '::1', ''].includes(location.hostname) || location.hostname.endsWith('.local');

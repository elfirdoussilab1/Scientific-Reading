// LaTeX editing helpers for the notes textarea: command autocomplete,
// auto-closing pairs, smart Enter / Tab, and snippet insertion.
// `$0` in a snippet marks where the caret lands.

import { esc } from './util.js';

const GREEK = ('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi ' +
  'rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega').split(' ');

const SYMBOLS = ('nabla partial infty cdot cdots ldots times leq geq neq approx propto sim simeq equiv in notin ' +
  'subset subseteq cup cap to mapsto gets Rightarrow Leftarrow iff implies forall exists mid top perp otimes oplus ' +
  'circ star dagger ell log exp det tr quad qquad').split(' ');

const COMMANDS = [
  ['section', '\\section{$0}'], ['subsection', '\\subsection{$0}'], ['subsubsection', '\\subsubsection{$0}'],
  ['paragraph', '\\paragraph{$0}'], ['textbf', '\\textbf{$0}'], ['emph', '\\emph{$0}'], ['textit', '\\textit{$0}'],
  ['texttt', '\\texttt{$0}'], ['underline', '\\underline{$0}'], ['hl', '\\hl{$0}'], ['todo', '\\todo{$0}'],
  ['item', '\\item $0'], ['cite', '\\cite{$0}'], ['citet', '\\citet{$0}'], ['ref', '\\ref{$0}'], ['eqref', '\\eqref{$0}'],
  ['label', '\\label{$0}'], ['footnote', '\\footnote{$0}'], ['href', '\\href{$0}{}'], ['url', '\\url{$0}'],
  ['frac', '\\frac{$0}{}'], ['tfrac', '\\tfrac{$0}{}'], ['sqrt', '\\sqrt{$0}'], ['sum', '\\sum_{$0}^{}'],
  ['prod', '\\prod_{$0}^{}'], ['int', '\\int_{$0}^{}'], ['lim', '\\lim_{$0}'], ['min', '\\min_{$0}'], ['max', '\\max_{$0}'],
  ['inf', '\\inf_{$0}'], ['sup', '\\sup_{$0}'], ['mathbb', '\\mathbb{$0}'], ['mathcal', '\\mathcal{$0}'],
  ['mathbf', '\\mathbf{$0}'], ['mathrm', '\\mathrm{$0}'], ['boldsymbol', '\\boldsymbol{$0}'], ['text', '\\text{$0}'],
  ['operatorname', '\\operatorname{$0}'], ['hat', '\\hat{$0}'], ['tilde', '\\tilde{$0}'], ['bar', '\\bar{$0}'],
  ['overline', '\\overline{$0}'], ['underbrace', '\\underbrace{$0}_{}'], ['left(', '\\left( $0 \\right)'],
  ['left[', '\\left[ $0 \\right]'], ['left\\{', '\\left\\{ $0 \\right\\}'], ['langle', '\\langle $0 \\rangle'],
  ['norm', '\\norm{$0}'], ['includegraphics', '\\includegraphics[width=0.8\\linewidth]{$0}'],
  ...GREEK.map((g) => [g, `\\${g}`]),
  ...SYMBOLS.map((s) => [s, `\\${s}`]),
];

const ENVS = {
  itemize: '\\begin{itemize}\n  \\item $0\n\\end{itemize}',
  enumerate: '\\begin{enumerate}\n  \\item $0\n\\end{enumerate}',
  description: '\\begin{description}\n  \\item[$0] \n\\end{description}',
  equation: '\\begin{equation}\\label{eq:$0}\n  \n\\end{equation}',
  'equation*': '\\begin{equation*}\n  $0\n\\end{equation*}',
  align: '\\begin{align}\n  $0 &= \\\\\n  &= \n\\end{align}',
  'align*': '\\begin{align*}\n  $0 &= \\\\\n  &= \n\\end{align*}',
  gather: '\\begin{gather}\n  $0\n\\end{gather}',
  cases: '\\begin{cases}\n  $0 & \\text{if } \\\\\n  & \\text{otherwise}\n\\end{cases}',
  pmatrix: '\\begin{pmatrix}\n  $0 & \\\\\n  & \n\\end{pmatrix}',
  bmatrix: '\\begin{bmatrix}\n  $0 & \\\\\n  & \n\\end{bmatrix}',
  theorem: '\\begin{theorem}[$0]\n  \n\\end{theorem}',
  lemma: '\\begin{lemma}\n  $0\n\\end{lemma}',
  proposition: '\\begin{proposition}\n  $0\n\\end{proposition}',
  corollary: '\\begin{corollary}\n  $0\n\\end{corollary}',
  definition: '\\begin{definition}[$0]\n  \n\\end{definition}',
  assumption: '\\begin{assumption}\n  $0\n\\end{assumption}',
  remark: '\\begin{remark}\n  $0\n\\end{remark}',
  example: '\\begin{example}\n  $0\n\\end{example}',
  idea: '\\begin{idea}\n  $0\n\\end{idea}',
  question: '\\begin{question}\n  $0\n\\end{question}',
  critique: '\\begin{critique}\n  $0\n\\end{critique}',
  proof: '\\begin{proof}\n  $0\n\\end{proof}',
  quote: '\\begin{quote}\n  $0\n\\end{quote}',
  table: '\\begin{table}\n  \\caption{$0}\n  \\begin{tabular}{lcc}\n    \\toprule\n    Method & Metric & Metric \\\\\n    \\midrule\n    Baseline & 0.0 & 0.0 \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}',
  tabular: '\\begin{tabular}{lcc}\n  \\toprule\n  $0 &  &  \\\\\n  \\midrule\n   &  &  \\\\\n  \\bottomrule\n\\end{tabular}',
  figure: '\\begin{figure}\n  \\includegraphics[width=0.8\\linewidth]{$0}\n  \\caption{}\n\\end{figure}',
  algorithm: '\\begin{algorithm}\n  \\caption{$0}\n  \\begin{algorithmic}\n    \\Require \n    \\For{$t = 1, \\dots, T$}\n      \\State \n    \\EndFor\n  \\end{algorithmic}\n\\end{algorithm}',
  algorithmic: '\\begin{algorithmic}\n  \\State $0\n\\end{algorithmic}',
  verbatim: '\\begin{verbatim}\n$0\n\\end{verbatim}',
};

// ---------------------------------------------------------------------------

/** Replaces [from, to) with `text`, placing the caret at `$0` (or the end). */
export function insertAt(ta, from, to, text) {
  const i = text.indexOf('$0');
  const clean = text.replace('$0', '');
  ta.focus();
  ta.setRangeText(clean, from, to, 'end');
  if (i >= 0) ta.setSelectionRange(from + i, from + i);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Wraps the selection with before/after (or inserts them around the caret). */
export function wrapSelection(ta, before, after) {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const sel = value.slice(s, e);
  ta.focus();
  ta.setRangeText(before + sel + after, s, e, 'end');
  const caret = sel ? s + before.length + sel.length + after.length : s + before.length;
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// -- caret position (mirror-div technique) ----------------------------------

function caretXY(ta) {
  const cs = getComputedStyle(ta);
  const div = document.createElement('div');
  for (const p of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth',
    'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
    'letterSpacing', 'tabSize']) div.style[p] = cs[p];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '-9999px' });
  div.textContent = ta.value.slice(0, ta.selectionStart);
  const span = document.createElement('span');
  span.textContent = '\u200b';
  div.append(span);
  document.body.append(div);
  const x = span.offsetLeft;
  const y = span.offsetTop + (parseFloat(cs.lineHeight) || 22);
  div.remove();
  return { x: x - ta.scrollLeft, y: y - ta.scrollTop };
}

// -- autocomplete -------------------------------------------------------------

const ac = { open: false, items: [], sel: 0, from: 0, env: false, el: null, ta: null };

function candidates(word, envMode, macros) {
  const w = word.toLowerCase();
  let pool;
  if (envMode) {
    pool = Object.entries(ENVS).map(([k, v]) => ({ key: k, label: `\\begin{${k}}`, insert: v, kind: 'env' }));
  } else {
    pool = [
      ...Object.entries(macros).map(([k, v]) => ({ key: k.slice(1), label: k, insert: k, hint: v, kind: 'macro' })),
      ...Object.entries(ENVS).map(([k, v]) => ({ key: k, label: `\\begin{${k}}`, insert: v, kind: 'env' })),
      ...COMMANDS.map(([k, v]) => ({ key: k, label: `\\${k}`, insert: v, kind: 'cmd' })),
    ];
  }
  const starts = pool.filter((c) => c.key.toLowerCase().startsWith(w));
  const contains = w.length > 1 ? pool.filter((c) => !starts.includes(c) && c.key.toLowerCase().includes(w)) : [];
  const seen = new Set();
  return [...starts.sort((a, b) => a.key.length - b.key.length), ...contains]
    .filter((c) => !seen.has(c.label) && seen.add(c.label))
    .slice(0, 8);
}

export function closeCompletions() {
  ac.open = false;
  if (ac.el) ac.el.hidden = true;
}

// Papers matching every word typed inside \cite{…}; `cites` is ordered most recent first.
function citeCandidates(q, cites) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return cites.slice(0, 8);
  return cites
    .filter((c) => toks.every((t) => c.search.includes(t)))
    .map((c, i) => [c.key.toLowerCase().startsWith(toks[0]) ? 0 : 1, i, c])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .slice(0, 8)
    .map(([, , c]) => c);
}

const CITE_CMD = /\\(?:cite[a-z]*|parencite|textcite|autocite)\*?(?:\[[^\]\n]*\]){0,2}\{([^{}\n]*)$/;

/**
 * Call after every input in the textarea. `cites()` lists the papers that can be
 * cited: { key, label, hint, search }. `addCite(query, from, to)`, if given, is
 * offered as a last suggestion to cite a paper that is not in the list.
 */
export function updateCompletions(ta, popup, macros, { cites = () => [], addCite } = {}) {
  ac.el = popup;
  ac.ta = ta;
  const s = ta.selectionStart;
  if (s !== ta.selectionEnd) return closeCompletions();
  const cite = CITE_CMD.exec(ta.value.slice(Math.max(0, s - 200), s));
  if (cite) {
    const frag = /[^,]*$/.exec(cite[1])[0];
    const q = frag.trimStart();
    const items = citeCandidates(q, cites()).map((c) => ({ ...c, insert: c.key, kind: 'cite' }));
    if (items.length === 1 && items[0].key === q) return closeCompletions();
    if (addCite) {
      items.push({ kind: 'cite', label: q ? `Cite “${q}”…` : 'Cite a paper not in your library…', hint: 'Look up an arXiv link, DOI, BibTeX entry or title', action: addCite });
    }
    if (!items.length) return closeCompletions();
    return showCompletions(ta, popup, items, s - q.length, false);
  }
  const before = ta.value.slice(Math.max(0, s - 40), s);
  const env = /\\begin\{([a-zA-Z*]*)$/.exec(before);
  const cmd = !env && /(?:^|[^\\])\\([a-zA-Z]+)$/.exec(before);
  if (!env && !cmd) return closeCompletions();
  const word = env ? env[1] : cmd[1];
  const items = candidates(word, !!env, macros);
  if (!items.length || (items.length === 1 && items[0].label === `\\${word}`)) return closeCompletions();
  showCompletions(ta, popup, items, s - (env ? env[0].length : word.length + 1), !!env);
}

function showCompletions(ta, popup, items, from, env) {
  ac.items = items;
  ac.sel = 0;
  ac.from = from;
  ac.env = env;
  ac.open = true;
  const kind = (c) => (c.kind === 'env' ? 'environment' : c.kind === 'macro' ? esc(c.hint).slice(0, 40) : c.kind === 'cite' ? esc(c.hint) : '');
  popup.classList.toggle('ac-wide', items[0].kind === 'cite');
  popup.innerHTML = items
    .map((c, i) => `<div class="ac-item${c.kind === 'cite' ? ' ac-cite' : ''}${i === 0 ? ' sel' : ''}" data-ac="${i}"><span class="ac-label">${esc(c.label)}</span><span class="ac-kind">${kind(c)}</span></div>`)
    .join('');
  const { x, y } = caretXY(ta);
  popup.hidden = false;
  const maxX = ta.clientWidth - popup.offsetWidth - 8;
  popup.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
  popup.style.top = `${y + 4 > ta.clientHeight - popup.offsetHeight ? y - popup.offsetHeight - 28 : y + 4}px`;
}

function acceptCompletion(i = ac.sel) {
  const c = ac.items[i];
  if (!c || !ac.ta) return;
  const ta = ac.ta;
  closeCompletions();
  if (c.action) { c.action(ta.value.slice(ac.from, ta.selectionStart), ac.from, ta.selectionStart); return; }
  // `\begin{` usually has an auto-closed `}` after the caret: replace it too.
  const to = ac.env && ta.value[ta.selectionStart] === '}' ? ta.selectionStart + 1 : ta.selectionStart;
  insertAt(ta, ac.from, to, c.insert.includes('$0') ? c.insert : `${c.insert}$0`);
}

export function clickCompletion(target) {
  const item = target.closest('[data-ac]');
  if (item) acceptCompletion(+item.dataset.ac);
}

// -- keyboard -----------------------------------------------------------------

const PAIRS = { '{': '}', '(': ')', '[': ']' };
const CLOSERS = new Set(['}', ')', ']']);

/** Returns true if the event was handled. */
export function editorKeydown(e, ta, { onSave, onBold, onItalic } = {}) {
  const mod = e.metaKey || e.ctrlKey;
  const { selectionStart: s, selectionEnd: end, value } = ta;
  const prev = value[s - 1];
  const next = value[end];

  if (ac.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      ac.sel = (ac.sel + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length;
      ac.el.querySelectorAll('.ac-item').forEach((el, i) => el.classList.toggle('sel', i === ac.sel));
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptCompletion(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); closeCompletions(); return true; }
  }

  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); onSave?.(); return true; }
  if (mod && !e.shiftKey && e.key === 'b') { e.preventDefault(); onBold ? onBold() : wrapSelection(ta, '\\textbf{', '}'); return true; }
  if (mod && !e.shiftKey && e.key === 'i') { e.preventDefault(); onItalic ? onItalic() : wrapSelection(ta, '\\emph{', '}'); return true; }
  if (mod && !e.shiftKey && e.key === 'm') { e.preventDefault(); wrapSelection(ta, '$', '$'); return true; }
  if (mod || e.altKey) return false;

  // Auto-closing pairs.
  if (PAIRS[e.key] && prev !== '\\') {
    if (s !== end) { e.preventDefault(); wrapSelection(ta, e.key, PAIRS[e.key]); return true; }
    if (next === undefined || /[\s)}\]$,.;:]/.test(next)) {
      e.preventDefault();
      insertAt(ta, s, s, `${e.key}$0${PAIRS[e.key]}`);
      return true;
    }
  }
  if (CLOSERS.has(e.key) && next === e.key && s === end) {
    e.preventDefault();
    ta.setSelectionRange(s + 1, s + 1);
    return true;
  }
  if (e.key === '$' && prev !== '\\') {
    if (s !== end) { e.preventDefault(); wrapSelection(ta, '$', '$'); return true; }
    if (prev === '$' && next === '$') { e.preventDefault(); insertAt(ta, s, s, '$$0$'); return true; } // $|$ → $$|$$
    if (next === '$') { e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); return true; }
    if (next === undefined || /[\s)}\],.;:]/.test(next)) { e.preventDefault(); insertAt(ta, s, s, '$$0$'); return true; }
  }
  if (e.key === 'Backspace' && s === end && s > 0) {
    const pair = prev + (next ?? '');
    if (['{}', '()', '[]', '$$'].includes(pair) && value[s - 2] !== '\\') {
      e.preventDefault();
      insertAt(ta, s - 1, s + 1, '');
      return true;
    }
  }

  // Indentation.
  if (e.key === 'Tab') {
    e.preventDefault();
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    if (e.shiftKey) {
      const m = /^ {1,2}/.exec(value.slice(lineStart));
      if (m) {
        ta.setRangeText('', lineStart, lineStart + m[0].length, 'preserve');
        ta.setSelectionRange(Math.max(lineStart, s - m[0].length), Math.max(lineStart, end - m[0].length));
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else insertAt(ta, s, end, '  ');
    return true;
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const line = value.slice(lineStart, s);
    const indent = /^\s*/.exec(line)[0];
    const begin = /\\begin\{([^}]+)\}(\[[^\]]*\])?(\{[^}]*\})?\s*$/.exec(line);
    if (begin) {
      const name = begin[1].replace(/[*]/g, '\\*');
      const opens = (value.match(new RegExp(`\\\\begin\\{${name}\\}`, 'g')) || []).length;
      const closes = (value.match(new RegExp(`\\\\end\\{${name}\\}`, 'g')) || []).length;
      if (opens > closes) {
        e.preventDefault();
        const item = /^(itemize|enumerate|description)$/.test(begin[1]) ? '\\item ' : '';
        insertAt(ta, s, end, `\n${indent}  ${item}$0\n${indent}\\end{${begin[1]}}`);
        return true;
      }
    }
    if (/^\s*\\item\b/.test(line)) {
      e.preventDefault();
      if (/^\s*\\item(\[[^\]]*\])?\s*$/.test(line)) insertAt(ta, lineStart, s, indent);
      else insertAt(ta, s, end, `\n${indent}\\item `);
      return true;
    }
    if (indent) { e.preventDefault(); insertAt(ta, s, end, `\n${indent}`); return true; }
  }
  return false;
}

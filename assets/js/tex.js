// Lightweight LaTeX → HTML renderer for paper notes.
//
// Math (inline, display, equation/align/gather/… environments) is typeset by
// KaTeX (the global `katex` loaded from the CDN). Text-mode LaTeX — sections,
// lists, theorems, tables, algorithms, footnotes, \cite, \ref, … — is
// translated here. It is deliberately forgiving: unknown commands degrade to
// their arguments instead of failing.

import { esc, slugify } from './util.js';

const MATH_ENV = /^\\begin\{(equation|align|gather|multline|eqnarray|flalign|alignat)(\*?)\}/;
const VERBATIM_ENV = /\\begin\{(verbatim|lstlisting|minted|code)\}(\[[^\]\n]*\])?(\{[^}\n]*\})?\n?([\s\S]*?)\\end\{\1\}/g;

const THEOREMS = {
  theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition', corollary: 'Corollary',
  definition: 'Definition', remark: 'Remark', example: 'Example', claim: 'Claim',
  assumption: 'Assumption', conjecture: 'Conjecture', observation: 'Observation',
  hypothesis: 'Hypothesis', question: 'Question', idea: 'Idea', intuition: 'Intuition',
  note: 'Note', problem: 'Problem', fact: 'Fact', insight: 'Insight', critique: 'Critique',
};

const FLOATS = { figure: 'Figure', table: 'Table', algorithm: 'Algorithm' };

const ACCENTS = { "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇' };
const LETTER_ACCENTS = { c: '̧', v: '̌', u: '̆', H: '̋', r: '̊', k: '̨' };

const SYMBOLS = {
  ldots: '…', dots: '…', textellipsis: '…', S: '§', P: '¶', dag: '†', ddag: '‡', copyright: '©',
  textbackslash: '\\', textasciitilde: '~', textasciicircum: '^', textbar: '|', textless: '<',
  textgreater: '>', textendash: '–', textemdash: '—', textbullet: '•', textdegree: '°',
  checkmark: '✓', cmark: '✓', xmark: '✗', ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', aa: 'å',
  AA: 'Å', oe: 'œ', OE: 'Œ', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ', quad: ' ', qquad: '  ',
  enspace: ' ', thinspace: ' ', textquoteleft: '‘', textquoteright: '’', pounds: '£',
  euro: '€', textregistered: '®', texttrademark: '™', ie: 'i.e.', eg: 'e.g.', etc: 'etc.', wrt: 'w.r.t.',
  etal: 'et al.',
};

const IGNORED = new Set(
  ('noindent centering raggedright raggedleft small footnotesize scriptsize tiny normalsize large Large LARGE ' +
    'huge Huge bf it em tt sc sf rm sl bfseries itshape ttfamily scshape sffamily rmfamily upshape mdseries ' +
    'normalfont maketitle tableofcontents clearpage newpage pagebreak smallskip medskip bigskip hfill vfill ' +
    'indent bigbreak null relax protect displaystyle centerline appendix nolinebreak sloppy frenchspacing ' +
    'FloatBarrier toprule midrule bottomrule hline').split(' '),
);

// Commands whose (brace) arguments should be swallowed entirely.
const SWALLOW = {
  vspace: 1, hspace: 1, vskip: 0, hskip: 0, setlength: 2, addtolength: 2, label: 1, title: 1, author: 1,
  date: 1, documentclass: 1, usepackage: 1, bibliography: 1, bibliographystyle: 1, pagestyle: 1,
  thispagestyle: 1, setcounter: 2, addcontentsline: 3, input: 1, include: 1, newtheorem: 2,
  definecolor: 3, begin: 1, end: 1, color: 1, captionsetup: 1, graphicspath: 1,
};

// ---------------------------------------------------------------------------
// Scanning helpers

export function findClosing(s, i, open = '{', close = '}') {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j;
  }
  return -1;
}

function skipSpace(s, i) {
  let nl = 0;
  while (i < s.length && /\s/.test(s[i])) {
    if (s[i] === '\n' && ++nl > 1) break;
    i++;
  }
  return i;
}

// Reads a mandatory argument: {…} or a single token. Returns null if none.
function readArg(s, i) {
  const j = skipSpace(s, i);
  if (j >= s.length) return null;
  if (s[j] === '{') {
    const e = findClosing(s, j);
    if (e < 0) return { arg: s.slice(j + 1), end: s.length };
    return { arg: s.slice(j + 1, e), end: e + 1 };
  }
  if (s[j] === '}' || s[j] === '\n') return null;
  if (s[j] === '\\') {
    const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(j));
    return { arg: m[0], end: j + m[0].length };
  }
  return { arg: s[j], end: j + 1 };
}

// Reads an optional [..] argument.
function readOpt(s, i) {
  const j = skipSpace(s, i);
  if (s[j] !== '[') return { arg: null, end: i };
  const e = findClosing(s, j, '[', ']');
  if (e < 0) return { arg: null, end: i };
  return { arg: s.slice(j + 1, e), end: e + 1 };
}

function findEnv(s, name, from) {
  const b = `\\begin{${name}}`;
  const e = `\\end{${name}}`;
  let depth = 1;
  let i = from;
  for (;;) {
    const nb = s.indexOf(b, i);
    const ne = s.indexOf(e, i);
    if (ne < 0) return -1;
    if (nb >= 0 && nb < ne) { depth++; i = nb + b.length; }
    else {
      if (--depth === 0) return ne;
      i = ne + e.length;
    }
  }
}

// Splits at a top-level separator ('&' or '\\\\'), ignoring braces and nested environments.
function splitTop(s, sep) {
  const parts = [];
  let depth = 0;
  let env = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (s.startsWith('\\begin{', i)) env++;
      else if (s.startsWith('\\end{', i)) env--;
      else if (sep === '\\\\' && s[i + 1] === '\\' && depth === 0 && env === 0) {
        parts.push(s.slice(last, i));
        last = i + 2;
      }
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (sep === '&' && c === '&' && depth === 0 && env === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts;
}

function splitItems(body) {
  const items = [];
  let env = 0;
  let brace = 0;
  let cur = null;
  let i = 0;
  const push = (end) => {
    if (cur) { cur.content = body.slice(cur.start, end); items.push(cur); }
  };
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') {
      if (body.startsWith('\\begin{', i)) { env++; i += 7; continue; }
      if (body.startsWith('\\end{', i)) { env--; i += 5; continue; }
      if (env === 0 && brace === 0 && /^\\item(?![a-zA-Z])/.test(body.slice(i, i + 6))) {
        push(i);
        let j = i + 5;
        const o = readOpt(body, j);
        if (o.arg !== null) j = o.end;
        cur = { label: o.arg, start: j };
        i = j;
        continue;
      }
      i += 2;
      continue;
    }
    if (c === '{') brace++;
    else if (c === '}') brace--;
    i++;
  }
  push(body.length);
  return items;
}

const unwrapP = (html) => {
  const t = html.trim();
  return t.startsWith('<p>') && t.endsWith('</p>') && t.indexOf('<p>', 1) === -1 ? t.slice(3, -4) : t;
};

function runIn(html, head) {
  const t = html.trim();
  return t.startsWith('<p>') ? `<p>${head} ${t.slice(3)}` : `<p>${head}</p>${t}`;
}

function typo(s) {
  return s
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``/g, '“')
    .replace(/''/g, '”')
    .replace(/`/g, '‘')
    .replace(/'/g, '’');
}

const safeUrl = (u) => {
  const url = String(u).trim().replace(/\\([_#%&~$])/g, '$1');
  if (/^(https?:|mailto:)/i.test(url) || /^[./]/.test(url) || /^[\w-]+\.[\w./-]+$/.test(url)) {
    return /^[\w-]+\.[a-z]{2,}(\/|$)/i.test(url) && !/^[./]/.test(url) ? `https://${url}` : url;
  }
  return null;
};

const safeColor = (c, model) => {
  if (model && /^html$/i.test(model) && /^[0-9a-f]{3,8}$/i.test(c)) return `#${c}`;
  return /^[a-zA-Z]+$/.test(c) ? c : 'inherit';
};

// ---------------------------------------------------------------------------
// Macros: \newcommand, \renewcommand, \DeclareMathOperator, \def

function extractDefs(src, macros) {
  const re = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def)(\*?)\s*/g;
  let out = '';
  let i = 0;
  let m;
  while ((m = re.exec(src))) {
    let j = re.lastIndex;
    let name;
    if (src[j] === '{') {
      const e = findClosing(src, j);
      if (e < 0) continue;
      name = src.slice(j + 1, e).trim();
      j = e + 1;
    } else {
      const mm = /^\\[a-zA-Z]+/.exec(src.slice(j));
      if (!mm) continue;
      name = mm[0];
      j += name.length;
    }
    if (m[1] === 'def') {
      // \def\foo#1#2{...}
      const pm = /^(#\d)*/.exec(src.slice(j));
      j += pm[0].length;
    }
    j = skipSpace(src, j);
    while (src[j] === '[') {
      const e = findClosing(src, j, '[', ']');
      if (e < 0) break;
      j = skipSpace(src, e + 1);
    }
    if (src[j] !== '{') continue;
    const e = findClosing(src, j);
    if (e < 0) continue;
    const body = src.slice(j + 1, e);
    if (/^\\[a-zA-Z]+$/.test(name)) {
      macros[name] = m[1] === 'DeclareMathOperator' ? `\\operatorname${m[2]}{${body}}` : body;
    }
    out += src.slice(i, m.index);
    i = e + 1;
    re.lastIndex = i;
  }
  return out + src.slice(i);
}

export function parseMacros(preamble = '') {
  const macros = {};
  extractDefs(stripComments(preamble), macros);
  return macros;
}

function stripComments(src) {
  return src
    .replace(/^[ \t]*%.*(\n|$)/gm, '')
    .replace(/(^|[^\\])%.*$/gm, '$1');
}

// ---------------------------------------------------------------------------

class Renderer {
  constructor(opts = {}) {
    this.macros = { ...(opts.macros || {}) };
    this.prefix = opts.prefix || 'tex-';
    this.numberSections = opts.numberSections !== false;
    this.store = [];
    this.labels = {};
    this.anchors = {};
    this.eqn = 0;
    this.thm = 0;
    this.floats = {};
    this.sec = [0, 0, 0];
    this.ids = new Set();
    this.footnotes = [];
    this.toc = [];
    this.depth = 0;
  }

  ph(value, block = false) {
    this.store.push(value);
    const n = this.store.length - 1;
    return block ? `\u0002${n}\u0002` : `\u0001${n}\u0001`;
  }

  restore(html) {
    let prev;
    let guard = 0;
    do {
      prev = html;
      html = html.replace(/[\u0001\u0002](\d+)[\u0001\u0002]/g, (_, n) => {
        let v = this.store[+n];
        if (typeof v === 'function') v = this.store[+n] = v();
        return v;
      });
    } while (html !== prev && ++guard < 20);
    return html;
  }

  uid(base) {
    let id = this.prefix + base;
    let k = 2;
    while (this.ids.has(id)) id = `${this.prefix}${base}-${k++}`;
    this.ids.add(id);
    return id;
  }

  // -- math -----------------------------------------------------------------

  math(tex, display) {
    if (typeof katex === 'undefined') {
      return `<code class="tex-math-raw">${esc(display ? `\\[${tex}\\]` : `$${tex}$`)}</code>`;
    }
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        macros: { ...this.macros },
      });
    } catch (e) {
      return `<code class="tex-error" title="${esc(e.message)}">${esc(tex)}</code>`;
    }
  }

  mathRefs(tex) {
    return tex
      .replace(/\\eqref\{([^}]*)\}/g, (_, l) => `\\text{(${this.labels[l] ?? '??'})}`)
      .replace(/\\(?:ref|cref|autoref)\{([^}]*)\}/g, (_, l) => `\\text{${this.labels[l] ?? '??'}}`);
  }

  inlineMath(tex) {
    return this.ph(() => this.math(this.mathRefs(tex), false));
  }

  displayMath(name, star, body) {
    let tag = null;
    body = body.replace(/\\tag\*?\{([^}]*)\}/, (_, t) => { tag = t; return ''; });
    const labels = [];
    body = body.replace(/\\label\{([^}]*)\}/g, (_, l) => { labels.push(l.trim()); return ''; });
    body = body.replace(/\\(nonumber|notag)(?![a-zA-Z])/g, '').replace(/\\(begin|end)\{split\}/g, '\\$1{aligned}');
    let inner;
    if (name === 'equation' || name === 'display') inner = body;
    else if (name === 'gather' || name === 'multline') inner = `\\begin{gathered}${body}\\end{gathered}`;
    else if (name === 'alignat') {
      const m = /^\s*\{(\d+)\}/.exec(body);
      inner = `\\begin{alignedat}{${m ? m[1] : 2}}${m ? body.slice(m[0].length) : body}\\end{alignedat}`;
    } else inner = `\\begin{aligned}${body}\\end{aligned}`;
    if (!star && name !== 'display' && tag === null) tag = String(++this.eqn);
    let id = '';
    for (const l of labels) {
      this.labels[l] = tag ?? '?';
      if (!id) id = this.uid(`eq-${slugify(l)}`);
      this.anchors[l] = id;
    }
    if (tag !== null) inner += `\\tag{${tag}}`;
    return this.ph(() => `<span class="math-display"${id ? ` id="${id}"` : ''}>${this.math(this.mathRefs(inner), true)}</span>`);
  }

  extractMath(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        const nx = src[i + 1];
        if (nx === '[' || nx === '(') {
          const close = nx === '[' ? '\\]' : '\\)';
          const j = src.indexOf(close, i + 2);
          if (j >= 0) {
            const body = src.slice(i + 2, j);
            out += nx === '[' ? this.displayMath('display', true, body) : this.inlineMath(body);
            i = j + 2;
            continue;
          }
        }
        if (nx === 'b') {
          const m = MATH_ENV.exec(src.slice(i, i + 40));
          if (m) {
            const endTag = `\\end{${m[1]}${m[2]}}`;
            const j = src.indexOf(endTag, i + m[0].length);
            if (j >= 0) {
              out += this.displayMath(m[1], !!m[2], src.slice(i + m[0].length, j));
              i = j + endTag.length;
              continue;
            }
          }
        }
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '$') {
        if (src[i + 1] === '$') {
          const j = src.indexOf('$$', i + 2);
          if (j >= 0) {
            out += this.displayMath('display', true, src.slice(i + 2, j));
            i = j + 2;
            continue;
          }
        } else {
          let j = i + 1;
          while (j < n && src[j] !== '$') {
            if (src[j] === '\\') j++;
            else if (src[j] === '\n' && src[j + 1] === '\n') { j = n; break; }
            j++;
          }
          if (j < n && j > i + 1) {
            out += this.inlineMath(src.slice(i + 1, j));
            i = j + 1;
            continue;
          }
        }
      }
      out += c;
      i++;
    }
    return out;
  }

  // -- blocks -----------------------------------------------------------------

  blocks(src) {
    let out = '';
    let i = 0;
    const re = /\\begin\{([a-zA-Z]+\*?)\}/g;
    for (;;) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (!m) { out += this.text(src.slice(i)); break; }
      out += this.text(src.slice(i, m.index));
      const name = m[1];
      const start = re.lastIndex;
      const end = findEnv(src, name, start);
      out += this.env(name, src.slice(start, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + `\\end{${name}}`.length;
    }
    return out;
  }

  text(chunk) {
    const re = /\\(part|chapter|section|subsection|subsubsection)(\*?)\s*(?=[[{])|\u0002\d+\u0002/g;
    let out = '';
    let i = 0;
    let m;
    while ((m = re.exec(chunk))) {
      out += this.paras(chunk.slice(i, m.index));
      if (m[0][0] === '\u0002') { out += m[0]; i = re.lastIndex; continue; }
      let j = re.lastIndex;
      if (chunk[j] === '[') j = findClosing(chunk, j, '[', ']') + 1;
      j = skipSpace(chunk, j);
      if (chunk[j] !== '{') { out += this.paras(m[0]); i = re.lastIndex; continue; }
      const e = findClosing(chunk, j);
      const title = chunk.slice(j + 1, e < 0 ? chunk.length : e);
      i = e < 0 ? chunk.length : e + 1;
      const lm = /^\s*\\label\{([^}]*)\}/.exec(chunk.slice(i));
      if (lm) i += lm[0].length;
      re.lastIndex = i;
      out += this.heading(m[1], !!m[2], title, lm && lm[1].trim());
    }
    return out + this.paras(chunk.slice(i));
  }

  heading(kind, star, title, label) {
    const level = { part: 0, chapter: 0, section: 0, subsection: 1, subsubsection: 2 }[kind];
    let num = '';
    if (!star) {
      this.sec[level]++;
      for (let k = level + 1; k < 3; k++) this.sec[k] = 0;
      num = this.sec.slice(0, level + 1).join('.');
    }
    const html = this.inline(title);
    const id = this.uid(`sec-${slugify(title)}`);
    if (label) { this.labels[label] = num || '?'; this.anchors[label] = id; }
    const showNum = this.numberSections && num;
    this.toc.push({ level, id, num: showNum ? num : '', html });
    const tag = `h${level + 2}`;
    return `<${tag} id="${id}" class="tex-h">${showNum ? `<span class="secnum">${num}</span>` : ''}${html}</${tag}>`;
  }

  paras(text) {
    let out = '';
    for (const p of text.split(/\n[ \t]*\n/)) {
      if (!p.trim()) continue;
      const html = this.inline(p.trim()).trim();
      if (html.replace(/<br>/g, '').trim()) out += `<p>${html}</p>`;
    }
    return out;
  }

  env(name, body) {
    const base = name.replace(/\*$/, '');
    const star = name.endsWith('*');
    switch (base) {
      case 'itemize':
      case 'enumerate':
      case 'description':
      case 'compactitem':
      case 'compactenum':
        return this.list(base, body);
      case 'quote':
      case 'quotation':
      case 'displayquote':
      case 'verse':
        return `<blockquote class="tex-quote">${this.blocks(body)}</blockquote>`;
      case 'abstract':
        return `<div class="tex-abstract"><div class="tex-abstract-title">Abstract</div>${this.blocks(body)}</div>`;
      case 'center':
      case 'flushleft':
      case 'flushright':
        return `<div class="tex-${base}">${this.blocks(body)}</div>`;
      case 'tabular':
      case 'tabularx':
      case 'tabular*':
        return this.tabular(body, base !== 'tabular');
      case 'figure':
      case 'table':
      case 'algorithm':
      case 'wrapfigure':
        return this.float(base === 'wrapfigure' ? 'figure' : base, body);
      case 'algorithmic':
      case 'algorithmicx':
        return this.algorithmic(body);
      case 'proof': {
        const o = readOpt(body, 0);
        const head = `<span class="tex-proof-head">${o.arg !== null ? this.inline(o.arg) : 'Proof'}.</span>`;
        let html = runIn(this.blocks(body.slice(o.end)), head);
        html = /<\/p>\s*$/.test(html) ? html.replace(/<\/p>\s*$/, ' <span class="qed">∎</span></p>') : `${html}<span class="qed">∎</span>`;
        return `<div class="tex-proof">${html}</div>`;
      }
      case 'minipage': {
        let s = body;
        const o = readOpt(s, 0);
        s = s.slice(o.end);
        const a = readArg(s, 0);
        return `<div class="tex-minipage">${this.blocks(a ? s.slice(a.end) : s)}</div>`;
      }
      case 'tcolorbox':
      case 'mdframed':
      case 'framed':
      case 'boxed': {
        const o = readOpt(body, 0);
        return `<div class="tex-box">${this.blocks(body.slice(o.end))}</div>`;
      }
      case 'document':
        return this.blocks(body);
      default:
        break;
    }
    if (THEOREMS[base]) return this.theorem(base, star, body);
    return `<div class="tex-env tex-env-${esc(base)}">${this.blocks(body)}</div>`;
  }

  list(kind, body) {
    const items = splitItems(body);
    if (kind === 'description') {
      const inner = items
        .map(({ label, content }) => `<dt>${label !== null ? this.inline(label) : ''}</dt><dd>${unwrapP(this.blocks(content))}</dd>`)
        .join('');
      return `<dl class="tex-dl">${inner}</dl>`;
    }
    const tag = kind.endsWith('enum') || kind === 'enumerate' ? 'ol' : 'ul';
    const inner = items
      .map(({ label, content }) => {
        const html = unwrapP(this.blocks(content));
        if (label !== null) return `<li class="tex-li-custom"><span class="tex-li-label">${this.inline(label)}</span>${html}</li>`;
        return `<li>${html}</li>`;
      })
      .join('');
    return `<${tag} class="tex-list">${inner}</${tag}>`;
  }

  theorem(kind, star, body) {
    const o = readOpt(body, 0);
    body = body.slice(o.end);
    const num = star ? '' : String(++this.thm);
    const id = this.uid(`${kind}-${num || 'x'}`);
    const lm = /\\label\{([^}]*)\}/.exec(body);
    if (lm) { this.labels[lm[1].trim()] = num || '?'; this.anchors[lm[1].trim()] = id; }
    const head = `<span class="tex-thm-head">${THEOREMS[kind]}${num ? ` ${num}` : ''}${o.arg !== null ? ` <span class="tex-thm-name">(${this.inline(o.arg)})</span>` : ''}.</span>`;
    return `<div class="tex-thm tex-thm-${kind}" id="${id}">${runIn(this.blocks(body), head)}</div>`;
  }

  tabular(body, hasWidth) {
    let s = body.replace(/^\s*\[[^\]]*\]/, '').trimStart();
    if (hasWidth && s[0] === '{') s = s.slice(findClosing(s, 0) + 1).trimStart();
    if (s[0] === '{') s = s.slice(findClosing(s, 0) + 1);
    const RULE = /\\(hline|toprule|midrule|bottomrule|specialrule\{[^}]*\}\{[^}]*\}\{[^}]*\})|\\(cmidrule|cline)(\([^)]*\))?\{[^}]*\}/g;
    const rows = [];
    let ruleNext = false;
    for (let raw of splitTop(s, '\\\\')) {
      raw = raw.replace(/^\s*\[[^\]]*\]/, '');
      const ruleBefore = /^\s*\\(hline|toprule|midrule|cmidrule|cline|specialrule)/.test(raw);
      const content = raw.replace(RULE, '').trim();
      if (!content) { if (ruleBefore || RULE.test(raw)) ruleNext = true; RULE.lastIndex = 0; continue; }
      rows.push({ ruleBefore: ruleBefore || ruleNext, cells: splitTop(content, '&') });
      ruleNext = false;
    }
    const cell = (c, tag) => {
      const t = c.trim();
      const mc = /^\\multicolumn\s*\{(\d+)\}\s*\{[^}]*\}\s*\{([\s\S]*)\}$/.exec(t);
      if (mc) return `<${tag} colspan="${+mc[1]}">${this.inline(mc[2])}</${tag}>`;
      const mr = /^\\multirow\s*\{(\d+)\}\s*\{[^}]*\}\s*\{([\s\S]*)\}$/.exec(t);
      if (mr) return `<${tag} rowspan="${+mr[1]}">${this.inline(mr[2])}</${tag}>`;
      return `<${tag}>${this.inline(t)}</${tag}>`;
    };
    const header = rows.length > 1 && rows[1].ruleBefore;
    let html = '<div class="tex-table-wrap"><table class="tex-table">';
    rows.forEach((r, k) => {
      if (k === 0 && header) html += `<thead><tr>${r.cells.map((c) => cell(c, 'th')).join('')}</tr></thead><tbody>`;
      else {
        if (k === 0) html += '<tbody>';
        html += `<tr>${r.cells.map((c) => cell(c, 'td')).join('')}</tr>`;
      }
    });
    return `${html}</tbody></table></div>`;
  }

  float(kind, body) {
    body = body.replace(/^\s*\[[^\]]*\]/, '');
    if (kind === 'figure') body = body.replace(/^\s*\{[^}]*\}\s*\{[^}]*\}/, ''); // wrapfigure args
    let captionHtml = '';
    let capFirst = false;
    const cm = /\\caption\s*(\[[^\]]*\])?\s*\{/.exec(body);
    const num = String((this.floats[kind] = (this.floats[kind] || 0) + 1));
    const id = this.uid(`${kind}-${num}`);
    const lm = /\\label\{([^}]*)\}/.exec(body);
    if (lm) { this.labels[lm[1].trim()] = num; this.anchors[lm[1].trim()] = id; }
    if (cm) {
      const open = cm.index + cm[0].length - 1;
      const close = findClosing(body, open);
      const cap = body.slice(open + 1, close < 0 ? body.length : close);
      capFirst = !body.slice(0, cm.index).replace(/\\(centering|small|footnotesize|label\{[^}]*\})/g, '').trim();
      body = body.slice(0, cm.index) + body.slice(close < 0 ? body.length : close + 1);
      captionHtml = `<figcaption><span class="tex-cap-label">${FLOATS[kind]} ${num}.</span> ${this.inline(cap)}</figcaption>`;
    }
    const inner = this.blocks(body);
    return `<figure class="tex-float tex-float-${kind}" id="${id}">${capFirst ? captionHtml + inner : inner + captionHtml}</figure>`;
  }

  algorithmic(body) {
    body = body.replace(/^\s*\[[^\]]*\]/, '');
    const NORM = {
      STATE: 'State', IF: 'If', ELSIF: 'ElsIf', ELSE: 'Else', ENDIF: 'EndIf', FOR: 'For', FORALL: 'ForAll',
      ENDFOR: 'EndFor', WHILE: 'While', ENDWHILE: 'EndWhile', REPEAT: 'Repeat', UNTIL: 'Until',
      REQUIRE: 'Require', ENSURE: 'Ensure', RETURN: 'Return', LOOP: 'Loop', ENDLOOP: 'EndLoop', COMMENT: 'Comment',
    };
    const KW = /\\(Statex|State|ElsIf|Else|EndIf|If|ForAll|EndFor|For|EndWhile|While|Repeat|Until|EndLoop|Loop|Require|Ensure|Input|Output|Return|EndFunction|Function|EndProcedure|Procedure|STATE|ELSIF|ELSE|ENDIF|IF|FORALL|ENDFOR|FOR|ENDWHILE|WHILE|REPEAT|UNTIL|REQUIRE|ENSURE|RETURN|ENDLOOP|LOOP)(?![a-zA-Z])/g;
    const segs = [];
    let m;
    let cur = null;
    let last = 0;
    while ((m = KW.exec(body))) {
      if (cur) cur.rest = body.slice(last, m.index);
      cur = { cmd: NORM[m[1]] || m[1] };
      segs.push(cur);
      last = KW.lastIndex;
    }
    if (cur) cur.rest = body.slice(last);
    const kw = (w) => `<span class="alg-kw">${w}</span>`;
    const lines = [];
    let depth = 0;
    let n = 0;
    const line = (d, html, numbered = true) => lines.push({ d: Math.max(0, d), html, n: numbered ? ++n : null });
    for (const seg of segs) {
      let r = seg.rest;
      const arg = () => {
        const j = skipSpace(r, 0);
        if (r[j] !== '{') return '';
        const a = readArg(r, j);
        r = r.slice(a.end);
        return this.inline(a.arg);
      };
      const rest = () => this.inline(r.trim());
      switch (seg.cmd) {
        case 'State': line(depth, rest()); break;
        case 'Statex': line(depth, rest(), false); break;
        case 'If': { const c = arg(); line(depth, `${kw('if')} ${c} ${kw('then')} ${rest()}`); depth++; break; }
        case 'ElsIf': { const c = arg(); line(depth - 1, `${kw('else if')} ${c} ${kw('then')} ${rest()}`); break; }
        case 'Else': line(depth - 1, `${kw('else')} ${rest()}`); break;
        case 'EndIf': depth--; line(depth, `${kw('end if')} ${rest()}`); break;
        case 'For': { const c = arg(); line(depth, `${kw('for')} ${c} ${kw('do')} ${rest()}`); depth++; break; }
        case 'ForAll': { const c = arg(); line(depth, `${kw('for all')} ${c} ${kw('do')} ${rest()}`); depth++; break; }
        case 'EndFor': depth--; line(depth, `${kw('end for')} ${rest()}`); break;
        case 'While': { const c = arg(); line(depth, `${kw('while')} ${c} ${kw('do')} ${rest()}`); depth++; break; }
        case 'EndWhile': depth--; line(depth, `${kw('end while')} ${rest()}`); break;
        case 'Repeat': line(depth, `${kw('repeat')} ${rest()}`); depth++; break;
        case 'Until': { depth--; const c = arg(); line(depth, `${kw('until')} ${c} ${rest()}`); break; }
        case 'Loop': line(depth, `${kw('loop')} ${rest()}`); depth++; break;
        case 'EndLoop': depth--; line(depth, `${kw('end loop')} ${rest()}`); break;
        case 'Require': case 'Input': line(depth, `${kw('Input:')} ${rest()}`, false); break;
        case 'Ensure': case 'Output': line(depth, `${kw('Output:')} ${rest()}`, false); break;
        case 'Return': line(depth, `${kw('return')} ${rest()}`); break;
        case 'Function': case 'Procedure': {
          const name = arg();
          const args = arg();
          line(depth, `${kw(seg.cmd.toLowerCase())} <span class="sc">${name}</span>(${args}) ${rest()}`);
          depth++;
          break;
        }
        case 'EndFunction': case 'EndProcedure':
          depth--;
          line(depth, `${kw(seg.cmd === 'EndFunction' ? 'end function' : 'end procedure')} ${rest()}`);
          break;
        default: line(depth, rest());
      }
    }
    const html = lines
      .map((l) => `<div class="alg-line" style="--d:${l.d}"><span class="alg-n">${l.n ?? ''}</span><span class="alg-body">${l.html}</span></div>`)
      .join('');
    return `<div class="tex-alg">${html}</div>`;
  }

  // -- inline -------------------------------------------------------------------

  inline(s) {
    let out = '';
    let buf = '';
    let i = 0;
    const flush = () => { if (buf) { out += esc(typo(buf)); buf = ''; } };
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const nx = s[i + 1];
        if (nx === undefined) { buf += c; i++; continue; }
        if (nx === '\\') {
          flush();
          out += '<br>';
          i += 2;
          const o = readOpt(s, i);
          if (o.arg !== null && /^\s*-?[\d.]+\s*[a-z]{2}\s*$/.test(o.arg)) i = o.end;
          continue;
        }
        if (ACCENTS[nx]) {
          i += 2;
          let ch;
          if (s[i] === '{') {
            const e = findClosing(s, i);
            ch = s.slice(i + 1, e < 0 ? s.length : e);
            i = e < 0 ? s.length : e + 1;
          } else { ch = s[i] || ''; i++; }
          buf += (ch.replace(/^\\i$/, 'i').replace(/^\\j$/, 'j') + ACCENTS[nx]).normalize('NFC');
          continue;
        }
        if (!/[a-zA-Z@]/.test(nx)) {
          const sym = { ',': ' ', ';': ' ', ':': ' ', '!': '', '-': '', '/': '', '@': '', ' ': ' ', '\n': ' ' }[nx];
          buf += sym !== undefined ? sym : nx;
          i += 2;
          continue;
        }
        const m = /^[a-zA-Z@]+\*?/.exec(s.slice(i + 1, i + 60));
        flush();
        const res = this.command(m[0].replace(/\*$/, ''), s, i + 1 + m[0].length, m[0].endsWith('*'));
        out += res.html;
        i = res.end;
        continue;
      }
      if (c === '{') {
        flush();
        const e = findClosing(s, i);
        if (e < 0) { i++; continue; }
        out += this.group(s.slice(i + 1, e));
        i = e + 1;
        continue;
      }
      if (c === '}') { i++; continue; }
      if (c === '~') { buf += ' '; i++; continue; }
      if (c === '\n') { buf += ' '; i++; continue; }
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  group(content) {
    const dm = /^\s*\\(bf|bfseries|em|it|itshape|sl|tt|ttfamily|sc|scshape|small|footnotesize|large|Large|color\{[^}]*\})(?![a-zA-Z])\s*/.exec(content);
    if (!dm) return this.inline(content);
    const inner = this.inline(content.slice(dm[0].length));
    const d = dm[1];
    if (d === 'bf' || d === 'bfseries') return `<strong>${inner}</strong>`;
    if (['em', 'it', 'itshape', 'sl'].includes(d)) return `<em>${inner}</em>`;
    if (d === 'tt' || d === 'ttfamily') return `<code>${inner}</code>`;
    if (d === 'sc' || d === 'scshape') return `<span class="sc">${inner}</span>`;
    if (d.startsWith('color')) return `<span style="color:${safeColor(d.slice(6, -1))}">${inner}</span>`;
    return `<span class="tex-${d.toLowerCase()}">${inner}</span>`;
  }

  command(name, s, j, star) {
    const arg = () => {
      const a = readArg(s, j);
      if (!a) return '';
      j = a.end;
      return a.arg;
    };
    const opt = () => {
      const o = readOpt(s, j);
      j = o.end;
      return o.arg;
    };
    const wrap = (tag, cls) => `<${tag}${cls ? ` class="${cls}"` : ''}>${this.inline(arg())}</${tag}>`;
    let h = '';
    switch (name) {
      case 'textbf': case 'textmd': h = wrap('strong'); break;
      case 'textit': case 'emph': case 'textsl': h = wrap('em'); break;
      case 'underline': case 'uline': h = wrap('u'); break;
      case 'sout': case 'st': h = wrap('s'); break;
      case 'texttt': case 'code': case 'path': h = wrap('code'); break;
      case 'textsc': h = wrap('span', 'sc'); break;
      case 'textsf': case 'textrm': case 'textnormal': case 'textup': case 'mbox': case 'text': case 'hbox':
        h = this.inline(arg()); break;
      case 'textsuperscript': h = wrap('sup'); break;
      case 'textsubscript': h = wrap('sub'); break;
      case 'hl': case 'highlight': case 'colorbox': case 'fcolorbox':
        if (name === 'colorbox') arg();
        if (name === 'fcolorbox') { arg(); arg(); }
        h = wrap('mark'); break;
      case 'todo': case 'TODO': case 'fixme': opt(); h = `<span class="tex-todo">${this.inline(arg())}</span>`; break;
      case 'textcolor': { const model = opt(); const col = arg(); h = `<span style="color:${safeColor(col, model)}">${this.inline(arg())}</span>`; break; }
      case 'href': {
        const u = arg();
        const t = arg();
        const url = safeUrl(u);
        h = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${this.inline(t)}</a>` : this.inline(t);
        break;
      }
      case 'url': case 'nolinkurl': {
        const u = arg();
        const url = safeUrl(u);
        h = url && name === 'url' ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="tex-url">${esc(u.replace(/\\([_#%&~$])/g, '$1'))}</a>` : `<code>${esc(u)}</code>`;
        break;
      }
      case 'cite': case 'citep': case 'citet': case 'citealp': case 'citealt': case 'citeauthor':
      case 'citeyear': case 'parencite': case 'textcite': case 'autocite': {
        const o1 = opt();
        const o2 = opt();
        const keys = arg().split(',').map((k) => k.trim()).filter(Boolean);
        const pre = o2 !== null ? o1 : null;
        const post = o2 !== null ? o2 : o1;
        h = `<span class="tex-cite">[${pre ? `${this.inline(pre)} ` : ''}${keys.map((k) => `<span class="tex-cite-key">${esc(k)}</span>`).join(', ')}${post ? `, ${this.inline(post)}` : ''}]</span>`;
        break;
      }
      case 'ref': case 'autoref': case 'cref': case 'Cref': case 'pageref': case 'nameref': {
        const l = arg().trim();
        h = this.ph(() => this.refHtml(l, false));
        break;
      }
      case 'eqref': { const l = arg().trim(); h = this.ph(() => this.refHtml(l, true)); break; }
      case 'footnote': {
        opt();
        const t = arg();
        const k = this.footnotes.push('');
        this.footnotes[k - 1] = this.inline(t);
        h = `<sup class="tex-fn" id="${this.prefix}fnref-${k}"><a data-scroll="${this.prefix}fn-${k}">${k}</a></sup>`;
        break;
      }
      case 'LaTeX': h = '<span class="tex-logo">L<span class="a">a</span>T<span class="e">e</span>X</span>'; break;
      case 'TeX': h = '<span class="tex-logo">T<span class="e">e</span>X</span>'; break;
      case 'today': h = esc(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })); break;
      case 'newline': case 'linebreak': case 'par': h = '<br>'; break;
      case 'item': { const l = opt(); h = `<br><span class="tex-li-label">${l !== null ? this.inline(l) : '•'}</span> `; break; }
      case 'includegraphics': {
        const o = opt() || '';
        const src = safeUrl(arg());
        const wm = /width\s*=\s*([\d.]*)\s*\\(linewidth|textwidth|columnwidth)/.exec(o);
        const style = wm ? ` style="width:${Math.min(100, (parseFloat(wm[1]) || 1) * 100)}%"` : '';
        h = src ? `<img class="tex-img" src="${esc(src)}" alt="" loading="lazy"${style}>` : '';
        break;
      }
      case 'caption': opt(); h = `<span class="tex-caption">${this.inline(arg())}</span>`; break;
      case 'paragraph': case 'subparagraph': h = `<strong class="tex-runin">${this.inline(arg())}</strong> `; break;
      case 'Comment': h = `<span class="alg-comment">▷ ${this.inline(arg())}</span>`; break;
      case 'c': case 'v': case 'u': case 'H': case 'r': case 'k': {
        const a = readArg(s, j);
        if (a && a.arg.length === 1) { j = a.end; h = esc((a.arg + LETTER_ACCENTS[name]).normalize('NFC')); }
        break;
      }
      default: {
        if (SYMBOLS[name] !== undefined) {
          h = esc(SYMBOLS[name]);
          if (s.startsWith('{}', j)) j += 2;
          break;
        }
        if (IGNORED.has(name)) { if (s.startsWith('{}', j)) j += 2; break; }
        if (SWALLOW[name] !== undefined) {
          opt();
          for (let k = 0; k < SWALLOW[name]; k++) arg();
          break;
        }
        const macro = this.macros[`\\${name}`];
        if (macro !== undefined && this.depth < 10 && !/\\(math|mathbb|mathcal|operatorname|frac|left|right)/.test(macro)) {
          const nArgs = Math.max(0, ...[...macro.matchAll(/#(\d)/g)].map((x) => +x[1]));
          const args = [];
          for (let k = 0; k < nArgs; k++) args.push(arg());
          this.depth++;
          h = this.inline(macro.replace(/#(\d)/g, (_, d) => args[+d - 1] ?? ''));
          this.depth--;
          break;
        }
        let inner = '';
        while (s[j] === '{') inner += this.inline(arg());
        h = inner || `<code class="tex-unknown" title="Unknown command">\\${esc(name)}${star ? '*' : ''}</code>`;
      }
    }
    return { html: h, end: j };
  }

  refHtml(label, paren) {
    const n = this.labels[label];
    const text = `${paren ? '(' : ''}${esc(n ?? '??')}${paren ? ')' : ''}`;
    const id = this.anchors[label];
    return id ? `<a class="tex-ref" data-scroll="${id}">${text}</a>` : `<span class="tex-ref tex-ref-missing" title="Undefined reference: ${esc(label)}">${text}</span>`;
  }

  // -- entry points -------------------------------------------------------------

  protect(src) {
    src = String(src ?? '').replace(/\r\n?/g, '\n');
    src = src.replace(VERBATIM_ENV, (_, env, opt, arg, body) => {
      const lang = env === 'minted' && arg ? arg.slice(1, -1) : (/language\s*=\s*([\w+#-]+)/.exec(opt || '') || [])[1] || '';
      return `\n\n${this.ph(`<pre class="tex-code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.replace(/\s+$/, ''))}</code></pre>`, true)}\n\n`;
    });
    src = src.replace(/\\verb\*?([^a-zA-Z\s{])(.*?)\1/g, (_, d, body) => this.ph(`<code>${esc(body)}</code>`));
    // In one-liners (titles, TL;DRs) a bare % is far more likely to mean "percent".
    if (!this.oneLine) src = stripComments(src);
    src = extractDefs(src, this.macros);
    return this.extractMath(src);
  }

  document(src) {
    let html = this.blocks(this.protect(src));
    if (this.footnotes.length) {
      html += `<section class="tex-footnotes"><ol>${this.footnotes
        .map((f, k) => `<li id="${this.prefix}fn-${k + 1}">${f} <a class="fn-back" data-scroll="${this.prefix}fnref-${k + 1}">↩</a></li>`)
        .join('')}</ol></section>`;
    }
    return {
      html: this.restore(html),
      toc: this.toc.map((t) => ({ ...t, html: this.restore(t.html) })),
    };
  }
}

/** Renders a LaTeX document fragment. Returns { html, toc }. */
export function renderTeX(src, opts = {}) {
  if (!String(src ?? '').trim()) return { html: '', toc: [] };
  try {
    return new Renderer(opts).document(src);
  } catch (e) {
    console.error(e);
    return { html: `<pre class="tex-code tex-error">${esc(src)}</pre>`, toc: [] };
  }
}

/** Renders a single line (titles, TL;DRs): inline math and text commands only. */
export function renderInline(src, opts = {}) {
  if (!String(src ?? '').trim()) return '';
  try {
    const r = new Renderer(opts);
    r.oneLine = true;
    return r.restore(r.inline(r.protect(src).replace(/\n\s*\n/g, ' ')));
  } catch {
    return esc(src);
  }
}

/** Rough plain-text version (for spine labels, search snippets, tooltips). */
export function texPlain(src = '') {
  return String(src)
    .replace(/\\(textbf|textit|emph|texttt|textsc|text|mathrm|mathbf|mathcal|mathbb)\{([^}]*)\}/g, '$2')
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, '')
    .replace(/[{}$]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

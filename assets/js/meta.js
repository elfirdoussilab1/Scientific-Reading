// Paper metadata: arXiv / Semantic Scholar / Crossref lookups and BibTeX parsing.

import { lastName, slugify } from './util.js';

const VENUES = /\b(NeurIPS|NIPS|ICML|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|NAACL|COLING|AAAI|IJCAI|AISTATS|UAI|COLT|CoRL|RSS|ICRA|IROS|TMLR|JMLR|KDD|WWW|SIGGRAPH|WACV|BMVC|COLM|ALT|L4DC)\b[\s']*((?:19|20)?\d{2})?/i;

export function parseArxivId(input) {
  const s = String(input).trim();
  const m =
    /arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i.exec(s) ||
    /^(?:arxiv:\s*)?(\d{4}\.\d{4,5})(v\d+)?$/i.exec(s) ||
    /^(?:arxiv:\s*)?([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/i.exec(s);
  return m ? m[1] : null;
}

export function parseDoi(input) {
  const m = /(?:doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[^\s"<>]+)/i.exec(String(input).trim());
  return m ? m[1].replace(/[.,;]$/, '') : null;
}

const clean = (s = '') => String(s).replace(/\s+/g, ' ').trim();

const VENUE_NAMES = [
  [/neural information processing systems/i, 'NeurIPS'],
  [/international conference (on|for) learning representations/i, 'ICLR'],
  [/international conference on machine learning/i, 'ICML'],
  [/computer vision and pattern recognition/i, 'CVPR'],
  [/international conference on computer vision/i, 'ICCV'],
  [/european conference on computer vision/i, 'ECCV'],
  [/conference on learning theory/i, 'COLT'],
  [/artificial intelligence and statistics/i, 'AISTATS'],
  [/uncertainty in artificial intelligence/i, 'UAI'],
  [/transactions on machine learning research/i, 'TMLR'],
  [/journal of machine learning research/i, 'JMLR'],
  [/conference on robot learning/i, 'CoRL'],
  [/association for computational linguistics/i, 'ACL'],
  [/empirical methods in natural language processing/i, 'EMNLP'],
];

function venueFrom(...texts) {
  for (const t of texts) {
    if (!t) continue;
    const m = VENUES.exec(t);
    if (m) {
      let name = m[1].toUpperCase() === 'NIPS' ? 'NeurIPS' : m[1];
      const canon = ['NeurIPS', 'CoRL', 'TMLR', 'JMLR', 'COLM'].find((v) => v.toLowerCase() === name.toLowerCase());
      name = canon || name.toUpperCase();
      let y = m[2] || '';
      if (y.length === 2) y = `20${y}`;
      return y ? `${name} ${y}` : name;
    }
    const full = VENUE_NAMES.find(([re]) => re.test(t));
    if (full) {
      const y = (/\b(19|20)\d{2}\b/.exec(t) || [])[0];
      return y ? `${full[1]} ${y}` : full[1];
    }
  }
  return '';
}

const arxivLinks = (id) => ({ arxiv: `https://arxiv.org/abs/${id}`, pdf: `https://arxiv.org/pdf/${id}` });

// arXiv's own API does not send CORS headers, so browsers can't call it.
// arXiv DOIs are registered with DataCite, whose API can be called from any page.
async function fetchDatacite(id) {
  const r = await fetch(`https://api.datacite.org/dois/${encodeURIComponent(`10.48550/arXiv.${id}`)}`);
  if (!r.ok) throw new Error(r.status === 404 ? 'arXiv paper not found' : `DataCite returned ${r.status}`);
  const a = (await r.json()).data.attributes;
  const descs = a.descriptions || [];
  const other = descs.filter((d) => d.descriptionType !== 'Abstract').map((d) => d.description).join(' ');
  return {
    title: clean(a.titles?.[0]?.title),
    authors: (a.creators || []).map((c) =>
      clean(c.givenName && c.familyName ? `${c.givenName} ${c.familyName}` : (c.name || '').split(',').map((x) => x.trim()).reverse().join(' ')),
    ),
    year: +a.publicationYear || '',
    venue: venueFrom(other) || 'arXiv',
    abstract: clean(descs.find((d) => d.descriptionType === 'Abstract')?.description || ''),
    links: arxivLinks(id),
    arxivId: id,
    source: 'arXiv',
  };
}

function fromOpenAlex(w) {
  const words = [];
  for (const [word, pos] of Object.entries(w.abstract_inverted_index || {})) for (const i of pos) words[i] = word;
  const loc = w.primary_location || {};
  const links = {};
  if (w.doi) links.doi = w.doi;
  if (loc.pdf_url) links.pdf = loc.pdf_url;
  if (loc.landing_page_url && !links.doi) links.url = loc.landing_page_url;
  return {
    title: clean(w.title),
    authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    year: w.publication_year || '',
    venue: venueFrom(loc.source?.display_name) || loc.source?.display_name || '',
    abstract: clean(words.join(' ')),
    links,
    source: 'OpenAlex',
  };
}

async function searchOpenAlex(title) {
  const r = await fetch(`https://api.openalex.org/works?filter=title.search:${encodeURIComponent(title.replace(/[,:|]/g, ' '))}&per_page=1`);
  if (!r.ok) throw new Error(`OpenAlex returned ${r.status}`);
  const w = (await r.json()).results?.[0];
  if (!w) throw new Error('No paper found with that title');
  const ax = (w.locations || []).map((l) => parseArxivId(l.landing_page_url || '')).find(Boolean);
  if (ax) {
    try { return await fetchDatacite(ax); } catch { /* fall back to OpenAlex data */ }
  }
  return fromOpenAlex(w);
}

const S2_FIELDS = 'title,authors,year,venue,abstract,externalIds,openAccessPdf,journal';

function fromS2(p) {
  const ax = p.externalIds?.ArXiv;
  const links = {};
  if (ax) Object.assign(links, arxivLinks(ax));
  if (p.openAccessPdf?.url && !links.pdf) links.pdf = p.openAccessPdf.url;
  if (p.externalIds?.DOI) links.doi = `https://doi.org/${p.externalIds.DOI}`;
  return {
    title: clean(p.title),
    authors: (p.authors || []).map((a) => a.name),
    year: p.year || '',
    venue: p.venue ? venueFrom(`${p.venue} ${p.year || ''}`) || p.venue : ax ? 'arXiv' : '',
    abstract: clean(p.abstract || ''),
    links,
    arxivId: ax || '',
    source: 'Semantic Scholar',
  };
}

async function fetchS2(key) {
  const r = await fetch(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(key)}?fields=${S2_FIELDS}`);
  if (!r.ok) throw new Error(r.status === 429 ? 'Semantic Scholar rate limit — try again in a minute' : `Semantic Scholar returned ${r.status}`);
  return fromS2(await r.json());
}

async function searchS2(title) {
  const r = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=${S2_FIELDS}`);
  if (!r.ok) throw new Error(r.status === 429 ? 'Semantic Scholar rate limit — try again in a minute' : `Semantic Scholar returned ${r.status}`);
  const j = await r.json();
  if (!j.data?.length) throw new Error('No paper found with that title');
  return fromS2(j.data[0]);
}

async function fetchCrossref(doi) {
  const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (!r.ok) throw new Error(`Crossref returned ${r.status}`);
  const m = (await r.json()).message;
  const year = m.issued?.['date-parts']?.[0]?.[0] || m.published?.['date-parts']?.[0]?.[0] || '';
  const container = m['container-title']?.[0] || m.event?.name || '';
  return {
    title: clean(m.title?.[0]),
    authors: (m.author || []).map((a) => clean([a.given, a.family].filter(Boolean).join(' ') || a.name)),
    year,
    venue: venueFrom(container, m.event?.name) || container,
    abstract: clean((m.abstract || '').replace(/<[^>]+>/g, ' ')),
    links: { doi: `https://doi.org/${doi}` },
    source: 'Crossref',
  };
}

async function firstOk(tasks) {
  let last;
  for (const t of tasks) {
    try {
      return await t();
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error('Lookup failed');
}

/**
 * Resolves an arXiv URL/ID, DOI, BibTeX entry or a title to paper metadata.
 */
export async function lookup(input) {
  const m = await resolve(input);
  // Cite the year of the venue (e.g. ICLR 2015) rather than the preprint year.
  const vy = /\b((?:19|20)\d{2})$/.exec(m.venue || '');
  if (vy) m.year = +vy[1];
  return m;
}

async function resolve(input) {
  const s = String(input).trim();
  if (!s) throw new Error('Paste an arXiv link, DOI, BibTeX entry or title');
  if (s.startsWith('@')) {
    const [entry] = parseBibtex(s);
    if (!entry) throw new Error('Could not parse that BibTeX');
    return { ...bibToPaper(entry), bibtex: s, source: 'BibTeX' };
  }
  const ax = parseArxivId(s);
  if (ax) return firstOk([() => fetchDatacite(ax), () => fetchS2(`arXiv:${ax}`)]);
  const doi = parseDoi(s);
  if (doi) {
    const axFromDoi = /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
    if (axFromDoi) return firstOk([() => fetchDatacite(axFromDoi[1]), () => fetchS2(`arXiv:${axFromDoi[1]}`)]);
    return firstOk([() => fetchCrossref(doi), () => fetchS2(`DOI:${doi}`)]);
  }
  if (/^https?:\/\//.test(s)) throw new Error('Paste an arXiv link, a DOI or the paper title instead of this URL');
  return firstOk([() => searchS2(s), () => searchOpenAlex(s)]);
}

// ---------------------------------------------------------------------------
// BibTeX

export function parseBibtex(src) {
  const entries = [];
  const re = /@(\w+)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const type = m[1].toLowerCase();
    if (['comment', 'preamble', 'string'].includes(type)) continue;
    let i = re.lastIndex;
    let depth = 1;
    let j = i;
    for (; j < src.length && depth; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
    }
    const body = src.slice(i, j - 1);
    re.lastIndex = j;
    const comma = body.indexOf(',');
    const key = body.slice(0, comma).trim();
    const fields = {};
    let k = comma + 1;
    while (k < body.length) {
      const fm = /^\s*([\w-]+)\s*=\s*/.exec(body.slice(k));
      if (!fm) break;
      k += fm[0].length;
      let value = '';
      if (body[k] === '{') {
        let d = 0;
        let e = k;
        for (; e < body.length; e++) {
          if (body[e] === '{') d++;
          else if (body[e] === '}' && --d === 0) break;
        }
        value = body.slice(k + 1, e);
        k = e + 1;
      } else if (body[k] === '"') {
        const e = body.indexOf('"', k + 1);
        value = body.slice(k + 1, e);
        k = e + 1;
      } else {
        const vm = /^[^,\s]+/.exec(body.slice(k));
        value = vm ? vm[0] : '';
        k += value.length;
      }
      fields[fm[1].toLowerCase()] = value.replace(/\s+/g, ' ').trim();
      const nc = body.indexOf(',', k);
      k = nc < 0 ? body.length : nc + 1;
    }
    entries.push({ type, key, fields });
  }
  return entries;
}

const unbrace = (s = '') =>
  s
    .replace(/\\(?:textit|textbf|emph)\{([^}]*)\}/g, '$1')
    .replace(/\{\\["'`^~=.](\w)\}/g, '$1')
    .replace(/[{}]/g, '')
    .trim();

function bibAuthor(a) {
  const n = unbrace(a);
  if (!n.includes(',')) return n;
  const [last, first] = n.split(',').map((x) => x.trim());
  return `${first} ${last}`.trim();
}

export function bibToPaper({ fields }) {
  const links = {};
  const eprint = fields.eprint || (/arxiv\.org\/abs\/([\w./-]+)/i.exec(fields.url || '') || [])[1];
  const ax = eprint && parseArxivId(eprint);
  if (ax) { links.arxiv = `https://arxiv.org/abs/${ax}`; links.pdf = `https://arxiv.org/pdf/${ax}`; }
  if (fields.doi) links.doi = `https://doi.org/${fields.doi}`;
  if (fields.url && !ax) links.url = fields.url;
  const container = unbrace(fields.booktitle || fields.journal || '');
  return {
    title: unbrace(fields.title || ''),
    authors: (fields.author || '').split(/\s+and\s+/i).map(bibAuthor).filter(Boolean),
    year: +fields.year || '',
    venue: venueFrom(`${container} ${fields.year || ''}`) || container.replace(/^arXiv preprint.*/i, 'arXiv'),
    abstract: unbrace(fields.abstract || ''),
    links,
  };
}

const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'in', 'to', 'and', 'with', 'is', 'are', 'towards', 'toward', 'via', 'from', 'by', 'at', 'as', 'what', 'how', 'why', 'do', 'does', 'can']);

export function citeKey(p) {
  const last = slugify(lastName(p.authors?.[0] || 'anon')).replace(/-/g, '');
  const word = (p.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).find((w) => w && !STOP.has(w)) || 'paper';
  return `${last}${p.year || ''}${word}`;
}

export function makeBibtex(p) {
  const ax = p.links?.arxiv && parseArxivId(p.links.arxiv);
  const venue = p.venue || '';
  const isArxiv = !venue || /^arxiv$/i.test(venue);
  const type = isArxiv ? 'article' : /journal|transactions|jmlr|tmlr|nature|science/i.test(venue) ? 'article' : 'inproceedings';
  const f = [
    ['title', `{${p.title || ''}}`],
    ['author', `{${(p.authors || []).join(' and ')}}`],
  ];
  if (isArxiv) f.push(['journal', `{arXiv preprint${ax ? ` arXiv:${ax}` : ''}}`]);
  else f.push([type === 'article' ? 'journal' : 'booktitle', `{${venue.replace(/\s*\d{4}$/, '')}}`]);
  if (p.year) f.push(['year', `{${p.year}}`]);
  if (ax) { f.push(['eprint', `{${ax}}`]); f.push(['archivePrefix', '{arXiv}']); }
  const doi = p.links?.doi && p.links.doi.replace(/^https?:\/\/doi\.org\//, '');
  if (doi) f.push(['doi', `{${doi}}`]);
  const url = p.links?.arxiv || p.links?.url;
  if (url) f.push(['url', `{${url}}`]);
  const w = Math.max(...f.map(([k]) => k.length));
  return `@${type}{${citeKey(p)},\n${f.map(([k, v]) => `  ${k.padEnd(w)} = ${v}`).join(',\n')}\n}`;
}

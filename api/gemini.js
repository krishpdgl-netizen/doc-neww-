// POST /api/gemini
//   page read : { image: <base64 jpeg/png of ONE page>, mime? }          -> { lines: [{ text, box_2d:[ymin,xmin,ymax,xmax] }] }
//   compare   : { mode:'compare', a: <original blocks>, b: <updated blocks> } -> { changes: [...] }
//   verify    : { mode:'verify', items: [...] }                           -> { verdicts: [{ id, real, summary }] }
//
// Env vars (Vercel > Project > Settings > Environment Variables):
//   GEMINI_API_KEY      required (GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY also accepted)
//   GEMINI_MODEL        optional, default gemini-3.1-flash-lite
//   GEMINI_TEMPERATURE  optional, leave unset to use the model default

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const MAX_B64 = 4 * 1024 * 1024;      // Vercel request bodies are limited to about 4.5 MB
const MAX_TEXT = 700 * 1024;          // per-document text limit for compare

const READ_PROMPT = `You are the text-reading stage of a document comparison tool. Read this single page image and transcribe ALL text on it.

Return one entry per visual line of text, in natural reading order. Table cells that sit on the same row belong to ONE line, in left-to-right order.
For every line give box_2d as [ymin, xmin, ymax, xmax], integers from 0 to 1000, relative to the image, drawn tightly around that line's ink (not around neighbouring lines).

Rules:
- Copy the characters exactly as they appear: same words, numbers, currency symbols, punctuation and capitalisation. Keep list numbers and bullets.
- Never correct spelling, never translate, never summarise, never add words that are not visible, never guess missing words.
- Do not merge or split words. Keep hyphenated words as printed.
- The page may be a phone photo or a tilted scan. Ignore scanner borders, shadows, dust, specks and page edges. Do not transcribe numbers or marks that sit alone in the outer page margin.
- Include stamps, handwriting, filled-in form values, headers, footers and page numbers.
- Write a blank fill-in line as a run of underscores inside its line. Write a signature as [signature] and unreadable text as [illegible].
- If the page has no text return an empty list.`;

const COMPARE_PROMPT = `You compare two versions of one document. Version A is the ORIGINAL and version B is the UPDATED copy.
Each version is a list of numbered blocks (paragraphs, headings, table rows), written as: ID [page] text. A-blocks have ids like A12, B-blocks like B15.
Both versions were extracted from PDFs or scans, so the wording may carry harmless extraction differences.

DO NOT report (these are not changes): line breaks, hyphenation at line ends, spacing, quote or dash styles, capitalisation of the same word, page headers/footers/page numbers, list or clause renumbering, text that merely sits in a different block split, OCR or transcription noise, blank fill-in lines, signature or stamp placeholders.
DO report every real difference: changed, added or removed words; any different number, amount, percentage, date, name, party, address, defined term, legal obligation word (shall/may/must/not); added or removed sentences, clauses, rows or whole blocks; and passages that moved to a different place (type "moved"), also when they were edited while moving.

For each change give:
- type: "added" (only in B), "deleted" (only in A), "modified" (in both, different), or "moved".
- a_blocks / b_blocks: the block ids the change touches (A ids only in a_blocks, B ids only in b_blocks). Empty list when the side has no text for it.
- old_text / new_text: copied EXACTLY, character for character, from the blocks. Give the SHORTEST contiguous phrase that differs (for "30 days" vs "45 days" give "30" and "45"; for a changed word give that word). For an added or deleted passage give the whole passage. Leave the other side empty for added/deleted.
- summary: one short plain sentence saying what changed.
- impact: "low" (wording only), "medium", "high" (money, dates, obligations, parties) or "critical" (an obligation, liability or payment term added/removed/reversed).
One change per distinct edit: if one sentence has two separate edits, report two changes. Never invent a change you cannot see in the text. If the versions are equivalent return an empty list.`;

const VERIFY_PROMPT = `An automatic text diff compared an ORIGINAL and an UPDATED document (both extracted from PDFs or scans) and produced candidate differences. Decide for each candidate whether it is REAL or NOISE.

REAL: different wording, a different or new/removed number, amount, date, name, address, party, defined term, legal obligation word, or a clause/sentence/row that exists in only one version.
NOISE: OCR or transcription differences (misread letters, split/merged words), spacing, punctuation, hyphenation, line wrapping, capitalisation, quote/dash styles, page headers/footers/page numbers, list or clause numbering, formatting, or text that is simply moved/re-wrapped ("in_other" true means the same words also occur in the other version).
Be strict about numbers, dates, amounts and legal words: if they differ, it is REAL. Return one verdict per candidate id, with a short summary for REAL ones.`;

const READ_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { text: { type: 'STRING' }, box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } } },
        required: ['text', 'box_2d'],
      },
    },
  },
  required: ['lines'],
};

const COMPARE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    changes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING' },
          a_blocks: { type: 'ARRAY', items: { type: 'STRING' } },
          b_blocks: { type: 'ARRAY', items: { type: 'STRING' } },
          old_text: { type: 'STRING' },
          new_text: { type: 'STRING' },
          summary: { type: 'STRING' },
          impact: { type: 'STRING' },
        },
        required: ['type', 'a_blocks', 'b_blocks', 'old_text', 'new_text', 'summary', 'impact'],
      },
    },
  },
  required: ['changes'],
};

const VERIFY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { id: { type: 'INTEGER' }, real: { type: 'BOOLEAN' }, summary: { type: 'STRING' } },
        required: ['id', 'real', 'summary'],
      },
    },
  },
  required: ['verdicts'],
};

const send = (res, status, body) => res.status(status).json(body);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

// Pull complete {text, box_2d} objects out of a truncated or slightly malformed JSON reply.
function salvageLines(text) {
  const out = [];
  const re = /\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"box_2d"\s*:\s*\[([^\]]*)\]\s*\}/g;
  const re2 = /\{\s*"box_2d"\s*:\s*\[([^\]]*)\]\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = re.exec(text))) {
    try { out.push({ text: JSON.parse('"' + m[1] + '"'), box_2d: m[2].split(',').map(Number) }); } catch (_) {}
  }
  while ((m = re2.exec(text))) {
    try { out.push({ text: JSON.parse('"' + m[2] + '"'), box_2d: m[1].split(',').map(Number) }); } catch (_) {}
  }
  return out;
}

// Complete top-level objects inside "<key>": [ ... ] of a truncated JSON reply.
function salvageArray(text, key) {
  const out = [];
  const at = text.indexOf('"' + key + '"');
  if (at < 0) return out;
  let i = text.indexOf('[', at);
  if (i < 0) return out;
  i++;
  while (i < text.length) {
    while (i < text.length && text[i] !== '{') i++;
    if (i >= text.length) break;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) break;
    try { out.push(JSON.parse(text.slice(i, j + 1))); } catch (_) {}
    i = j + 1;
  }
  return out;
}

function parseJson(text, key) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j[key])) return j[key];
  } catch (_) {}
  return key === 'lines' ? salvageLines(t) : salvageArray(t, key);
}

function cleanLines(lines) {
  const out = [];
  let repeat = 0;
  for (const l of lines) {
    const text = str(l && l.text, 4000).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text === text && text.length > 12) { if (++repeat >= 2) continue; } else repeat = 0; // model loops
    const b = Array.isArray(l.box_2d) ? l.box_2d.map(Number) : null;
    const ok = b && b.length === 4 && b.every(Number.isFinite);
    out.push({ text, box_2d: ok ? b.map((v) => Math.max(0, Math.min(1000, Math.round(v)))) : null });
  }
  return out;
}

function cleanChanges(list) {
  const types = new Set(['added', 'deleted', 'modified', 'moved']);
  const impacts = new Set(['low', 'medium', 'high', 'critical']);
  const ids = (a, p) => (Array.isArray(a) ? a : []).map((x) => String(x).trim().toUpperCase()).filter((x) => new RegExp('^' + p + '\\d+$').test(x)).slice(0, 80);
  const out = [];
  for (const c of list) {
    const type = String((c && c.type) || '').toLowerCase();
    if (!types.has(type)) continue;
    const impact = String((c && c.impact) || 'low').toLowerCase();
    out.push({
      type,
      a_blocks: ids(c.a_blocks, 'A'),
      b_blocks: ids(c.b_blocks, 'B'),
      old_text: str(c.old_text, 6000),
      new_text: str(c.new_text, 6000),
      summary: str(c.summary, 300),
      impact: impacts.has(impact) ? impact : 'low',
    });
  }
  return out;
}

// If the configured model id does not exist for this key, ask the API which models it has and use the closest flash-lite one.
let RESOLVED = null;
async function listModels(apiKey) {
  const out = [];
  let token = '';
  for (let i = 0; i < 4; i++) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200' + (token ? '&pageToken=' + encodeURIComponent(token) : '');
    const r = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
    if (!r.ok) break;
    const j = await r.json();
    (j.models || []).forEach((m) => out.push(m));
    token = j.nextPageToken || '';
    if (!token) break;
  }
  return out;
}
function pickModel(models, want) {
  const names = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /^models\/gemini/.test(m.name) &&
      !/embedding|image|tts|live|audio|robotics|computer-use|deep-research|thinking-exp/i.test(m.name))
    .map((m) => m.name.replace(/^models\//, ''));
  if (names.includes(want)) return { pick: want, names };
  const ver = (n) => parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const fam = want.replace(/-preview.*$/, '');
  let c = names.filter((n) => n.startsWith(fam));
  if (!c.length) c = names.filter((n) => /flash-lite/.test(n) && !/latest/.test(n));
  if (!c.length) c = names.filter((n) => /flash/.test(n) && !/latest/.test(n));
  c.sort((a, b) => ver(b) - ver(a) || (/preview|exp/.test(a) ? 1 : 0) - (/preview|exp/.test(b) ? 1 : 0) || a.length - b.length);
  return { pick: c[0] || null, names };
}
const activeModel = () => RESOLVED || MODEL;

async function callGemini(apiKey, parts, schema, maxOutputTokens) {
  const generationConfig = { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens };
  if (process.env.GEMINI_TEMPERATURE !== undefined && process.env.GEMINI_TEMPERATURE !== '') {
    generationConfig.temperature = Number(process.env.GEMINI_TEMPERATURE);
  }
  const payload = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig });
  let last = { status: 502, error: 'Gemini request failed.' };
  let resolveTried = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(activeModel()) + ':generateContent';
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: payload,
      });
      const raw = await upstream.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (_) {}
      if (!upstream.ok) {
        const message = (data && data.error && data.error.message) || raw.slice(0, 300) || 'no details';
        last = { status: upstream.status, error: `Gemini API ${upstream.status}: ${message}` };
        if ((upstream.status === 404 || (upstream.status === 400 && /model/i.test(message) && !/api key/i.test(message))) && !resolveTried) {
          resolveTried = true;
          try {
            const { pick, names } = pickModel(await listModels(apiKey), MODEL);
            if (pick && pick !== activeModel()) { RESOLVED = pick; attempt--; continue; }
            if (!pick) last.error += ` (model "${MODEL}" is not available for this key; available: ${names.slice(0, 8).join(', ') || 'none listed'})`;
          } catch (_) {}
        }
        if ([429, 500, 502, 503, 504].includes(upstream.status) && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
        return { error: last };
      }
      const text = ((data && data.candidates) || [])
        .flatMap((c) => (c && c.content && c.content.parts) || [])
        .map((p) => (p && p.text) || '')
        .join('');
      if (!text) {
        const why = data && data.promptFeedback && data.promptFeedback.blockReason;
        return { error: { status: 502, error: why ? `Gemini blocked the request (${why}).` : 'Gemini returned an empty reply.' } };
      }
      return { text };
    } catch (err) {
      last = { status: 502, error: (err && err.message) || 'Could not reach Gemini.' };
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  return { error: last };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) return send(res, 500, { error: 'GEMINI_API_KEY is not configured in Vercel Environment Variables (add it for Production and redeploy).' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
  catch (_) { return send(res, 400, { error: 'Invalid JSON body.' }); }

  const mode = body.mode || 'read';

  if (mode === 'health') {
    const r = await callGemini(apiKey, [{ text: 'Return {"ok": true}.' }], { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] }, 64);
    if (r.error) return send(res, r.error.status, { error: r.error.error });
    return send(res, 200, { ok: true, model: activeModel() });
  }

  if (mode === 'compare') {
    const a = str(body.a, MAX_TEXT + 1), b = str(body.b, MAX_TEXT + 1);
    if (!a.trim() || !b.trim()) return send(res, 400, { error: 'Both documents need text to compare.' });
    if (a.length > MAX_TEXT || b.length > MAX_TEXT) return send(res, 413, { error: 'Documents are too large for one Gemini comparison.' });
    const r = await callGemini(apiKey, [{ text: COMPARE_PROMPT }, { text: 'VERSION A (ORIGINAL)\n' + a }, { text: 'VERSION B (UPDATED)\n' + b }], COMPARE_SCHEMA, 32768);
    if (r.error) return send(res, r.error.status, { error: r.error.error });
    return send(res, 200, { changes: cleanChanges(parseJson(r.text, 'changes')), model: activeModel() });
  }

  if (mode === 'verify') {
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 60).map((it, i) => ({
      id: Number.isInteger(it && it.id) ? it.id : i,
      type: str(it && it.type, 12),
      old: str(it && it.old, 800),
      new: str(it && it.new, 800),
      context_old: str(it && it.ctx_old, 600),
      context_new: str(it && it.ctx_new, 600),
      in_other: !!(it && it.in_other),
    }));
    if (!items.length) return send(res, 200, { verdicts: [] });
    const r = await callGemini(apiKey, [{ text: VERIFY_PROMPT }, { text: 'CANDIDATES\n' + JSON.stringify(items) }], VERIFY_SCHEMA, 8192);
    if (r.error) return send(res, r.error.status, { error: r.error.error });
    const verdicts = parseJson(r.text, 'verdicts')
      .map((v) => ({ id: Number(v && v.id), real: !!(v && v.real), summary: str(v && v.summary, 300) }))
      .filter((v) => Number.isInteger(v.id));
    return send(res, 200, { verdicts, model: activeModel() });
  }

  // default: read one page image
  const image = String(body.image || '');
  const mime = body.mime === 'image/png' ? 'image/png' : 'image/jpeg';
  if (!image) return send(res, 400, { error: 'Missing page image.' });
  if (image.length > MAX_B64) return send(res, 413, { error: 'Page image is too large for one request.' });
  const r = await callGemini(apiKey, [{ inlineData: { mimeType: mime, data: image } }, { text: READ_PROMPT }], READ_SCHEMA, 16384);
  if (r.error) return send(res, r.error.status, { error: r.error.error });
  return send(res, 200, { lines: cleanLines(parseJson(r.text, 'lines')), model: activeModel() });
};

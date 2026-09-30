// POST /api/gemini  { image: <base64 jpeg/png of ONE page>, mime?: 'image/jpeg' }
// Returns          { lines: [{ text, box_2d: [ymin, xmin, ymax, xmax] }], model }
// box_2d is normalised to 0..1000 relative to the image that was sent.
//
// Env vars (Vercel > Project > Settings > Environment Variables):
//   GEMINI_API_KEY      required
//   GEMINI_MODEL        optional, default gemini-3.1-flash-lite
//   GEMINI_TEMPERATURE  optional, leave unset to use the model default

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const MAX_B64 = 4 * 1024 * 1024; // Vercel request bodies are limited to about 4.5 MB

const PROMPT = `You are the text-reading stage of a document comparison tool. Read this single page image and transcribe ALL text on it.

Return one entry per visual line of text, in natural reading order. Table cells that sit on the same row belong to ONE line, in left-to-right order.
For every line give box_2d as [ymin, xmin, ymax, xmax], integers from 0 to 1000, relative to the image, drawn tightly around that line's ink (not around neighbouring lines).

Rules:
- Copy the characters exactly as they appear: same words, numbers, currency symbols, punctuation and capitalisation. Keep list numbers and bullets.
- Never correct spelling, never translate, never summarise, never add words that are not visible, never guess missing words.
- Do not merge or split words. Keep hyphenated words as printed.
- The page may be a phone photo or a tilted scan. Ignore scanner borders, shadows, dust and page edges.
- Include stamps, handwriting, filled-in form values, headers, footers and page numbers.
- Write a blank fill-in line as a run of underscores inside its line. Write a signature as [signature] and unreadable text as [illegible].
- If the page has no text return an empty list.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
        },
        required: ['text', 'box_2d'],
      },
    },
  },
  required: ['lines'],
};

function send(res, status, body) {
  res.status(status).json(body);
}

// Pull complete {text, box_2d} objects out of a truncated or slightly malformed JSON reply.
function salvage(text) {
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

function parseLines(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.lines)) return j.lines;
  } catch (_) {}
  return salvage(t);
}

function clean(lines) {
  const out = [];
  let repeat = 0;
  for (const l of lines) {
    const text = String((l && l.text) || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // models occasionally loop; drop a line repeated more than twice in a row
    const prev = out[out.length - 1];
    if (prev && prev.text === text && text.length > 12) { if (++repeat >= 2) continue; } else repeat = 0;
    const b = Array.isArray(l.box_2d) ? l.box_2d.map(Number) : null;
    const ok = b && b.length === 4 && b.every(Number.isFinite);
    out.push({ text, box_2d: ok ? b.map((v) => Math.max(0, Math.min(1000, Math.round(v)))) : null });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return send(res, 500, { error: 'GEMINI_API_KEY is not configured in Vercel Environment Variables.' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  } catch (_) {
    return send(res, 400, { error: 'Invalid JSON body.' });
  }

  const image = String(body.image || '');
  const mime = body.mime === 'image/png' ? 'image/png' : 'image/jpeg';
  if (!image) return send(res, 400, { error: 'Missing page image.' });
  if (image.length > MAX_B64) return send(res, 413, { error: 'Page image is too large for one request.' });

  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: SCHEMA,
    maxOutputTokens: 16384,
  };
  if (process.env.GEMINI_TEMPERATURE !== undefined && process.env.GEMINI_TEMPERATURE !== '') {
    generationConfig.temperature = Number(process.env.GEMINI_TEMPERATURE);
  }

  const endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(MODEL) + ':generateContent';
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: image } }, { text: PROMPT }] }],
    generationConfig,
  });

  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
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
        if ([429, 500, 502, 503, 504].includes(upstream.status) && attempt < 2) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        return send(res, upstream.status, { error: last.error });
      }

      const text = ((data && data.candidates) || [])
        .flatMap((c) => (c && c.content && c.content.parts) || [])
        .map((p) => (p && p.text) || '')
        .join('');
      if (!text) {
        const why = data && data.promptFeedback && data.promptFeedback.blockReason;
        return send(res, 502, { error: why ? `Gemini blocked the page (${why}).` : 'Gemini returned an empty reply.' });
      }
      return send(res, 200, { lines: clean(parseLines(text)), model: MODEL });
    } catch (err) {
      last = { status: 502, error: (err && err.message) || 'Could not reach Gemini.' };
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  return send(res, last ? last.status : 502, { error: last ? last.error : 'Gemini request failed.' });
};

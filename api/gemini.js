const { get, del } = require('@vercel/blob');

const MODEL_DEFAULT = 'gemini-3.5-flash-lite';
const MAX_PDF_BYTES = 50 * 1024 * 1024;

function send(res, status, body) {
  res.status(status).json(body);
}

// Helper to handle eventual consistency when reading blobs immediately after upload
async function getBlobWithRetry(path, retries = 5, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const blob = await get(path, { access: 'private', useCache: false });
      if (blob) return blob;
    } catch (err) {
      if (i === retries - 1) throw err;
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error(`Blob not found after retries: ${path}`);
}

async function uploadToGemini(buffer, displayName, apiKey) {
  const start = await fetch(
    'https://generativelanguage.googleapis.com/upload/v1beta/files',
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buffer.length),
        'X-Goog-Upload-Header-Content-Type': 'application/pdf',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        file: {
          display_name: displayName
        }
      })
    }
  );

  if (!start.ok) {
    const raw = await start.text();
    throw new Error(
      `Gemini file-upload start ${start.status}: ${raw}`
    );
  }

  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error(
      'Gemini did not return an upload URL.'
    );
  }

  const finish = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(buffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Type': 'application/pdf'
    },
    body: buffer
  });

  const raw = await finish.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (_) {}

  if (!finish.ok) {
    throw new Error(
      `Gemini file upload ${finish.status}: ${data?.error?.message || raw}`
    );
  }

  if (!data?.file?.uri) {
    throw new Error(
      'Gemini file upload completed without a file URI.'
    );
  }

  return data.file.uri;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return send(res, 500, {
      error: 'GEMINI_API_KEY is not configured in Vercel Environment Variables.'
    });
  }

  let oldPath = null;
  let newPath = null;

  try {
    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {});

    const {
      prompt,
      oldPath: oldBlobPath,
      newPath: newBlobPath,
      model
    } = body;

    oldPath = String(oldBlobPath || '');
    newPath = String(newBlobPath || '');

    if (!prompt || !oldPath || !newPath) {
      return send(res, 400, {
        error: 'Missing prompt or temporary PDF paths.'
      });
    }

    if (
      !oldPath.startsWith('doc-compare/') ||
      !newPath.startsWith('doc-compare/')
    ) {
      return send(res, 400, {
        error: 'Invalid temporary PDF path.'
      });
    }

    // 1. Fetch metadata with retry logic for eventual consistency
    const [oldBlob, newBlob] = await Promise.all([
      getBlobWithRetry(oldPath),
      getBlobWithRetry(newPath)
    ]);

    if (!oldBlob || !newBlob || !oldBlob.url || !newBlob.url) {
      throw new Error(
        'Temporary PDF could not be read from Vercel Blob.'
      );
    }

    // 2. Download the actual file content using the URLs provided by the metadata
    const [oldRes, newRes] = await Promise.all([
      fetch(oldBlob.url),
      fetch(newBlob.url)
    ]);

    if (!oldRes.ok || !newRes.ok) {
      throw new Error(
        'Failed to download PDFs from Vercel Blob.'
      );
    }

    const [oldBuffer, newBuffer] = await Promise.all([
      oldRes.arrayBuffer().then(ab => Buffer.from(ab)),
      newRes.arrayBuffer().then(ab => Buffer.from(ab))
    ]);

    if (
      oldBuffer.length > MAX_PDF_BYTES ||
      newBuffer.length > MAX_PDF_BYTES
    ) {
      throw new Error(
        'Gemini supports PDFs up to 50 MB through the file-upload path.'
      );
    }

    const [oldUri, newUri] = await Promise.all([
      uploadToGemini(oldBuffer, 'original.pdf', apiKey),
      uploadToGemini(newBuffer, 'updated.pdf', apiKey)
    ]);

    const selectedModel = String(model || MODEL_DEFAULT);
    const endpoint =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(selectedModel) +
      ':generateContent';

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                fileData: {
                  mimeType: 'application/pdf',
                  fileUri: oldUri
                }
              },
              {
                fileData: {
                  mimeType: 'application/pdf',
                  fileUri: newUri
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json'
        }
      })
    });

    const raw = await upstream.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      data = null;
    }

    if (!upstream.ok) {
      const message =
        data?.error?.message || raw || `Gemini API returned ${upstream.status}`;
      return send(res, upstream.status, {
        error: `Gemini API ${upstream.status}: ${message}`
      });
    }

    const text = (data?.candidates || [])
      .flatMap(c => c?.content?.parts || [])
      .map(p => p?.text || '')
      .join('');

    return send(res, 200, { text });
  } catch (err) {
    console.error('Gemini proxy error:', err);
    return send(res, 500, {
      error: err?.message || 'Gemini proxy failed.'
    });
  } finally {
    if (oldPath || newPath) {
      try {
        await del([oldPath, newPath].filter(Boolean));
      } catch (cleanupError) {
        console.error('Blob cleanup error:', cleanupError);
      }
    }
  }
};

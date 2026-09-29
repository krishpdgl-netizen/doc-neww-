const { issueSignedToken, presignUrl } = require('@vercel/blob');
const { randomUUID } = require('crypto');

function send(res, status, body) {
  res.status(status).json(body);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed.' });
  }
  try {
    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {});

    const name = String(body.name || 'document.pdf')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(-100);

    const size = Number(body.size || 0);
    const type = String(body.type || 'application/pdf');

    if (type !== 'application/pdf') {
      return send(res, 400, {
        error: 'Only PDF files can use the Gemini PDF path.'
      });
    }

    if (!Number.isFinite(size) || size <= 0) {
      return send(res, 400, {
        error: 'Invalid PDF size.'
      });
    }

    if (size > 50 * 1024 * 1024) {
      return send(res, 413, {
        error: "PDF is larger than Gemini's 50 MB PDF input limit."
      });
    }

    const pathname = `doc-compare/${Date.now()}-${randomUUID()}-${name}`;

    const token = await issueSignedToken({
      operations: ['put']
    });

    const { presignedUrl } = await presignUrl(token, {
      pathname,
      operation: 'put',
      access: 'private', // <-- CRITICAL FIX: Must match the 'private' read access in gemini.js
      validUntil: Date.now() + 15 * 60 * 1000
    });

    return send(res, 200, {
      uploadUrl: presignedUrl,
      pathname
    });
  } catch (err) {
    console.error('blob-upload-url error:', err);
    return send(res, 500, {
      error:
        err?.message ||
        'Could not create secure Blob upload URL. Make sure a Vercel Blob store is connected to this project.'
    });
  }
};

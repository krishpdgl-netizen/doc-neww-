const { issueSignedToken, presignUrl } = require('@vercel/blob');
const { randomUUID } = require('crypto');

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const TTL_MS = 15 * 60 * 1000;

function send(res, status, body) {
  return res.status(status).json(body);
}

function parseBody(req) {
  if (!req.body) return {};

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }

  return req.body;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, {
      error: 'Method not allowed.'
    });
  }

  try {
    const body = parseBody(req);

    const name =
      String(body.name || 'document.pdf')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(-100) || 'document.pdf';

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

    if (size > MAX_PDF_BYTES) {
      return send(res, 413, {
        error: "PDF is larger than Gemini's 50 MB PDF input limit."
      });
    }

    const pathname =
      `doc-compare/${Date.now()}-${randomUUID()}-${name}`;

    const validUntil = Date.now() + TTL_MS;

    // Scope the delegation to this exact pathname and PUT operation.
    const token = await issueSignedToken({
      pathname,
      operations: ['put'],
      validUntil
    });

    const { presignedUrl } = await presignUrl(token, {
      pathname,
      operation: 'put',
      validUntil
    });

    return send(res, 200, {
      uploadUrl: presignedUrl,
      pathname,
      expiresAt: validUntil
    });

  } catch (err) {
    console.error('blob-upload-url error:', err);

    return send(res, 500, {
      error:
        err?.message ||
        'Could not create secure private Blob upload URL.',

      hint:
        'Make sure the Vercel project is connected to the intended private Blob store and the deployment has Blob OIDC or BLOB_READ_WRITE_TOKEN access.'
    });
  }
};

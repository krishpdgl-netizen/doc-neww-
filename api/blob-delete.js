const { issueSignedToken, presignUrl } = require('@vercel/blob');

const DELETE_URL_TTL_MS = 5 * 60 * 1000;

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

async function deleteOne(pathname) {
  if (
    typeof pathname !== 'string' ||
    !pathname.startsWith('doc-compare/')
  ) {
    return {
      pathname,
      deleted: false,
      skipped: true
    };
  }

  /*
   * Generate a short-lived DELETE URL scoped
   * to this exact object.
   */
  const token = await issueSignedToken({
    pathname,
    operations: ['delete']
  });

  const { presignedUrl } = await presignUrl(token, {
    pathname,
    operation: 'delete',
    validUntil: Date.now() + DELETE_URL_TTL_MS
  });

  const response = await fetch(presignedUrl, {
    method: 'DELETE'
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');

    throw new Error(
      `Blob delete failed for ${pathname}: HTTP ${response.status}` +
      `${text ? ` - ${text}` : ''}`
    );
  }

  return {
    pathname,
    deleted: true
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, {
      error: 'Method not allowed.'
    });
  }

  try {
    const body = parseBody(req);

    const paths = Array.isArray(body.paths)
      ? body.paths
          .filter(Boolean)
          .slice(0, 2)
      : [];

    const results = [];

    for (const pathname of paths) {
      results.push(await deleteOne(pathname));
    }

    return send(res, 200, {
      ok: true,
      results
    });

  } catch (err) {
    console.error('blob-delete error:', err);

    return send(res, 500, {
      error:
        err?.message ||
        'Private Blob cleanup failed.'
    });
  }
};

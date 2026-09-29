const { del } = require('@vercel/blob');

function send(res, status, body) {
  res.status(status).json(body);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, {
      error: 'Method not allowed.'
    });
  }

  try {
    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {});

    const paths = Array.isArray(body.paths)
      ? body.paths.filter(Boolean).slice(0, 2)
      : [];

    if (paths.length) {
      await del(paths);
    }

    return send(res, 200, {
      ok: true
    });
  } catch (err) {
    console.error('blob-delete error:', err);

    return send(res, 500, {
      error: err?.message || 'Blob cleanup failed.'
    });
  }
};

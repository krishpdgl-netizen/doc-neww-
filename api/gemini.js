const { issueSignedToken, presignUrl } = require('@vercel/blob');

const MODEL_DEFAULT = 'gemini-3.5-flash-lite';

const MAX_PDF_BYTES = 50 * 1024 * 1024;

const READ_URL_TTL_MS = 5 * 60 * 1000;

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


/*
 * Read a PRIVATE Vercel Blob through a short-lived
 * signed GET URL.
 *
 * We intentionally do NOT use:
 *
 * get(pathname, { access: 'private' })
 *
 * because that was the point where the previous
 * implementation was failing.
 */
async function readPrivateBlob(pathname) {

  if (
    typeof pathname !== 'string' ||
    !pathname.startsWith('doc-compare/')
  ) {
    throw new Error(
      `Invalid temporary Blob pathname: ${pathname || '(empty)'}`
    );
  }

  /*
   * Token is restricted to:
   * - this exact pathname
   * - GET only
   */
  const token = await issueSignedToken({
    pathname,
    operations: ['get']
  });

  const { presignedUrl } = await presignUrl(token, {
    pathname,
    operation: 'get',
    validUntil: Date.now() + READ_URL_TTL_MS
  });

  /*
   * Fetch the private object directly.
   */
  const response = await fetch(presignedUrl, {
    method: 'GET',
    cache: 'no-store'
  });

  if (!response.ok) {

    const text = await response.text().catch(() => '');

    throw new Error(
      `Private Blob read failed for ${pathname}: HTTP ${response.status}` +
      `${text ? ` - ${text}` : ''}`
    );
  }

  const contentType =
    response.headers.get('content-type') || '';

  const contentLength =
    Number(response.headers.get('content-length') || 0);

  if (
    contentType &&
    !contentType
      .toLowerCase()
      .includes('application/pdf')
  ) {
    console.warn(
      `Blob ${pathname} returned content-type "${contentType}" instead of application/pdf.`
    );
  }

  if (contentLength > MAX_PDF_BYTES) {
    throw new Error(
      `Blob ${pathname} is larger than Gemini's 50 MB PDF input limit.`
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  const buffer = Buffer.from(arrayBuffer);

  if (!buffer.length) {
    throw new Error(
      `Private Blob ${pathname} was empty.`
    );
  }

  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(
      `Blob ${pathname} is larger than Gemini's 50 MB PDF input limit.`
    );
  }

  /*
   * Verify that what we downloaded is actually a PDF.
   *
   * This prevents accidentally sending an HTML error page
   * or another response to Gemini.
   */
  const header =
    buffer
      .subarray(0, 5)
      .toString('ascii');

  if (header !== '%PDF-') {
    throw new Error(
      `Private Blob ${pathname} did not return a valid PDF (received "${header}").`
    );
  }

  return buffer;
}


/*
 * Upload PDF to Gemini Files API.
 */
async function uploadToGemini(
  buffer,
  displayName,
  apiKey
) {

  const start = await fetch(
    'https://generativelanguage.googleapis.com/upload/v1beta/files',
    {
      method: 'POST',

      headers: {
        'x-goog-api-key': apiKey,

        'X-Goog-Upload-Protocol':
          'resumable',

        'X-Goog-Upload-Command':
          'start',

        'X-Goog-Upload-Header-Content-Length':
          String(buffer.length),

        'X-Goog-Upload-Header-Content-Type':
          'application/pdf',

        'Content-Type':
          'application/json'
      },

      body: JSON.stringify({
        file: {
          display_name: displayName
        }
      })
    }
  );

  if (!start.ok) {

    const raw =
      await start.text();

    throw new Error(
      `Gemini file-upload start ${start.status}: ${raw}`
    );
  }

  const uploadUrl =
    start.headers.get(
      'x-goog-upload-url'
    );

  if (!uploadUrl) {
    throw new Error(
      'Gemini did not return an upload URL.'
    );
  }

  const finish = await fetch(
    uploadUrl,
    {
      method: 'POST',

      headers: {
        'Content-Length':
          String(buffer.length),

        'X-Goog-Upload-Offset':
          '0',

        'X-Goog-Upload-Command':
          'upload, finalize',

        'Content-Type':
          'application/pdf'
      },

      body: buffer
    }
  );

  const raw =
    await finish.text();

  let data = null;

  try {
    data = JSON.parse(raw);
  } catch (_) {}

  if (!finish.ok) {

    throw new Error(
      `Gemini file upload ${finish.status}: ` +
      `${
        data?.error?.message ||
        raw ||
        'unknown error'
      }`
    );
  }

  if (!data?.file?.uri) {

    throw new Error(
      'Gemini file upload completed without a file URI.'
    );
  }

  return data.file.uri;
}


/*
 * Delete temporary private Blob object.
 */
async function cleanupWithSignedDelete(pathname) {

  if (
    typeof pathname !== 'string' ||
    !pathname.startsWith('doc-compare/')
  ) {
    return;
  }

  try {

    const token =
      await issueSignedToken({
        pathname,
        operations: ['delete']
      });

    const { presignedUrl } =
      await presignUrl(token, {
        pathname,
        operation: 'delete',
        validUntil:
          Date.now() + 60 * 1000
      });

    const response =
      await fetch(
        presignedUrl,
        {
          method: 'DELETE'
        }
      );

    if (
      !response.ok &&
      response.status !== 404
    ) {

      const text =
        await response
          .text()
          .catch(() => '');

      console.warn(
        `Blob cleanup failed for ${pathname}: HTTP ${response.status} ${text}`
      );
    }

  } catch (err) {

    /*
     * Cleanup failure must never replace
     * the actual Gemini comparison result.
     */
    console.warn(
      `Blob cleanup exception for ${pathname}:`,
      err?.message || err
    );
  }
}


module.exports = async function handler(
  req,
  res
) {

  if (req.method !== 'POST') {

    return send(res, 405, {
      error: 'Method not allowed.'
    });
  }

  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {

    return send(res, 500, {
      error:
        'GEMINI_API_KEY is not configured in Vercel Environment Variables.'
    });
  }

  let oldPath = null;
  let newPath = null;

  try {

    const body =
      parseBody(req);

    const prompt =
      String(body.prompt || '');

    oldPath =
      String(body.oldPath || '');

    newPath =
      String(body.newPath || '');

    const model =
      String(
        body.model ||
        MODEL_DEFAULT
      );

    if (
      !prompt ||
      !oldPath ||
      !newPath
    ) {

      return send(res, 400, {
        error:
          'Missing prompt or temporary PDF paths.'
      });
    }

    for (
      const pathname of [
        oldPath,
        newPath
      ]
    ) {

      if (
        !pathname.startsWith(
          'doc-compare/'
        )
      ) {

        return send(res, 400, {
          error:
            'Invalid temporary PDF path.'
        });
      }
    }

    console.log(
      'Gemini PDF comparison: reading private Blob objects',
      {
        oldPath,
        newPath,
        model
      }
    );


    /*
     * Read the EXACT objects that the
     * upload endpoint created.
     */
    const [
      oldBuffer,
      newBuffer
    ] = await Promise.all([
      readPrivateBlob(oldPath),
      readPrivateBlob(newPath)
    ]);


    console.log(
      'Private Blob reads successful',
      {
        oldBytes:
          oldBuffer.length,

        newBytes:
          newBuffer.length
      }
    );


    /*
     * Upload both PDFs to Gemini.
     */
    const [
      oldUri,
      newUri
    ] = await Promise.all([
      uploadToGemini(
        oldBuffer,
        'original.pdf',
        apiKey
      ),

      uploadToGemini(
        newBuffer,
        'updated.pdf',
        apiKey
      )
    ]);


    /*
     * Ask Gemini to compare the two PDFs.
     */
    const endpoint =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      `${encodeURIComponent(model)}:generateContent`;


    const upstream =
      await fetch(
        endpoint,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',

            'x-goog-api-key':
              apiKey
          },

          body: JSON.stringify({

            contents: [

              {
                parts: [

                  {
                    text: prompt
                  },

                  {
                    fileData: {
                      mimeType:
                        'application/pdf',

                      fileUri:
                        oldUri
                    }
                  },

                  {
                    fileData: {
                      mimeType:
                        'application/pdf',

                      fileUri:
                        newUri
                    }
                  }

                ]
              }

            ],

            generationConfig: {

              temperature: 0,

              responseMimeType:
                'application/json'

            }

          })
        }
      );


    const raw =
      await upstream.text();

    let data;

    try {
      data =
        JSON.parse(raw);
    } catch (_) {
      data = null;
    }


    if (!upstream.ok) {

      const message =
        data?.error?.message ||
        raw ||
        `Gemini API returned ${upstream.status}`;

      return send(
        res,
        upstream.status,
        {
          error:
            `Gemini API ${upstream.status}: ${message}`
        }
      );
    }


    const text =
      (data?.candidates || [])

        .flatMap(
          candidate =>
            candidate
              ?.content
              ?.parts || []
        )

        .map(
          part =>
            part?.text || ''
        )

        .join('');


    return send(res, 200, {
      text
    });


  } catch (err) {

    console.error(
      'Gemini private-Blob comparison error:',
      err
    );

    return send(res, 500, {

      error:
        err?.message ||
        'Gemini proxy failed.',

      stage:
        'private-blob-or-gemini-processing'

    });

  } finally {

    /*
     * Server-side cleanup is authoritative.
     *
     * Even if Gemini fails, the temporary PDFs
     * are removed from the private Blob store.
     */
    await Promise.allSettled([

      oldPath
        ? cleanupWithSignedDelete(
            oldPath
          )
        : Promise.resolve(),

      newPath
        ? cleanupWithSignedDelete(
            newPath
          )
        : Promise.resolve()

    ]);

  }
};

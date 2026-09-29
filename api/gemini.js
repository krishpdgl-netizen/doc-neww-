const {
  issueSignedToken,
  presignUrl
} = require('@vercel/blob');

const MODEL_DEFAULT =
  process.env.GEMINI_MODEL ||
  'gemini-3.1-flash-lite';

const MAX_PDF_BYTES =
  50 * 1024 * 1024;

const READ_TTL_MS =
  5 * 60 * 1000;

const DELETE_TTL_MS =
  60 * 1000;

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
 * Read the exact private Blob object through
 * a short-lived signed GET URL.
 *
 * This avoids relying on SDK get() path
 * resolution/access-mode behaviour.
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

  const validUntil =
    Date.now() + READ_TTL_MS;

  const token =
    await issueSignedToken({
      pathname,
      operations: ['get'],
      validUntil
    });

  const { presignedUrl } =
    await presignUrl(token, {
      pathname,
      operation: 'get',
      validUntil,
      useCache: false
    });

  const response =
    await fetch(
      presignedUrl,
      {
        method: 'GET',
        cache: 'no-store'
      }
    );

  if (!response.ok) {

    const text =
      await response
        .text()
        .catch(() => '');

    throw new Error(
      `Private Blob read failed for ${pathname}: HTTP ${response.status}` +
      `${text ? ` - ${text}` : ''}`
    );
  }

  const contentLength =
    Number(
      response
        .headers
        .get('content-length') || 0
    );

  if (
    contentLength >
    MAX_PDF_BYTES
  ) {
    throw new Error(
      `Blob ${pathname} is larger than Gemini's 50 MB PDF input limit.`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (!buffer.length) {
    throw new Error(
      `Private Blob ${pathname} was empty.`
    );
  }

  if (
    buffer.length >
    MAX_PDF_BYTES
  ) {
    throw new Error(
      `Blob ${pathname} is larger than Gemini's 50 MB PDF input limit.`
    );
  }

  /*
   * Make sure the response is actually
   * a PDF and not an HTML/error response.
   */
  if (
    buffer
      .subarray(0, 5)
      .toString('ascii') !== '%PDF-'
  ) {
    throw new Error(
      `Private Blob ${pathname} did not return a valid PDF.`
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

  const start =
    await fetch(
      'https://generativelanguage.googleapis.com/upload/v1beta/files',
      {
        method: 'POST',

        headers: {
          'x-goog-api-key':
            apiKey,

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
            display_name:
              displayName
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

  const finish =
    await fetch(
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
    data =
      JSON.parse(raw);
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
 * Clean up the temporary private Blob.
 */
async function cleanupBlob(pathname) {

  if (
    typeof pathname !== 'string' ||
    !pathname.startsWith('doc-compare/')
  ) {
    return;
  }

  try {

    const validUntil =
      Date.now() +
      DELETE_TTL_MS;

    const token =
      await issueSignedToken({
        pathname,
        operations: ['delete'],
        validUntil
      });

    const { presignedUrl } =
      await presignUrl(token, {
        pathname,
        operation: 'delete',
        validUntil
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

      console.warn(
        `Blob cleanup failed for ${pathname}: HTTP ${response.status}`
      );
    }

  } catch (err) {

    console.warn(
      `Blob cleanup exception for ${pathname}:`,
      err?.message || err
    );
  }
}


module.exports =
  async function handler(req, res) {

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
        String(
          body.prompt || ''
        );

      oldPath =
        String(
          body.oldPath || ''
        );

      newPath =
        String(
          body.newPath || ''
        );

      const selectedModel =
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
          model: selectedModel
        }
      );


      /*
       * Read the exact objects that
       * the upload endpoint created.
       */
      const [
        oldBuffer,
        newBuffer
      ] =
        await Promise.all([
          readPrivateBlob(
            oldPath
          ),

          readPrivateBlob(
            newPath
          )
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
      ] =
        await Promise.all([

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
       * Gemini comparison request.
       */
      const endpoint =
        'https://generativelanguage.googleapis.com/v1beta/models/' +
        `${encodeURIComponent(selectedModel)}:generateContent`;


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
                      text:
                        prompt
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

      let data = null;

      try {
        data =
          JSON.parse(raw);
      } catch (_) {}


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
            c =>
              c?.content?.parts || []
          )

          .map(
            p =>
              p?.text || ''
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

      await Promise.allSettled([

        oldPath
          ? cleanupBlob(oldPath)
          : Promise.resolve(),

        newPath
          ? cleanupBlob(newPath)
          : Promise.resolve()

      ]);

    }
  };

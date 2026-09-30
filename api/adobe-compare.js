const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const AdmZip = require('adm-zip');
const PDFServicesSdk = require('@adobe/pdfservices-node-sdk');

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const POLL_TIMEOUT_MS = 240000;

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

/* -----------------------------------------------------------
   PRIVATE VERCEL BLOB
----------------------------------------------------------- */

async function readPrivateBlob(pathname) {
  const {
    issueSignedToken,
    presignUrl
  } = require('@vercel/blob');

  if (
    typeof pathname !== 'string' ||
    !pathname.startsWith('doc-compare/')
  ) {
    throw new Error('Invalid temporary Blob pathname.');
  }

  const validUntil = Date.now() + 5 * 60 * 1000;

  const token = await issueSignedToken({
    pathname,
    operations: ['get'],
    validUntil
  });

  const { presignedUrl } = await presignUrl(
    token,
    {
      pathname,
      operation: 'get',
      validUntil
    }
  );

  const response = await fetch(
    presignedUrl,
    {
      method: 'GET',
      cache: 'no-store'
    }
  );

  if (!response.ok) {
    throw new Error(
      `Private Blob read failed: HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (!buffer.length) {
    throw new Error('Temporary PDF was empty.');
  }

  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(
      'PDF exceeds Adobe Extract 100 MB limit.'
    );
  }

  if (
    buffer.subarray(0, 5).toString('ascii') !== '%PDF-'
  ) {
    throw new Error(
      'Temporary Blob is not a valid PDF.'
    );
  }

  return buffer;
}

async function deletePrivateBlob(pathname) {
  try {
    const {
      issueSignedToken,
      presignUrl
    } = require('@vercel/blob');

    if (
      typeof pathname !== 'string' ||
      !pathname.startsWith('doc-compare/')
    ) {
      return;
    }

    const validUntil =
      Date.now() + 60 * 1000;

    const token = await issueSignedToken({
      pathname,
      operations: ['delete'],
      validUntil
    });

    const { presignedUrl } =
      await presignUrl(
        token,
        {
          pathname,
          operation: 'delete',
          validUntil
        }
      );

    await fetch(
      presignedUrl,
      {
        method: 'DELETE'
      }
    );
  } catch (e) {
    console.warn(
      'Temporary Blob cleanup failed:',
      e?.message || e
    );
  }
}

/* -----------------------------------------------------------
   ADOBE PDF EXTRACT
----------------------------------------------------------- */

async function extractPdf(buffer, label) {
  const tmp = path.join(
    os.tmpdir(),
    `diffiq-${randomUUID()}.pdf`
  );

  const out = path.join(
    os.tmpdir(),
    `diffiq-${randomUUID()}.zip`
  );

  let readStream;

  try {
    fs.writeFileSync(tmp, buffer);

    const credentials =
      new PDFServicesSdk.ServicePrincipalCredentials({
        clientId:
          process.env.PDF_SERVICES_CLIENT_ID,

        clientSecret:
          process.env.PDF_SERVICES_CLIENT_SECRET
      });

    const pdfServices =
      new PDFServicesSdk.PDFServices({
        credentials
      });

    readStream =
      fs.createReadStream(tmp);

    const inputAsset =
      await pdfServices.upload({
        readStream,
        mimeType:
          PDFServicesSdk.MimeType.PDF
      });

    /*
      IMPORTANT:

      addCharInfo:true makes Adobe return
      character-level bounding boxes.

      This is what allows us to highlight
      the actual changed text instead of
      asking an AI to guess coordinates.
    */

    const params =
      new PDFServicesSdk.ExtractPDFParams({
        elementsToExtract: [
          PDFServicesSdk.ExtractElementType.TEXT
        ],

        addCharInfo: true
      });

    const job =
      new PDFServicesSdk.ExtractPDFJob({
        inputAsset,
        params
      });

    const pollingURL =
      await pdfServices.submit({
        job
      });

    const response =
      await pdfServices.getJobResult({
        pollingURL,
        resultType:
          PDFServicesSdk.ExtractPDFResult
      });

    const resultAsset =
      response.result.resource;

    const streamAsset =
      await pdfServices.getContent({
        asset: resultAsset
      });

    const writeStream =
      fs.createWriteStream(out);

    await new Promise(
      (resolve, reject) => {
        streamAsset.readStream.pipe(
          writeStream
        );

        streamAsset.readStream.on(
          'error',
          reject
        );

        writeStream.on(
          'finish',
          resolve
        );

        writeStream.on(
          'error',
          reject
        );
      }
    );

    const zip =
      new AdmZip(out);

    const jsonText =
      zip.readAsText(
        'structuredData.json'
      );

    if (!jsonText) {
      throw new Error(
        `Adobe returned no structuredData.json for ${label}.`
      );
    }

    return JSON.parse(jsonText);

  } catch (err) {

    throw new Error(
      `Adobe extraction failed for ${label}: ${
        err?.message || err
      }`
    );

  } finally {

    readStream?.destroy();

    try {
      fs.unlinkSync(tmp);
    } catch (_) {}

    try {
      fs.unlinkSync(out);
    } catch (_) {}
  }
}

/* -----------------------------------------------------------
   NORMALIZATION
----------------------------------------------------------- */

function norm(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokens(s) {
  return norm(s)
    .split(/\s+/)
    .filter(Boolean);
}

function similarity(a, b) {

  const A = new Set(tokens(a));
  const B = new Set(tokens(b));

  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;

  let inter = 0;

  for (const x of A) {
    if (B.has(x)) inter++;
  }

  const dice =
    (2 * inter) /
    (A.size + B.size);

  const lr =
    Math.min(A.size, B.size) /
    Math.max(A.size, B.size);

  return (
    0.8 * dice +
    0.2 * lr
  );
}

/* -----------------------------------------------------------
   BUILD PAGE MODEL
----------------------------------------------------------- */

function makePageModel(data) {

  const pages =
    (data.pages || []).map(p => ({
      page:
        Number(p.page_number || 0),

      width:
        Number(p.width || 1),

      height:
        Number(p.height || 1),

      rotation:
        Number(p.rotation || 0),

      isScanned:
        !!p.is_scanned,

      chars: [],

      text: ''
    }));

  const elements =
    Array.isArray(data.elements)
      ? data.elements
      : [];

  for (const el of elements) {

    if (
      typeof el.Text !== 'string' ||
      !el.Text.length
    ) {
      continue;
    }

    const p =
      Number(el.Page || 0);

    if (!pages[p]) continue;

    const page =
      pages[p];

    const chars =
      Array.from(el.Text);

    const bounds =
      Array.isArray(el.CharBounds)
        ? el.CharBounds
        : [];

    for (
      let i = 0;
      i < chars.length;
      i++
    ) {

      page.text += chars[i];

      page.chars.push({
        ch: chars[i],

        bound:
          Array.isArray(bounds[i])
            ? bounds[i]
            : null,

        element: el
      });
    }

    /*
      Keep element boundaries without
      creating highlightable characters.
    */

    page.text += '\n';

    page.chars.push({
      ch: '\n',
      bound: null,
      element: null
    });
  }

  return pages;
}

/* -----------------------------------------------------------
   PAGE ALIGNMENT
----------------------------------------------------------- */

function alignPages(
  oldPages,
  newPages
) {

  const n = oldPages.length;
  const m = newPages.length;

  const dp =
    Array.from(
      { length: n + 1 },
      () =>
        Array(m + 1).fill(0)
    );

  const move =
    Array.from(
      { length: n + 1 },
      () =>
        Array(m + 1).fill(null)
    );

  const gap = -0.38;

  for (
    let i = 1;
    i <= n;
    i++
  ) {

    dp[i][0] =
      i * gap;

    move[i][0] =
      'old';
  }

  for (
    let j = 1;
    j <= m;
    j++
  ) {

    dp[0][j] =
      j * gap;

    move[0][j] =
      'new';
  }

  for (
    let i = 1;
    i <= n;
    i++
  ) {

    for (
      let j = 1;
      j <= m;
      j++
    ) {

      const s =
        similarity(
          oldPages[i - 1].text,
          newPages[j - 1].text
        );

      const diag =
        dp[i - 1][j - 1] +
        (
          s >= 0.18
            ? s
            : -0.12
        );

      const up =
        dp[i - 1][j] +
        gap;

      const left =
        dp[i][j - 1] +
        gap;

      if (
        diag >= up &&
        diag >= left
      ) {

        dp[i][j] =
          diag;

        move[i][j] =
          'match';

      } else if (
        up >= left
      ) {

        dp[i][j] =
          up;

        move[i][j] =
          'old';

      } else {

        dp[i][j] =
          left;

        move[i][j] =
          'new';
      }
    }
  }

  const pairs = [];

  let i = n;
  let j = m;

  while (i || j) {

    const mv =
      move[i][j];

    if (mv === 'match') {

      pairs.push({
        old: i - 1,
        new: j - 1
      });

    } else if (mv === 'old') {

      pairs.push({
        old: i - 1,
        new: null
      });

    } else {

      pairs.push({
        old: null,
        new: j - 1
      });
    }

    if (
      mv === 'match' ||
      mv === 'old'
    ) {
      i--;
    }

    if (
      mv === 'match' ||
      mv === 'new'
    ) {
      j--;
    }
  }

  return pairs.reverse();
}

/* -----------------------------------------------------------
   WORD DIFF
----------------------------------------------------------- */

function diffWords(
  oldText,
  newText
) {

  const split =
    s =>
      String(s || '')
        .match(/\s+|[^\s]+/g) || [];

  const A =
    split(oldText);

  const B =
    split(newText);

  const key =
    x => x.toLowerCase();

  const n = A.length;
  const m = B.length;

  /*
    Avoid enormous LCS matrices.
  */

  if (
    n * m >
    1200000
  ) {

    return [{
      removed: oldText,
      added: newText,

      oldStart: 0,
      oldEnd:
        oldText.length,

      newStart: 0,
      newEnd:
        newText.length
    }];
  }

  const dp =
    Array.from(
      {
        length:
          n + 1
      },
      () =>
        new Uint32Array(
          m + 1
        )
    );

  for (
    let i = n - 1;
    i >= 0;
    i--
  ) {

    for (
      let j = m - 1;
      j >= 0;
      j--
    ) {

      dp[i][j] =
        key(A[i]) ===
        key(B[j])

          ? dp[i + 1][j + 1] + 1

          : Math.max(
              dp[i + 1][j],
              dp[i][j + 1]
            );
    }
  }

  const out = [];

  let i = 0;
  let j = 0;

  let oldPos = 0;
  let newPos = 0;

  let rem = '';
  let add = '';

  let remStart = 0;
  let addStart = 0;

  let hasChange = false;

  const flush = () => {

    if (!hasChange) {
      return;
    }

    out.push({

      removed: rem,
      added: add,

      oldStart: remStart,
      oldEnd: oldPos,

      newStart: addStart,
      newEnd: newPos
    });

    rem = '';
    add = '';

    hasChange = false;
  };

  while (
    i < n &&
    j < m
  ) {

    if (
      key(A[i]) ===
      key(B[j])
    ) {

      flush();

      oldPos +=
        A[i].length;

      newPos +=
        B[j].length;

      i++;
      j++;

      continue;
    }

    if (!hasChange) {

      remStart =
        oldPos;

      addStart =
        newPos;

      hasChange =
        true;
    }

    if (
      dp[i + 1][j] >=
      dp[i][j + 1]
    ) {

      rem += A[i];

      oldPos +=
        A[i].length;

      i++;

    } else {

      add += B[j];

      newPos +=
        B[j].length;

      j++;
    }
  }

  if (
    i < n ||
    j < m
  ) {

    if (!hasChange) {

      remStart =
        oldPos;

      addStart =
        newPos;

      hasChange =
        true;
    }

    while (i < n) {

      rem += A[i];

      oldPos +=
        A[i].length;

      i++;
    }

    while (j < m) {

      add += B[j];

      newPos +=
        B[j].length;

      j++;
    }
  }

  flush();

  return out;
}

/* -----------------------------------------------------------
   PDF CHARACTER → UI BOXES
----------------------------------------------------------- */

function boxesForRange(
  page,
  start,
  end
) {

  const entries =
    page.chars
      .slice(
        Math.max(0, start),
        Math.min(
          page.chars.length,
          end
        )
      )
      .filter(
        x =>
          Array.isArray(x.bound) &&
          x.bound.length === 4
      );

  if (!entries.length) {
    return [];
  }

  const lines = [];

  for (const e of entries) {

    const [
      l,
      b,
      r,
      t
    ] =
      e.bound.map(Number);

    if (
      ![
        l,
        b,
        r,
        t
      ].every(Number.isFinite)
    ) {
      continue;
    }

    const mid =
      (b + t) / 2;

    let line =
      lines.find(
        x =>
          Math.abs(
            x.mid - mid
          ) <=
          Math.max(
            2,
            (t - b) * 0.45
          )
      );

    if (!line) {

      line = {
        mid,
        boxes: []
      };

      lines.push(line);
    }

    line.boxes.push([
      l,
      b,
      r,
      t
    ]);
  }

  const pageH =
    Math.max(
      1,
      page.height
    );

  const pageW =
    Math.max(
      1,
      page.width
    );

  return lines
    .map(line => {

      const l =
        Math.min(
          ...line.boxes.map(
            b => b[0]
          )
        );

      const bot =
        Math.min(
          ...line.boxes.map(
            b => b[1]
          )
        );

      const r =
        Math.max(
          ...line.boxes.map(
            b => b[2]
          )
        );

      const top =
        Math.max(
          ...line.boxes.map(
            b => b[3]
          )
        );

      /*
        Adobe PDF coordinates:

        origin = bottom-left

        Existing DiffIQ viewer:

        origin = top-left

        Convert here.
      */

      return [
        l / pageW,

        (pageH - top) /
          pageH,

        r / pageW,

        (pageH - bot) /
          pageH
      ];
    })
    .filter(
      b =>
        b[2] > b[0] &&
        b[3] > b[1]
    );
}

function fullPageBox(page) {
  return [
    [0, 0, 1, 1]
  ];
}

/* -----------------------------------------------------------
   COMPARE MATCHED PAGES
----------------------------------------------------------- */

function comparePages(
  oldPage,
  newPage
) {

  const diffs =
    diffWords(
      oldPage.text,
      newPage.text
    );

  const changes = [];

  for (const d of diffs) {

    const removed =
      d.removed || '';

    const added =
      d.added || '';

    if (
      !removed &&
      !added
    ) {
      continue;
    }

    const oldStart =
      Number(
        d.oldStart || 0
      );

    const oldEnd =
      Number(
        d.oldEnd ||
        oldStart
      );

    const newStart =
      Number(
        d.newStart || 0
      );

    const newEnd =
      Number(
        d.newEnd ||
        newStart
      );

    const oldBoxes =
      removed
        ? boxesForRange(
            oldPage,
            oldStart,
            oldEnd
          )
        : [];

    const newBoxes =
      added
        ? boxesForRange(
            newPage,
            newStart,
            newEnd
          )
        : [];

    if (
      !removed ||
      !added
    ) {

      const type =
        removed
          ? 'deleted'
          : 'added';

      if (
        (
          removed.trim() ||
          added.trim()
        ) &&
        (
          oldBoxes.length ||
          newBoxes.length
        )
      ) {

        changes.push({

          type,

          oldText:
            removed.trim(),

          newText:
            added.trim(),

          oldPage:
            oldPage.page + 1,

          newPage:
            newPage.page + 1,

          oldBoxes,
          newBoxes
        });
      }

    } else {

      if (
        (
          removed.trim() ||
          added.trim()
        ) &&
        (
          oldBoxes.length ||
          newBoxes.length
        )
      ) {

        changes.push({

          type:
            'modified',

          oldText:
            removed.trim(),

          newText:
            added.trim(),

          oldPage:
            oldPage.page + 1,

          newPage:
            newPage.page + 1,

          oldBoxes,
          newBoxes
        });
      }
    }
  }

  return changes;
}

/* -----------------------------------------------------------
   COMPLETE DOCUMENT COMPARISON
----------------------------------------------------------- */

function compareDocuments(
  oldData,
  newData
) {

  const oldPages =
    makePageModel(
      oldData
    );

  const newPages =
    makePageModel(
      newData
    );

  const pairs =
    alignPages(
      oldPages,
      newPages
    );

  const changes = [];

  for (const pair of pairs) {

    if (
      pair.old != null &&
      pair.new != null
    ) {

      const a =
        comparePages(
          oldPages[pair.old],
          newPages[pair.new]
        );

      changes.push(...a);

    } else if (
      pair.old != null
    ) {

      const p =
        oldPages[pair.old];

      if (
        norm(p.text)
      ) {

        changes.push({

          type:
            'deleted',

          oldText:
            p.text.trim(),

          newText:
            '',

          oldPage:
            p.page + 1,

          newPage:
            p.page + 1,

          oldBoxes:
            fullPageBox(p),

          newBoxes: []
        });
      }

    } else if (
      pair.new != null
    ) {

      const p =
        newPages[pair.new];

      if (
        norm(p.text)
      ) {

        changes.push({

          type:
            'added',

          oldText:
            '',

          newText:
            p.text.trim(),

          oldPage:
            p.page + 1,

          newPage:
            p.page + 1,

          oldBoxes: [],

          newBoxes:
            fullPageBox(p)
        });
      }
    }
  }

  return {
    changes,
    oldPages,
    newPages
  };
}

/* -----------------------------------------------------------
   API HANDLER
----------------------------------------------------------- */

module.exports =
  async function handler(
    req,
    res
  ) {

    if (
      req.method !== 'POST'
    ) {

      return send(
        res,
        405,
        {
          error:
            'Method not allowed.'
        }
      );
    }

    if (
      !process.env.PDF_SERVICES_CLIENT_ID ||
      !process.env.PDF_SERVICES_CLIENT_SECRET
    ) {

      return send(
        res,
        500,
        {
          error:
            'Adobe credentials are not configured. Add PDF_SERVICES_CLIENT_ID and PDF_SERVICES_CLIENT_SECRET in Vercel.'
        }
      );
    }

    let oldPath = null;
    let newPath = null;

    try {

      const body =
        parseBody(req);

      oldPath =
        String(
          body.oldPath || ''
        );

      newPath =
        String(
          body.newPath || ''
        );

      if (
        !oldPath ||
        !newPath
      ) {

        return send(
          res,
          400,
          {
            error:
              'Missing temporary PDF paths.'
          }
        );
      }

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

      const [
        oldData,
        newData
      ] =
        await Promise.all([

          extractPdf(
            oldBuffer,
            'original PDF'
          ),

          extractPdf(
            newBuffer,
            'updated PDF'
          )

        ]);

      const result =
        compareDocuments(
          oldData,
          newData
        );

      return send(
        res,
        200,
        {
          changes:
            result.changes,

          engine:
            'adobe-extract-deterministic',

          stats: {
            oldPages:
              result.oldPages.length,

            newPages:
              result.newPages.length,

            changes:
              result.changes.length
          }
        }
      );

    } catch (err) {

      console.error(
        'Adobe PDF comparison error:',
        err
      );

      return send(
        res,
        500,
        {
          error:
            err?.message ||
            'Adobe PDF comparison failed.'
        }
      );

    } finally {

      await Promise.allSettled([

        deletePrivateBlob(
          oldPath
        ),

        deletePrivateBlob(
          newPath
        )

      ]);
    }
  };

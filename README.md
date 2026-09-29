# DiffIQ — Document Change Intelligence

A browser-first document version comparison PWA. DiffIQ compares two document versions locally in the browser, highlights changes side-by-side, classifies important changes, and exports a change report.

## Supported formats

- TXT / MD / JSON
- CSV
- HTML
- DOCX (structured paragraphs, headings, lists and table cells)
- XLSX / XLS (cell-level values + formula changes)
- PPTX (slide text extraction), TSV
- PDF (native text or OCR for scans, with on-page highlights)

## Important privacy behavior

Files are processed in the browser. They are not uploaded to a server by this build.

## Run locally

Do **not** double-click `index.html` if you want PWA installation. Service workers require HTTPS or localhost.

```bash
cd DiffIQ_Production
python -m http.server 8080
```

Open `http://localhost:8080`.

After the first load, refresh once if the browser has not yet offered installation. Use the **Install** button in the DiffIQ top bar.

## Deploy to Vercel

This folder is ready for static deployment.

```bash
npx vercel --prod
```

Or create a Vercel project and upload/push this folder. `vercel.json` supplies the correct service-worker and manifest cache/content headers.

## PWA install checklist

The production URL must:

1. Use HTTPS (localhost is also allowed for development).
2. Serve `manifest.json` successfully.
3. Serve `sw.js` successfully from the same application scope.
4. Serve the required 192px and 512px icons.
5. Allow the service worker to activate.

This package includes:

- `icon-192.png`
- `icon-192-maskable.png`
- `icon-512.png`
- `icon-512-maskable.png`
- `manifest.json`
- `sw.js`

On Chromium browsers, the in-app **Install** button uses the native install prompt when it is available. On iPhone/iPad, Safari requires **Share → Add to Home Screen**.

## Comparison behavior

Every format is turned into the same model: ordered **blocks** (paragraphs / rows / PDF text regions) made of **words**.
PDF words keep their page + bounding box, so changes are highlighted on the page itself.

1. Blocks are aligned with an LCS anchor pass (exact match; for OCR'd documents a strict "every word equal-or-noise" match).
2. Inside each unaligned region a word-level LCS finds the exact changed words (handles re-wrapped, split and merged paragraphs).
3. Identical text removed in one place and added in another is reported as **moved**.
4. Changes are classified (numeric, date, financial, legal) and scored from the changed words plus their context.

### Scanned PDFs
* Pages with no text layer are OCR'd (Tesseract, automatic page layout, contrast-normalised, ~300 dpi) and their word boxes are kept.
* Comparison is text-based, never pixel-based, so scan tilt, noise, offset, resolution and JPEG quality do not create changes.
* OCR noise tolerance applies to words of 4+ letters only. **Numbers are always compared strictly**, and OCR changes are tagged with confidence; low-confidence ones get a `verify` tag.
* Native vs scanned (and scanned vs native) works.

## Tests
`tests/` has a Node harness (`npm i tesseract.js@5.0.4 @tesseract.js-data/eng jsdom mammoth xlsx jszip pdfjs-dist@3.11.174 canvas`),
a corpus generator (`gen.py`: TXT, DOCX, HTML, CSV, XLSX, native PDF and degraded scanned PDFs with 6 known edits),
`run.js <a>,<b> ...` to diff pairs and `ui.js` for a DOM smoke test.

## Production notes

- Current browser-processing size limit: 25 MB per file.
- AI interpretation is not included in this offline build; the deterministic diff works without any API key.
- For very large enterprise documents, OCR, layout-aware PDF coordinates, user accounts, team history and server-side background jobs, add a FastAPI backend/object storage layer rather than increasing browser memory limits indefinitely.

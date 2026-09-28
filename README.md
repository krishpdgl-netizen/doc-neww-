# DiffIQ Full Stack

A document comparison engine with a Vercel-friendly frontend and Render FastAPI backend.

## Supported formats
PDF, DOCX, XLSX/XLSM, PPTX, TXT, MD, CSV.

## Architecture
- `frontend/index.html` — static frontend, deploy to Vercel.
- `backend/main.py` — FastAPI extraction + structural/token comparison.
- `backend/Dockerfile` — Render deployment with Tesseract and Poppler.

## Deploy backend to Render
Create a Web Service from `backend/` using Docker. The included `render.yaml` is also usable as a Blueprint.

After deployment, note the Render URL, e.g. `https://diffiq-api.onrender.com`.

## Deploy frontend to Vercel
Deploy `frontend/` as a static site. If the backend URL differs, edit `API` near the top of the script or define `window.DIFFIQ_API` before the application script.

## Comparison model
1. Format-aware extraction.
2. Block/line sequence alignment.
3. Added / removed / modified / unchanged classification.
4. Token-level comparison inside modified blocks.
5. PDF native text extraction with OCR fallback for scanned pages.
6. JSON report download.

## Limits
Default maximum file size is 50 MB per file. The free Render tier may sleep between requests and OCR is CPU-intensive.

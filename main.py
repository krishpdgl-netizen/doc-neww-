"""
DiffIQ PDF Extraction Backend
FastAPI + pdfplumber (native text) + Tesseract (scanned pages)

Flow per page:
  1. pdfplumber extracts words with bounding boxes
  2. If a page yields < 30 chars → it's scanned
     → pdf2image converts that page to a 300 DPI image
     → pytesseract.image_to_data() returns word boxes
  3. Response is always the same structured JSON regardless of source

Deploy on Render free tier.
Render provides Tesseract + poppler (needed by pdf2image) out of the box
via its Ubuntu 22 build image — no apt install needed.
If on a plain Ubuntu box: apt install tesseract-ocr poppler-utils
"""

import io
import os
import logging
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import pdfplumber
from PIL import Image
import pytesseract

# pdf2image needs poppler — available on Render's build image
try:
    from pdf2image import convert_from_bytes
    PDF2IMAGE_OK = True
except ImportError:
    PDF2IMAGE_OK = False

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("diffiq")

app = FastAPI(title="DiffIQ PDF API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ── Constants ─────────────────────────────────────────────────────────────────
SCAN_THRESHOLD   = 30      # chars per page below this = scanned
OCR_DPI          = 300     # DPI for rasterising scanned pages
OCR_SCALE        = OCR_DPI / 72  # PDF points → pixels at this DPI
MIN_WORD_CONF    = 40      # Tesseract confidence threshold (0–100)

# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {
        "status": "ok",
        "service": "DiffIQ PDF API v2",
        "ocr": PDF2IMAGE_OK,
    }

@app.get("/health")
def health():
    return {"status": "ok"}


# ══════════════════════════════════════════════════════════════════════════════
# CORE EXTRACTOR
# ══════════════════════════════════════════════════════════════════════════════

def extract_native_page(page) -> list[dict]:
    """
    Extract structured blocks from a pdfplumber page that has a text layer.
    Returns list of block dicts with word-level items and bounding boxes.
    """
    words = page.extract_words(
        x_tolerance=3,
        y_tolerance=3,
        keep_blank_chars=False,
        use_text_flow=True,
        extra_attrs=["size", "fontname"],
    )
    if not words:
        return []

    page_h = page.height

    # ── Group words into lines by top (Y) ─────────────────────────────────────
    LINE_TOL = 3
    lines: list[list[dict]] = []
    for w in words:
        placed = False
        for line in lines:
            if abs(w["top"] - line[0]["top"]) <= LINE_TOL:
                line.append(w)
                placed = True
                break
        if not placed:
            lines.append([w])
    for line in lines:
        line.sort(key=lambda w: w["x0"])
    lines.sort(key=lambda l: l[0]["top"])

    if not lines:
        return []

    # ── Compute median line height for gap detection ───────────────────────────
    line_heights = [max(w["bottom"] - w["top"] for w in l) for l in lines]
    line_heights_s = sorted(line_heights)
    med_h = line_heights_s[len(line_heights_s) // 2] if line_heights_s else 12
    PARA_GAP = med_h * 1.2

    # ── Group lines into paragraph blocks ─────────────────────────────────────
    paragraphs: list[list[list[dict]]] = []
    cur: list[list[dict]] = []
    prev_bottom = None
    for line in lines:
        top = line[0]["top"]
        if prev_bottom is not None and (top - prev_bottom) > PARA_GAP:
            if cur:
                paragraphs.append(cur)
            cur = [line]
        else:
            cur.append(line)
        prev_bottom = max(w["bottom"] for w in line)
    if cur:
        paragraphs.append(cur)

    # ── Convert paragraphs → block dicts ──────────────────────────────────────
    blocks = []
    for para in paragraphs:
        all_words = [w for line in para for w in line]
        if not all_words:
            continue

        # Table row: large horizontal gap between adjacent words on the same line
        is_table_row = False
        for line in para:
            if len(line) >= 2:
                gaps = [line[k+1]["x0"] - line[k]["x1"] for k in range(len(line)-1)]
                if any(g > 20 for g in gaps):
                    is_table_row = True
                    break

        # Heading: average font size significantly larger than body
        avg_size = sum(w.get("size", 12) for w in all_words) / len(all_words)
        is_header = avg_size > (med_h * 1.4)

        # Block text
        if is_table_row:
            text = "\t".join(
                " ".join(w["text"] for w in line).strip()
                for line in para
            ).strip()
        else:
            text = " ".join(w["text"] for w in all_words).strip()

        if not text:
            continue

        # Block bounding box (PDF points, origin top-left)
        x0 = min(w["x0"]     for w in all_words)
        y0 = min(w["top"]    for w in all_words)
        x1 = max(w["x1"]     for w in all_words)
        y1 = max(w["bottom"] for w in all_words)

        # Word-level items
        items = [
            {
                "str":  w["text"],
                "bbox": [
                    round(w["x0"],     2),
                    round(w["top"],    2),
                    round(w["x1"],     2),
                    round(w["bottom"], 2),
                ],
            }
            for w in all_words
        ]

        blocks.append({
            "text":       text,
            "isTableRow": is_table_row,
            "isHeader":   is_header,
            "source":     "pdfplumber",
            "bbox":       [round(x0,2), round(y0,2), round(x1,2), round(y1,2)],
            "items":      items,
        })

    return blocks


def extract_ocr_page(page_image: Image.Image, page_w_pts: float, page_h_pts: float) -> list[dict]:
    """
    Run Tesseract on a PIL image of a scanned page.
    Returns blocks in the same format as extract_native_page,
    with bounding boxes converted back to PDF points so the
    frontend coord system is identical for both paths.
    """
    img_w, img_h = page_image.size
    # Scale factors: image pixels → PDF points
    sx = page_w_pts / img_w
    sy = page_h_pts / img_h

    # image_to_data returns a TSV-style dict with one word per row
    ocr_data = pytesseract.image_to_data(
        page_image,
        output_type=pytesseract.Output.DICT,
        config="--psm 6",   # assume uniform block of text
    )

    n = len(ocr_data["text"])
    words = []
    for i in range(n):
        text = str(ocr_data["text"][i]).strip()
        conf = int(ocr_data["conf"][i])
        if not text or conf < MIN_WORD_CONF:
            continue
        x      = ocr_data["left"][i]
        y      = ocr_data["top"][i]
        w      = ocr_data["width"][i]
        h      = ocr_data["height"][i]
        block_num = ocr_data["block_num"][i]
        par_num   = ocr_data["par_num"][i]
        line_num  = ocr_data["line_num"][i]

        # Convert pixel coords → PDF points
        x0 = round(x * sx, 2)
        y0 = round(y * sy, 2)
        x1 = round((x + w) * sx, 2)
        y1 = round((y + h) * sy, 2)

        words.append({
            "text":      text,
            "x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "block_num": block_num,
            "par_num":   par_num,
            "line_num":  line_num,
            "conf":      conf,
        })

    if not words:
        return []

    # ── Group words by Tesseract's own block+paragraph grouping ──────────────
    from itertools import groupby
    blocks = []
    key_fn = lambda w: (w["block_num"], w["par_num"])
    for (bn, pn), group in groupby(sorted(words, key=key_fn), key=key_fn):
        para_words = list(group)
        if not para_words:
            continue

        text = " ".join(w["text"] for w in para_words)

        x0 = min(w["x0"] for w in para_words)
        y0 = min(w["y0"] for w in para_words)
        x1 = max(w["x1"] for w in para_words)
        y1 = max(w["y1"] for w in para_words)

        items = [
            {
                "str":  w["text"],
                "bbox": [w["x0"], w["y0"], w["x1"], w["y1"]],
            }
            for w in para_words
        ]

        blocks.append({
            "text":       text,
            "isTableRow": False,
            "isHeader":   False,
            "source":     "ocr",
            "bbox":       [x0, y0, x1, y1],
            "items":      items,
        })

    return blocks


# ── Main PDF extractor ────────────────────────────────────────────────────────
def extract_pdf(data: bytes) -> dict:
    all_blocks = []
    block_index = 0
    ocr_page_count = 0

    with pdfplumber.open(io.BytesIO(data)) as pdf:
        page_count = len(pdf.pages)
        scanned_page_nums = []  # 0-based indices that need OCR

        for page_num, page in enumerate(pdf.pages, start=1):
            # Try native extraction first
            native_blocks = extract_native_page(page)
            native_text = " ".join(b["text"] for b in native_blocks)

            if len(native_text.strip()) >= SCAN_THRESHOLD:
                # Good native text layer
                for b in native_blocks:
                    b["pageNum"]    = page_num
                    b["blockIndex"] = block_index
                    block_index += 1
                all_blocks.extend(native_blocks)
            else:
                # Scanned page — mark for OCR
                scanned_page_nums.append(page_num - 1)  # 0-based for pdf2image
                log.info(f"  Page {page_num}: scanned (native text: {len(native_text.strip())} chars) → queued for OCR")

        # ── OCR all scanned pages in one pdf2image call ───────────────────────
        if scanned_page_nums and PDF2IMAGE_OK:
            ocr_page_count = len(scanned_page_nums)
            log.info(f"  Running OCR on {ocr_page_count} scanned pages...")

            # Convert only the scanned pages (1-based page numbers for pdf2image)
            one_based = [n + 1 for n in scanned_page_nums]
            images = convert_from_bytes(
                data,
                dpi=OCR_DPI,
                first_page=min(one_based),
                last_page=max(one_based),
                fmt="PNG",
            )

            # pdf2image returns pages in order — zip with sorted page numbers
            one_based_sorted = sorted(one_based)
            with pdfplumber.open(io.BytesIO(data)) as pdf2:
                for img, page_num_1based in zip(images, one_based_sorted):
                    page = pdf2.pages[page_num_1based - 1]
                    ocr_blocks = extract_ocr_page(img, page.width, page.height)
                    for b in ocr_blocks:
                        b["pageNum"]    = page_num_1based
                        b["blockIndex"] = block_index
                        block_index += 1
                    all_blocks.extend(ocr_blocks)
                    log.info(f"  OCR page {page_num_1based}: {len(ocr_blocks)} blocks")

        elif scanned_page_nums and not PDF2IMAGE_OK:
            log.warning("pdf2image not available — scanned pages skipped")

        # Sort blocks by page then original block index
        all_blocks.sort(key=lambda b: (b["pageNum"], b["blockIndex"]))

    return {
        "pageCount":    page_count,
        "ocrPageCount": ocr_page_count,
        "blocks":       all_blocks,
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.post("/extract")
async def extract_endpoint(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are accepted.")
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 50 MB).")
    try:
        log.info(f"Extracting: {file.filename} ({len(data)//1024} KB)")
        result = extract_pdf(data)
        log.info(f"  → {result['pageCount']} pages, {len(result['blocks'])} blocks, {result['ocrPageCount']} OCR pages")
        return JSONResponse(content=result)
    except Exception as e:
        log.error(f"Extraction failed: {e}", exc_info=True)
        raise HTTPException(500, f"Extraction error: {str(e)}")


@app.post("/extract-both")
async def extract_both(
    old_file: UploadFile = File(..., alias="oldFile"),
    new_file: UploadFile = File(..., alias="newFile"),
):
    for f in [old_file, new_file]:
        if not f.filename.lower().endswith(".pdf"):
            raise HTTPException(400, f"{f.filename} is not a PDF.")
    old_data = await old_file.read()
    new_data = await new_file.read()
    try:
        log.info(f"Extracting pair: {old_file.filename} + {new_file.filename}")
        old_result = extract_pdf(old_data)
        new_result = extract_pdf(new_data)
        return JSONResponse(content={"old": old_result, "new": new_result})
    except Exception as e:
        log.error(f"Extraction failed: {e}", exc_info=True)
        raise HTTPException(500, f"Extraction error: {str(e)}")

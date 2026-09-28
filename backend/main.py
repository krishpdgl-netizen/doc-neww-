import io, os, re, json, hashlib, logging
from difflib import SequenceMatcher
from typing import Any

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import pdfplumber
from PIL import Image
import pytesseract
from pdf2image import convert_from_bytes
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("diffiq")

MAX_FILE = 50 * 1024 * 1024
SUPPORTED = {"pdf", "docx", "xlsx", "xlsm", "pptx", "txt", "md", "csv"}

app = FastAPI(title="DiffIQ Document Comparison API", version="3.0.0")
origins = [x.strip() for x in os.getenv("CORS_ORIGINS", "*").split(",") if x.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins if origins != ["*"] else ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def ext(name: str) -> str:
    return name.lower().rsplit(".", 1)[-1] if "." in name else ""


def norm(s: Any) -> str:
    s = "" if s is None else str(s)
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def word_tokens(s: str):
    return re.findall(r"\w+|[^\w\s]", s, flags=re.UNICODE)


def make_blocks(items, kind="paragraph"):
    blocks = []
    for i, item in enumerate(items):
        text = norm(item.get("text", ""))
        if not text:
            continue
        b = dict(item)
        b["id"] = i
        b["text"] = text
        b["kind"] = kind if "kind" not in b else b["kind"]
        blocks.append(b)
    return blocks


def extract_pdf(data: bytes):
    pages = []
    ocr_pages = 0
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for pno, page in enumerate(pdf.pages, 1):
            words = page.extract_words(x_tolerance=3, y_tolerance=3, use_text_flow=True, keep_blank_chars=False)
            native = " ".join(w["text"] for w in words).strip() if words else ""
            if len(native) >= 20:
                lines = []
                for w in words:
                    placed = False
                    for line in lines:
                        if abs(w["top"] - line[0]["top"]) <= 3:
                            line.append(w); placed = True; break
                    if not placed: lines.append([w])
                for line in lines: line.sort(key=lambda x: x["x0"])
                lines.sort(key=lambda x: x[0]["top"])
                blocks = []
                for line in lines:
                    text = " ".join(x["text"] for x in line).strip()
                    if text:
                        blocks.append({"text": text, "page": pno, "bbox": [round(min(x["x0"] for x in line),2), round(min(x["top"] for x in line),2), round(max(x["x1"] for x in line),2), round(max(x["bottom"] for x in line),2)], "kind": "line"})
                pages.append({"page": pno, "width": page.width, "height": page.height, "source": "text", "blocks": blocks})
            else:
                try:
                    img = convert_from_bytes(data, dpi=220, first_page=pno, last_page=pno, fmt="PNG")[0]
                    d = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT, config="--psm 6")
                    byline = {}
                    for i, t in enumerate(d["text"]):
                        t = norm(t)
                        if not t: continue
                        try: conf = float(d["conf"][i])
                        except: conf = 0
                        if conf < 35: continue
                        key = (d["block_num"][i], d["par_num"][i], d["line_num"][i])
                        byline.setdefault(key, []).append(t)
                    blocks = [{"text": " ".join(v), "page": pno, "kind": "ocr"} for v in byline.values()]
                    pages.append({"page": pno, "width": page.width, "height": page.height, "source": "ocr", "blocks": blocks})
                    ocr_pages += 1
                except Exception as e:
                    log.exception("OCR failed on page %s", pno)
                    pages.append({"page": pno, "width": page.width, "height": page.height, "source": "empty", "blocks": []})
    blocks = []
    for p in pages: blocks.extend(p["blocks"])
    return {"format":"pdf", "pageCount":len(pages), "ocrPages":ocr_pages, "pages":pages, "blocks":blocks}


def extract_docx(data: bytes):
    doc = Document(io.BytesIO(data)); blocks=[]
    for i,p in enumerate(doc.paragraphs):
        t=norm(p.text)
        if t: blocks.append({"text":t,"index":i,"kind":"heading" if p.style and p.style.name.lower().startswith("heading") else "paragraph"})
    for ti,table in enumerate(doc.tables):
        for ri,row in enumerate(table.rows):
            vals=[norm(c.text) for c in row.cells]
            blocks.append({"text":" | ".join(vals),"table":ti,"row":ri,"kind":"table-row"})
    return {"format":"docx","pageCount":None,"pages":[],"blocks":blocks}


def extract_xlsx(data: bytes):
    wb=load_workbook(io.BytesIO(data), data_only=False, read_only=True)
    blocks=[]; sheets=[]
    for ws in wb.worksheets:
        rows=[]
        for row in ws.iter_rows():
            vals=["" if c.value is None else str(c.value) for c in row]
            if any(v.strip() for v in vals):
                text="\t".join(vals).rstrip("\t")
                rows.append({"text":text,"sheet":ws.title,"row":row[0].row,"kind":"sheet-row"})
        sheets.append({"name":ws.title,"rows":len(rows)})
        blocks.extend(rows)
    return {"format":"xlsx","pageCount":None,"sheets":sheets,"pages":[],"blocks":blocks}


def extract_pptx(data: bytes):
    prs=Presentation(io.BytesIO(data)); slides=[]; blocks=[]
    for si,slide in enumerate(prs.slides,1):
        texts=[]
        for shape in slide.shapes:
            if hasattr(shape,"text") and norm(shape.text): texts.append(norm(shape.text))
        text="\n".join(texts)
        slides.append({"slide":si,"text":text})
        if text: blocks.append({"text":text,"slide":si,"kind":"slide"})
    return {"format":"pptx","pageCount":len(prs.slides),"slides":slides,"pages":[],"blocks":blocks}


def extract_plain(data: bytes, extension: str):
    text=data.decode("utf-8-sig",errors="replace")
    lines=[norm(x) for x in text.splitlines() if norm(x)]
    return {"format":extension,"pageCount":None,"pages":[],"blocks":[{"text":x,"line":i+1,"kind":"line"} for i,x in enumerate(lines)]}


def extract(data, filename):
    e=ext(filename)
    if e not in SUPPORTED: raise HTTPException(400, f"Unsupported file type: .{e}. Supported: {', '.join(sorted(SUPPORTED))}")
    if e=="pdf": return extract_pdf(data)
    if e=="docx": return extract_docx(data)
    if e in {"xlsx","xlsm"}: return extract_xlsx(data)
    if e=="pptx": return extract_pptx(data)
    return extract_plain(data,e)


def line_diff(a, b):
    A=[x["text"] for x in a["blocks"]]; B=[x["text"] for x in b["blocks"]]
    sm=SequenceMatcher(None,A,B,autojunk=False)
    changes=[]; ai=bi=0
    for tag,i1,i2,j1,j2 in sm.get_opcodes():
        if tag=="equal":
            for k in range(i2-i1):
                changes.append({"type":"same","left":a["blocks"][i1+k],"right":b["blocks"][j1+k]})
        elif tag=="delete":
            for k in range(i1,i2): changes.append({"type":"removed","left":a["blocks"][k],"right":None})
        elif tag=="insert":
            for k in range(j1,j2): changes.append({"type":"added","left":None,"right":b["blocks"][k]})
        else:
            n=max(i2-i1,j2-j1)
            for k in range(n):
                l=a["blocks"][i1+k] if i1+k<i2 else None; r=b["blocks"][j1+k] if j1+k<j2 else None
                if l and r:
                    changes.append({"type":"modified","left":l,"right":r,"tokens":token_diff(l["text"],r["text"])})
                elif l: changes.append({"type":"removed","left":l,"right":None})
                else: changes.append({"type":"added","left":None,"right":r})
    return changes


def token_diff(a,b):
    A=word_tokens(a); B=word_tokens(b); sm=SequenceMatcher(None,A,B,autojunk=False); out=[]
    for tag,i1,i2,j1,j2 in sm.get_opcodes():
        if tag=="equal": out.append({"type":"same","left":" ".join(A[i1:i2]),"right":" ".join(B[j1:j2])})
        elif tag=="delete": out.append({"type":"removed","left":" ".join(A[i1:i2]),"right":""})
        elif tag=="insert": out.append({"type":"added","left":"","right":" ".join(B[j1:j2])})
        else: out.append({"type":"modified","left":" ".join(A[i1:i2]),"right":" ".join(B[j1:j2])})
    return out


def compare(left,right):
    changes=line_diff(left,right)
    summary={"same":0,"added":0,"removed":0,"modified":0}
    for c in changes: summary[c["type"]]+=1
    total=summary["same"]+summary["added"]+summary["removed"]+summary["modified"]
    similarity=SequenceMatcher(None,[x["text"] for x in left["blocks"]],[x["text"] for x in right["blocks"]],autojunk=False).ratio() if total else 1
    return {"summary":summary,"similarity":round(similarity*100,2),"changes":changes,"left":{k:v for k,v in left.items() if k!="blocks"},"right":{k:v for k,v in right.items() if k!="blocks"}}


@app.get("/")
def root(): return {"service":"DiffIQ API","version":"3.0.0","status":"ok","formats":sorted(SUPPORTED)}

@app.get("/health")
def health(): return {"status":"ok"}

@app.post("/compare")
async def compare_endpoint(left: UploadFile=File(...), right: UploadFile=File(...)):
    if ext(left.filename)!=ext(right.filename):
        raise HTTPException(400,"For reliable structural comparison, both documents must have the same file type.")
    lb=await left.read(); rb=await right.read()
    if len(lb)>MAX_FILE or len(rb)>MAX_FILE: raise HTTPException(413,"Each file must be 50 MB or smaller.")
    if not lb or not rb: raise HTTPException(400,"Both files are required.")
    try:
        le=extract(lb,left.filename); re_=extract(rb,right.filename)
        result=compare(le,re_)
        result["files"]={"left":left.filename,"right":right.filename}
        result["engine"]="DiffIQ structural + token comparison v3"
        return result
    except HTTPException: raise
    except Exception as e:
        log.exception("comparison failed")
        raise HTTPException(500,f"Comparison failed: {type(e).__name__}: {e}")

@app.post("/extract")
async def extract_endpoint(file: UploadFile=File(...)):
    data=await file.read()
    if len(data)>MAX_FILE: raise HTTPException(413,"File too large (max 50 MB).")
    try: return extract(data,file.filename)
    except HTTPException: raise
    except Exception as e:
        log.exception("extraction failed")
        raise HTTPException(500,f"Extraction failed: {type(e).__name__}: {e}")

FROM python:3.11-slim

# Install system deps:
#   tesseract-ocr     — OCR engine
#   tesseract-ocr-eng — English language data
#   poppler-utils     — pdf2image needs pdftoppm from poppler
#   libgl1            — Pillow dependency
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    libgl1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

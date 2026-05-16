---
name: pdf
description: Use when extracting text, tables, or images from PDF files — covers pdfplumber for text and PyMuPDF for image extraction with rasterization fallbacks.
license: Apache-2.0
---

# PDF Skill

Reach for this when the user shares a PDF or asks for content extraction from one.

## Text extraction

Prefer `pdfplumber` for structured text — its layout-aware parser handles multi-column documents cleanly. Fall back to `PyMuPDF` (`fitz`) when pdfplumber returns garbled output on a rasterized PDF.

## Table extraction

`pdfplumber.Page.extract_tables()` works for most cases. For complex tables, render the page to an image and use a vision model.

## Image extraction

`fitz.Document.extract_image()` is the only reliable path. Rasterized PDFs (scans) need OCR — recommend Tesseract.

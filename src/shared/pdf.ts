import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = workerSrc;

export type LoadedPdfDocument = {
  url: string;
  sourceUrl: string;
  title: string;
  pageCount: number;
  pdf: PDFDocumentProxy;
};

export type PdfPageImage = {
  page: number;
  dataUrl: string;
};

const PDF_RENDER_SCALE = 1;
const PDF_IMAGE_QUALITY = 0.8;

export function getPdfSourceUrl(tabUrl: string | undefined): string | null {
  if (!tabUrl) {
    return null;
  }

  try {
    const url = new URL(tabUrl);
    const viewerSource = url.searchParams.get("src") || url.searchParams.get("file");
    if (url.protocol === "chrome-extension:" && viewerSource) {
      return viewerSource;
    }
  } catch {
    // Fall through to direct URL parsing.
  }

  const [withoutHash] = tabUrl.split("#", 1);
  const [withoutSearch] = withoutHash.split("?", 1);
  return /\.pdf$/i.test(withoutSearch) ? withoutHash : null;
}

export function getPdfTargetPageFromUrl(tabUrl: string | undefined): number {
  if (!tabUrl) {
    return 1;
  }
  const match = tabUrl.match(/[#&?]page=(\d+)/i);
  const page = match ? Number(match[1]) : 1;
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export async function loadPdfDocument(tabUrl: string): Promise<LoadedPdfDocument> {
  const sourceUrl = getPdfSourceUrl(tabUrl);
  if (!sourceUrl) {
    throw new Error("Current tab is not a PDF URL.");
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(buildPdfFetchError(sourceUrl, response.status));
  }

  const data = await response.arrayBuffer();
  const loadingTask = getDocument({ data: new Uint8Array(data) });
  const pdf = await loadingTask.promise;
  return {
    url: tabUrl,
    sourceUrl,
    title: getPdfTitle(sourceUrl),
    pageCount: pdf.numPages,
    pdf
  };
}

export function parsePdfPageRange(input: string, pageCount: number): number[] {
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === "all") {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const pages = new Set<number>();
  for (const segment of trimmed.split(",")) {
    const match = segment.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      throw new Error(`Invalid page range: ${segment.trim() || input}`);
    }

    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start <= 0 || end < start || end > pageCount) {
      throw new Error(`Page range must stay between 1 and ${pageCount}.`);
    }
    for (let page = start; page <= end; page += 1) {
      pages.add(page);
    }
  }

  return [...pages].sort((a, b) => a - b);
}

export async function renderPdfPage(pdf: PDFDocumentProxy, pageNumber: number): Promise<PdfPageImage> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create a canvas context for PDF rendering.");
  }

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const dataUrl = canvas.toDataURL("image/jpeg", PDF_IMAGE_QUALITY);
  canvas.width = 0;
  canvas.height = 0;
  return {
    page: pageNumber,
    dataUrl
  };
}

export async function renderPdfPages(pdf: PDFDocumentProxy, pages: number[]): Promise<PdfPageImage[]> {
  const rendered: PdfPageImage[] = [];
  for (const pageNumber of pages) {
    rendered.push(await renderPdfPage(pdf, pageNumber));
  }
  return rendered;
}

function buildPdfFetchError(sourceUrl: string, status: number): string {
  if (sourceUrl.startsWith("file:")) {
    return "Could not read this local PDF. Open the extension details in Chrome and enable Allow access to file URLs.";
  }
  return `Could not fetch PDF file. HTTP ${status}.`;
}

function getPdfTitle(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    const path = decodeURIComponent(url.pathname);
    return path.split("/").filter(Boolean).pop() || "PDF document";
  } catch {
    return "PDF document";
  }
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { ContentRequest, ContentResponse, DeepPdfBlock, PdfBoundingBox } from "../shared/types";
import "./styles.css";

GlobalWorkerOptions.workerSrc = workerSrc;

type ViewerState = "landing" | "loading" | "ready" | "error";
type PageSize = { width: number; height: number };
type CoordinateBase = { xMin: number; yMin: number; width: number; height: number };

function getSourceFromUrl(): string | null {
  const params = new URLSearchParams(location.search);
  return params.get("src") || null;
}

function App() {
  const [state, setState] = useState<ViewerState>(() => (getSourceFromUrl() ? "loading" : "landing"));
  const [error, setError] = useState("");
  const [title, setTitle] = useState("PDF Viewer");
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInputValue, setPageInputValue] = useState("1");
  const [highlightedBlocks, setHighlightedBlocks] = useState<DeepPdfBlock[]>([]);
  const [highlightedSectionId, setHighlightedSectionId] = useState("");
  const [highlightedPageBboxes, setHighlightedPageBboxes] = useState<Record<number, PdfBoundingBox>>({});
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const renderingRef = useRef(0);
  const pageCountRef = useRef(0);

  const loadPdf = useCallback(async (source: string | ArrayBuffer) => {
    const version = ++renderingRef.current;
    setState("loading");
    setError("");

    try {
      const loadingTask =
        typeof source === "string"
          ? getDocument(source)
          : getDocument({ data: new Uint8Array(source) });
      const pdf = await loadingTask.promise;
      if (version !== renderingRef.current) return;

      pdfRef.current = pdf;

      const pdfTitle = getPdfTitle(typeof source === "string" ? source : "Local PDF");
      setTitle(pdfTitle);
      document.title = pdfTitle;
      setPageCount(pdf.numPages);
      pageCountRef.current = pdf.numPages;
      setCurrentPage(1);
      setPageInputValue("1");
      setPageSizes({});
      setState("ready");

      // Render pages after state update
      requestAnimationFrame(() => {
        if (version !== renderingRef.current) return;
        void renderAllPages(pdf, version);
      });
    } catch (err) {
      if (version !== renderingRef.current) return;
      setState("error");
      setError((err as Error).message);
    }
  }, []);

  // Load from URL on mount
  useEffect(() => {
    const src = getSourceFromUrl();
    if (src) {
      void loadPdf(src);
    }
  }, [loadPdf]);

  // Keep refs so the stable message handler always uses the latest functions
  const getVisiblePageRef = useRef(getVisiblePage);
  const scrollToPageRef = useRef(scrollToPage);
  useEffect(() => {
    getVisiblePageRef.current = getVisiblePage;
    scrollToPageRef.current = scrollToPage;
  });

  // Listen for messages from side panel
  useEffect(() => {
    const handler = (
      request: ContentRequest,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: ContentResponse) => void
    ) => {
      if (request.type === "LEARN_PANEL_GET_ACTIVE_PDF_PAGE") {
        sendResponse({ ok: true, activePage: getVisiblePageRef.current() });
        return false;
      }

      if (request.type === "LEARN_PANEL_GET_SELECTION") {
        const selection = window.getSelection()?.toString().trim() ?? "";
        sendResponse({ ok: true, selection });
        return false;
      }

      if (request.type === "LEARN_PANEL_GET_ARTICLE") {
        sendResponse({ ok: false, error: "This is a PDF viewer page." });
        return false;
      }

      if (request.type === "LEARN_PANEL_GET_ACTIVE_SECTION") {
        sendResponse({ ok: true, activeSectionId: null });
        return false;
      }

      if (request.type === "LEARN_PANEL_SCROLL_TO_PDF_PAGE") {
        scrollToPageRef.current(request.page);
        sendResponse({ ok: true });
        return false;
      }

      if (request.type === "LEARN_PANEL_HIGHLIGHT_PDF_BLOCKS") {
        setHighlightedSectionId(request.sectionId);
        setHighlightedBlocks(request.blocks.filter((block) => block.bbox));
        setHighlightedPageBboxes(request.pageBboxes ?? {});
        const firstPage = request.blocks.find((block) => block.bbox)?.page;
        if (firstPage) {
          scrollToPageRef.current(firstPage);
        }
        sendResponse({ ok: true });
        return false;
      }

      return false;
    };

    chrome.runtime?.onMessage?.addListener(handler);
    return () => {
      chrome.runtime?.onMessage?.removeListener(handler);
    };
  }, []);

  // Track scroll position to update current page
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl || state !== "ready") return;

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const page = getVisiblePage();
        setCurrentPage(page);
        setPageInputValue(String(page));
      });
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [state]);

  function getVisiblePage(): number {
    const scrollEl = scrollRef.current;
    if (!scrollEl || pageCountRef.current === 0) return 1;

    const scrollMid = scrollEl.scrollTop + scrollEl.clientHeight * 0.4;
    let best = 1;
    let bestDist = Infinity;

    for (const [page, el] of pageRefs.current) {
      const rect = el.getBoundingClientRect();
      const containerRect = scrollEl.getBoundingClientRect();
      const elMidInContainer = rect.top - containerRect.top + rect.height / 2;
      const viewMid = scrollEl.clientHeight * 0.4;
      const dist = Math.abs(elMidInContainer - viewMid);
      if (dist < bestDist) {
        bestDist = dist;
        best = page;
      }
    }

    return best;
  }

  async function renderAllPages(pdf: PDFDocumentProxy, version: number) {
    for (let i = 1; i <= pdf.numPages; i++) {
      if (version !== renderingRef.current) return;

      const wrapper = pageRefs.current.get(i);
      if (!wrapper) continue;

      // Skip if already rendered
      if (wrapper.querySelector("canvas")) continue;

      try {
        const page = await pdf.getPage(i);
        if (version !== renderingRef.current) return;

        const scale = 2;
        const viewport = page.getViewport({ scale });
        const baseViewport = page.getViewport({ scale: 1 });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (version !== renderingRef.current) return;

        wrapper.appendChild(canvas);
        setPageSizes((sizes) => ({
          ...sizes,
          [i]: { width: baseViewport.width, height: baseViewport.height }
        }));
      } catch {
        // Skip failed pages
      }
    }
  }

  function handleFileSelect() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const buffer = await file.arrayBuffer();
      void loadPdf(buffer);
    };
    input.click();
  }

  function handlePageInputSubmit() {
    const page = Number(pageInputValue);
    if (Number.isInteger(page) && page >= 1 && page <= pageCount) {
      scrollToPage(page);
    } else {
      setPageInputValue(String(currentPage));
    }
  }

  function scrollToPage(page: number) {
    const el = pageRefs.current.get(page);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (state === "landing") {
    return (
      <div className="viewer-shell">
        <div className="toolbar">
          <span className="toolbar-title">PDF Viewer</span>
        </div>
        <div className="file-landing">
          <div className="file-landing-inner">
            <h1>Open a PDF</h1>
            <p>Select a PDF file from your computer to view it here with full Learning Panel support.</p>
            <button className="file-pick-button" type="button" onClick={handleFileSelect}>
              Choose PDF File
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div className="viewer-shell">
        <div className="toolbar">
          <span className="toolbar-title">Loading...</span>
        </div>
        <div className="loading-indicator">Loading PDF...</div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="viewer-shell">
        <div className="toolbar">
          <span className="toolbar-title">PDF Viewer</span>
        </div>
        <div className="error-message">
          <p>Could not load PDF</p>
          <p>{error}</p>
          <button className="file-pick-button" type="button" onClick={handleFileSelect}>
            Choose another file
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer-shell">
      <div className="toolbar">
        <span className="toolbar-title">{title}</span>
        <div className="toolbar-page-info">
          <input
            className="toolbar-page-input"
            type="text"
            value={pageInputValue}
            onChange={(e) => setPageInputValue(e.target.value)}
            onBlur={handlePageInputSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handlePageInputSubmit();
              }
            }}
          />
          <span>/ {pageCount}</span>
        </div>
      </div>
      <div className="pages-scroll" ref={scrollRef}>
        <div className="pages-container">
          {Array.from({ length: pageCount }, (_, i) => i + 1).map((page) => (
            <div
              className="pdf-page-wrapper"
              key={page}
              ref={(el) => {
                if (el) {
                  pageRefs.current.set(page, el);
                } else {
                  pageRefs.current.delete(page);
                }
              }}
            >
              <span className="page-number-label">{page}</span>
              <PdfBlockOverlay
                blocks={highlightedBlocks.filter((block) => block.page === page)}
                sectionId={highlightedSectionId}
                pageSize={pageSizes[page]}
                pageBBox={highlightedPageBboxes[page]}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PdfBlockOverlay({
  blocks,
  sectionId,
  pageSize,
  pageBBox
}: {
  blocks: DeepPdfBlock[];
  sectionId: string;
  pageSize: PageSize | undefined;
  pageBBox: PdfBoundingBox | undefined;
}) {
  if (blocks.length === 0) {
    return null;
  }

  const coordinateBase = getCoordinateBase(blocks, pageSize, pageBBox);
  return (
    <div className="pdf-block-overlay" data-section-id={sectionId}>
      {blocks.map((block) => {
        if (!block.bbox) {
          return null;
        }
        const targetSectionId = block.sectionId || sectionId;
        const [x1, y1, x2, y2] = block.bbox;
        const left = ((x1 - coordinateBase.xMin) / coordinateBase.width) * 100;
        const top = ((y1 - coordinateBase.yMin) / coordinateBase.height) * 100;
        const width = ((x2 - x1) / coordinateBase.width) * 100;
        const height = ((y2 - y1) / coordinateBase.height) * 100;
        return (
          <button
            aria-label="Focus parsed section"
            className="pdf-block-highlight"
            key={`${targetSectionId}-${block.id}`}
            onClick={(event) => {
              event.stopPropagation();
              if (!targetSectionId) {
                return;
              }
              void chrome.runtime
                .sendMessage({ type: "LEARN_VIEWER_FOCUS_PDF_SECTION", sectionId: targetSectionId })
                .catch(() => undefined);
            }}
            title={block.text.slice(0, 180)}
            style={{
              left: `${clampPercent(left)}%`,
              top: `${clampPercent(top)}%`,
              width: `${clampPercent(width)}%`,
              height: `${clampPercent(height)}%`
            }}
          />
        );
      })}
    </div>
  );
}

function getCoordinateBase(
  blocks: DeepPdfBlock[],
  pageSize: PageSize | undefined,
  pageBBox: PdfBoundingBox | undefined
): CoordinateBase {
  const values = blocks.flatMap((block) => block.bbox ?? []);
  const max = Math.max(...values, 1);
  if (max <= 1) {
    return { xMin: 0, yMin: 0, width: 1, height: 1 };
  }

  if (pageSize) {
    if (pageBBox && isFullPageBBox(pageBBox, blocks, pageSize)) {
      const [x1, y1, x2, y2] = pageBBox;
      const width = Math.max(1, x2 - x1);
      const height = Math.max(1, y2 - y1);
      return { xMin: x1, yMin: y1, width, height };
    }
    return { xMin: 0, yMin: 0, width: pageSize.width, height: pageSize.height };
  }

  if (pageBBox) {
    const [x1, y1, x2, y2] = pageBBox;
    const width = Math.max(1, x2 - x1);
    const height = Math.max(1, y2 - y1);
    return { xMin: x1, yMin: y1, width, height };
  }

  const maxX = Math.max(...blocks.map((block) => block.bbox?.[2] ?? 1), 1);
  const maxY = Math.max(...blocks.map((block) => block.bbox?.[3] ?? 1), 1);
  return { xMin: 0, yMin: 0, width: maxX, height: maxY };
}

function isFullPageBBox(pageBBox: PdfBoundingBox, blocks: DeepPdfBlock[], pageSize: PageSize): boolean {
  const [x1, y1, x2, y2] = pageBBox;
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) {
    return false;
  }

  const maxBlockX = Math.max(...blocks.map((block) => block.bbox?.[2] ?? 0), 0);
  const maxBlockY = Math.max(...blocks.map((block) => block.bbox?.[3] ?? 0), 0);
  const hasPageMargin = width > maxBlockX * 1.02 || height > maxBlockY * 1.02;
  const pageAspect = pageSize.width / Math.max(1, pageSize.height);
  const bboxAspect = width / height;
  const aspectDelta = Math.abs(pageAspect - bboxAspect) / Math.max(pageAspect, bboxAspect);
  return hasPageMargin && aspectDelta < 0.08;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function getPdfTitle(source: string): string {
  try {
    const url = new URL(source);
    const path = decodeURIComponent(url.pathname);
    return path.split("/").filter(Boolean).pop() || "PDF document";
  } catch {
    return source || "PDF document";
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

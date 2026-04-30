import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { ContentRequest, ContentResponse } from "../shared/types";
import "./styles.css";

GlobalWorkerOptions.workerSrc = workerSrc;

type ViewerState = "landing" | "loading" | "ready" | "error";

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
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (version !== renderingRef.current) return;

        wrapper.appendChild(canvas);
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
            </div>
          ))}
        </div>
      </div>
    </div>
  );
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

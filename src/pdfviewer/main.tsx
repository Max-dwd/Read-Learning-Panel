import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { ContentRequest, ContentResponse, DeepPdfBlock, PdfBoundingBox, PdfPolygon } from "../shared/types";
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
        const geometry = getBlockGeometry(block, coordinateBase);
        const blockType = formatBlockType(block.type);
        const hoverMarkdown = getBlockHoverMarkdown(block);
        const hoverText = markdownToPlainText(hoverMarkdown);
        return (
          <button
            aria-label={`Focus parsed ${blockType} block`}
            className={`pdf-block-highlight pdf-block-highlight--${getBlockTypeTone(block.type)}`}
            data-block-type={blockType}
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
            title={`${blockType}: ${hoverText || block.text.slice(0, 180)}`}
            style={{
              left: `${clampPercent(geometry.left)}%`,
              top: `${clampPercent(geometry.top)}%`,
              width: `${clampPercent(geometry.width)}%`,
              height: `${clampPercent(geometry.height)}%`
            }}
          >
            <span className="pdf-block-highlight-frame" style={{ clipPath: geometry.clipPath }} />
            <span className="pdf-block-hover-card">
              <span className="pdf-block-type-label">{blockType}</span>
              {hoverMarkdown && <span className="pdf-block-caption-label">{renderHoverMarkdown(hoverMarkdown)}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function formatBlockType(type: string): string {
  return type.trim() || "Text";
}

function getBlockHoverMarkdown(block: DeepPdfBlock): string {
  const text = cleanHoverMarkdown(block.caption || block.text);
  if (!text || text === block.type) {
    return "";
  }
  return text;
}

function cleanHoverMarkdown(text: string): string {
  return stripImageMarkdown(text)
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripImageMarkdown(text: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf("![", cursor);
    if (start === -1) {
      output += text.slice(cursor);
      break;
    }

    output += text.slice(cursor, start);
    const altEnd = findClosingBracket(text, start + 2, "[", "]");
    if (altEnd === -1 || text[altEnd + 1] !== "(") {
      output += "![";
      cursor = start + 2;
      continue;
    }

    const urlEnd = findClosingBracket(text, altEnd + 2, "(", ")");
    if (urlEnd === -1) {
      output += "![";
      cursor = start + 2;
      continue;
    }

    cursor = urlEnd + 1;
  }

  return output;
}

function findClosingBracket(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function renderHoverMarkdown(markdown: string): React.ReactNode {
  return markdown.split(/\n/).map((line, index) => {
    const normalizedLine = line.trim();
    if (!normalizedLine) {
      return <br key={`br-${index}`} />;
    }

    const listMatch = normalizedLine.match(/^[-*]\s+(.+)$/);
    return (
      <span className={listMatch ? "pdf-block-markdown-line list" : "pdf-block-markdown-line"} key={`${index}-${normalizedLine}`}>
        {listMatch ? renderInlineMarkdown(listMatch[1]) : renderInlineMarkdown(normalizedLine)}
      </span>
    );
  });
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    const token = match[0];
    const key = `${match.index}-${token}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\([^)]+\)$/);
      nodes.push(<span className="pdf-block-markdown-link" key={key}>{link?.[1] ?? token}</span>);
    }

    cursor = match.index + token.length;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

function getBlockTypeTone(type: string): string {
  const normalized = type.replace(/[\s_-]+/g, "").toLowerCase();
  if (/sectionheader|heading|title|header/.test(normalized)) {
    return "heading";
  }
  if (/listgroup|listitem|list/.test(normalized)) {
    return "list";
  }
  if (/table|form/.test(normalized)) {
    return "table";
  }
  if (/figure|picture|image|caption/.test(normalized)) {
    return "figure";
  }
  if (/equation|formula|code/.test(normalized)) {
    return "equation";
  }
  if (/text|paragraph|body|span|line/.test(normalized)) {
    return "text";
  }
  return "other";
}

function getCoordinateBase(
  blocks: DeepPdfBlock[],
  pageSize: PageSize | undefined,
  pageBBox: PdfBoundingBox | undefined
): CoordinateBase {
  const values = blocks.flatMap((block) => [
    ...(block.bbox ?? []),
    ...(block.polygon?.flatMap((point) => point) ?? [])
  ]);
  const max = Math.max(...values, 1);
  if (max <= 1) {
    // Normalized [0,1] coordinates
    return { xMin: 0, yMin: 0, width: 1, height: 1 };
  }

  // Always prefer pageBBox: it is guaranteed to be in the same coordinate
  // system as the block bboxes (both come from Datalab).  Using pageSize
  // (pdf.js viewport points at 72 DPI) mixes coordinate systems and causes
  // visible offset when Datalab uses a different rendering resolution.
  if (pageBBox) {
    const [x1, y1, x2, y2] = pageBBox;
    const width = Math.max(1, x2 - x1);
    const height = Math.max(1, y2 - y1);
    return { xMin: x1, yMin: y1, width, height };
  }

  // Fallback: scale Datalab coordinates to match the pdf.js page dimensions.
  // This works when both happen to use the same DPI (most common case).
  if (pageSize) {
    return { xMin: 0, yMin: 0, width: pageSize.width, height: pageSize.height };
  }

  // Last resort: infer the coordinate space from the blocks themselves.
  const maxX = Math.max(...blocks.map((block) => block.bbox?.[2] ?? 1), 1);
  const maxY = Math.max(...blocks.map((block) => block.bbox?.[3] ?? 1), 1);
  return { xMin: 0, yMin: 0, width: maxX, height: maxY };
}

function getBlockGeometry(block: DeepPdfBlock, coordinateBase: CoordinateBase) {
  const polygon = block.polygon?.length ? block.polygon : null;
  const bbox = polygonToBbox(polygon) ?? block.bbox;
  if (!bbox) {
    return { left: 0, top: 0, width: 0, height: 0, clipPath: undefined };
  }

  const [x1, y1, x2, y2] = bbox;
  const left = ((x1 - coordinateBase.xMin) / coordinateBase.width) * 100;
  const top = ((y1 - coordinateBase.yMin) / coordinateBase.height) * 100;
  const width = ((x2 - x1) / coordinateBase.width) * 100;
  const height = ((y2 - y1) / coordinateBase.height) * 100;

  if (!polygon || width <= 0 || height <= 0) {
    return { left, top, width, height, clipPath: undefined };
  }

  const points = polygon.map(([x, y]) => {
    const pointX = (((x - coordinateBase.xMin) / coordinateBase.width) * 100 - left) / width * 100;
    const pointY = (((y - coordinateBase.yMin) / coordinateBase.height) * 100 - top) / height * 100;
    return `${clampPercent(pointX)}% ${clampPercent(pointY)}%`;
  });

  return {
    left,
    top,
    width,
    height,
    clipPath: `polygon(${points.join(", ")})`
  };
}

function polygonToBbox(polygon: PdfPolygon | null): PdfBoundingBox | undefined {
  if (!polygon || polygon.length === 0) {
    return undefined;
  }
  const xs = polygon.map((point) => point[0]);
  const ys = polygon.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
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

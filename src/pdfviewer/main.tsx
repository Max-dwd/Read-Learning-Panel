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
type DragSelection = {
  page: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  mode: "image" | "structure";
  add: boolean;
  isDragging: boolean;
};
type PdfSelectionPayload = {
  text: string;
  imageDataUrl?: string;
};

const PDF_PAGE_SECTION_PREFIX = "pdf-page-";

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
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(() => new Set());
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const renderingRef = useRef(0);
  const pageCountRef = useRef(0);
  const highlightedBlocksRef = useRef<DeepPdfBlock[]>([]);
  const selectedBlockIdsRef = useRef<Set<string>>(new Set());
  const selectionTextRef = useRef("");
  const selectionImageDataUrlRef = useRef("");
  const blockDragDidSelectRef = useRef(false);

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

  useEffect(() => {
    highlightedBlocksRef.current = highlightedBlocks;
  }, [highlightedBlocks]);

  useEffect(() => {
    selectedBlockIdsRef.current = selectedBlockIds;
  }, [selectedBlockIds]);

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
        const selectedBlocks = formatSelectedBlockReference(highlightedBlocksRef.current, selectedBlockIdsRef.current);
        const selection = selectedBlocks || selectionTextRef.current || window.getSelection()?.toString().trim() || "";
        sendResponse({ ok: true, selection, selectionImageDataUrl: selection ? selectionImageDataUrlRef.current : undefined });
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
        const nextBlocks = request.blocks.filter((block) => block.bbox);
        const nextBlockIds = new Set(nextBlocks.map(getBlockKey));
        setHighlightedSectionId(request.sectionId);
        setHighlightedBlocks(nextBlocks);
        setHighlightedPageBboxes(request.pageBboxes ?? {});
        setSelectedBlockIds((selectedIds) => {
          const next = new Set([...selectedIds].filter((id) => nextBlockIds.has(id)));
          selectedBlockIdsRef.current = next;
          if (next.size === 0) {
            selectionTextRef.current = "";
            selectionImageDataUrlRef.current = "";
          }
          return next;
        });
        const firstPage = request.blocks.find((block) => block.bbox)?.page;
        if (firstPage) {
          scrollToPageRef.current(firstPage);
        }
        sendResponse({ ok: true });
        return false;
      }

      if (request.type === "LEARN_PANEL_REMOVE_PDF_SELECTION_REFERENCE") {
        const blocks = highlightedBlocksRef.current;
        const nextSelectedIds = removeSelectedBlockReference(blocks, selectedBlockIdsRef.current, request.referenceLabel);
        applySelectedBlockIds(nextSelectedIds);
        selectionImageDataUrlRef.current = "";
        selectionTextRef.current = formatSelectedBlockReference(blocks, nextSelectedIds);
        syncPdfSelectionToPanel(blocks, getSelectionSectionId(blocks, nextSelectedIds, highlightedSectionId), {
          text: selectionTextRef.current
        });
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

  function handleBlockClick(block: DeepPdfBlock, targetSectionId: string, event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (blockDragDidSelectRef.current) {
      return;
    }
    const blockKey = getBlockKey(block);
    const addToSelection = event.metaKey || event.ctrlKey || event.shiftKey;
    const selectedOnPage = filterSelectedIdsToPage(selectedBlockIdsRef.current, block.page, highlightedBlocks);
    const blockIsSelected = selectedOnPage.has(blockKey);
    const nextSelectedIds = new Set(addToSelection || blockIsSelected ? selectedOnPage : []);
    if (blockIsSelected) {
      nextSelectedIds.delete(blockKey);
    } else {
      nextSelectedIds.add(blockKey);
    }
    selectionImageDataUrlRef.current = "";
    selectionTextRef.current = formatSelectedBlockReference(highlightedBlocks, nextSelectedIds);
    applySelectedBlockIds(nextSelectedIds);
    syncPdfSelectionToPanel(highlightedBlocks, getSelectionSectionId(highlightedBlocks, nextSelectedIds, targetSectionId), {
      text: selectionTextRef.current
    });

    if (targetSectionId) {
      void chrome.runtime
        .sendMessage({ type: "LEARN_VIEWER_FOCUS_PDF_SECTION", sectionId: targetSectionId })
        .catch(() => undefined);
    }
  }

  function handleBlockContextMenu(block: DeepPdfBlock, targetSectionId: string, event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    const blockKey = getBlockKey(block);
    const currentSelectedIds = selectedBlockIdsRef.current;
    const currentPageIds = filterSelectedIdsToPage(currentSelectedIds, block.page, highlightedBlocks);
    const nextSelectedIds = currentPageIds.has(blockKey) ? currentPageIds : new Set([blockKey]);
    const quote = formatSelectedBlockReference(highlightedBlocks, nextSelectedIds);
    selectionImageDataUrlRef.current = "";
    selectionTextRef.current = quote;
    applySelectedBlockIds(nextSelectedIds);

    if (targetSectionId && quote) {
      void chrome.runtime
        .sendMessage({ type: "LEARN_VIEWER_USE_PDF_SELECTION", sectionId: targetSectionId, selection: quote })
        .catch(() => undefined);
    }
  }

  function beginBlockDragSelection(page: number, event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !pageRefs.current.get(page)?.querySelector("canvas")) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, a")) {
      return;
    }

    const point = getPointerPointOnPage(page, event);
    if (!point) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const mode = event.metaKey ? "structure" : "image";
    setDragSelection({
      page,
      startX: point.x,
      startY: point.y,
      endX: point.x,
      endY: point.y,
      mode,
      add: mode === "structure" && (event.ctrlKey || event.shiftKey),
      isDragging: false
    });
  }

  function updateBlockDragSelection(page: number, event: React.PointerEvent<HTMLDivElement>) {
    if (!dragSelection || dragSelection.page !== page) {
      return;
    }
    const point = getPointerPointOnPage(page, event);
    if (!point) {
      return;
    }
    const moved = Math.abs(point.x - dragSelection.startX) > 0.4 || Math.abs(point.y - dragSelection.startY) > 0.4;
    setDragSelection((selection) =>
      selection && selection.page === page
        ? { ...selection, endX: point.x, endY: point.y, isDragging: selection.isDragging || moved }
        : selection
    );
  }

  function finishBlockDragSelection(page: number, event: React.PointerEvent<HTMLDivElement>) {
    if (!dragSelection || dragSelection.page !== page) {
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    const point = getPointerPointOnPage(page, event);
    const selection = point
      ? {
        ...dragSelection,
        endX: point.x,
        endY: point.y,
        isDragging:
          dragSelection.isDragging ||
          Math.abs(point.x - dragSelection.startX) > 0.4 ||
          Math.abs(point.y - dragSelection.startY) > 0.4
      }
      : dragSelection;
    setDragSelection(null);

    if (!selection.isDragging) {
      if (!selection.add) {
        const nextSelectedIds = new Set<string>();
        applySelectedBlockIds(nextSelectedIds);
        selectionTextRef.current = "";
        selectionImageDataUrlRef.current = "";
        syncPdfSelectionToPanel(highlightedBlocks, highlightedSectionId, { text: "" });
      }
      return;
    }

    blockDragDidSelectRef.current = true;
    window.setTimeout(() => {
      blockDragDidSelectRef.current = false;
    }, 0);

    if (selection.mode === "structure") {
      const selectedOnPage = getBlocksIntersectingSelection(selection, highlightedBlocks, pageSizes[page], highlightedPageBboxes[page]);
      const nextSelectedIds = new Set(selection.add ? filterSelectedIdsToPage(selectedBlockIdsRef.current, page, highlightedBlocks) : []);
      selectedOnPage.forEach((block) => nextSelectedIds.add(getBlockKey(block)));
      const text = formatSelectedBlockReference(highlightedBlocks, nextSelectedIds);
      selectionTextRef.current = text;
      selectionImageDataUrlRef.current = "";
      applySelectedBlockIds(nextSelectedIds);
      syncPdfSelectionToPanel(
        highlightedBlocks,
        getSelectionSectionId(highlightedBlocks, nextSelectedIds, highlightedSectionId || `${PDF_PAGE_SECTION_PREFIX}${page}`),
        { text }
      );
      return;
    }

    const imageDataUrl = cropPageSelectionImage(pageRefs.current.get(selection.page), selection);
    const text = imageDataUrl ? `[Page ${page} | Selected image region]\nSelected PDF image region.` : "";
    selectionTextRef.current = text;
    selectionImageDataUrlRef.current = imageDataUrl ?? "";
    applySelectedBlockIds(new Set());
    syncPdfSelectionToPanel(highlightedBlocks, highlightedSectionId || `${PDF_PAGE_SECTION_PREFIX}${page}`, {
      text,
      imageDataUrl: imageDataUrl ?? undefined
    });
  }

  function cancelBlockDragSelection() {
    setDragSelection(null);
  }

  function applySelectedBlockIds(nextSelectedIds: Set<string>) {
    selectedBlockIdsRef.current = nextSelectedIds;
    setSelectedBlockIds(nextSelectedIds);
  }

  function getPointerPointOnPage(page: number, event: React.PointerEvent<HTMLDivElement>): { x: number; y: number } | null {
    const wrapper = pageRefs.current.get(page);
    if (!wrapper) {
      return null;
    }
    const rect = wrapper.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      x: clampPercent(((event.clientX - rect.left) / rect.width) * 100),
      y: clampPercent(((event.clientY - rect.top) / rect.height) * 100)
    };
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
              onPointerDown={(event) => beginBlockDragSelection(page, event)}
              onPointerMove={(event) => updateBlockDragSelection(page, event)}
              onPointerUp={(event) => finishBlockDragSelection(page, event)}
              onPointerCancel={cancelBlockDragSelection}
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
                selectedBlockIds={selectedBlockIds}
                onBlockClick={handleBlockClick}
                onBlockContextMenu={handleBlockContextMenu}
              />
              {dragSelection?.page === page && dragSelection.isDragging && (
                <span
                  className={`pdf-block-selection-rect ${dragSelection.mode === "structure" ? "structure" : "image"}`}
                  style={getSelectionRectStyle(dragSelection)}
                />
              )}
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
  pageBBox,
  selectedBlockIds,
  onBlockClick,
  onBlockContextMenu
}: {
  blocks: DeepPdfBlock[];
  sectionId: string;
  pageSize: PageSize | undefined;
  pageBBox: PdfBoundingBox | undefined;
  selectedBlockIds: Set<string>;
  onBlockClick: (block: DeepPdfBlock, targetSectionId: string, event: React.MouseEvent<HTMLButtonElement>) => void;
  onBlockContextMenu: (block: DeepPdfBlock, targetSectionId: string, event: React.MouseEvent<HTMLButtonElement>) => void;
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
        const selected = selectedBlockIds.has(getBlockKey(block));
        return (
          <button
            aria-label={`Focus parsed ${blockType} block`}
            className={`pdf-block-highlight pdf-block-highlight--${getBlockTypeTone(block.type)}${selected ? " selected" : ""}`}
            data-block-type={blockType}
            key={`${targetSectionId}-${block.id}`}
            onClick={(event) => onBlockClick(block, targetSectionId, event)}
            onContextMenu={(event) => onBlockContextMenu(block, targetSectionId, event)}
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

function getBlockKey(block: DeepPdfBlock): string {
  return `${block.page}:${block.id}`;
}

function formatSelectedBlockReference(blocks: DeepPdfBlock[], selectedBlockIds: Set<string>): string {
  if (selectedBlockIds.size === 0) {
    return "";
  }

  const referenceLabels = buildBlockReferenceLabels(blocks);
  return blocks
    .filter((block) => selectedBlockIds.has(getBlockKey(block)))
    .sort((a, b) => a.page - b.page || compareBbox(a.bbox, b.bbox))
    .map((block) => {
      const content = cleanHoverMarkdown(block.text || block.caption || block.type);
      const text = content.length > 1200 ? `${content.slice(0, 1200)}...` : content;
      return `[${referenceLabels.get(getBlockKey(block)) ?? `Page ${block.page} | ${formatBlockType(block.type)}`}]\n${text}`;
    })
    .join("\n\n");
}

function buildBlockReferenceLabels(blocks: DeepPdfBlock[]): Map<string, string> {
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  [...blocks]
    .sort((a, b) => a.page - b.page || compareBbox(a.bbox, b.bbox))
    .forEach((block) => {
      const blockType = formatBlockType(block.type);
      const countKey = `${block.page}:${blockType.toLowerCase()}`;
      const typeIndex = (counts.get(countKey) ?? 0) + 1;
      counts.set(countKey, typeIndex);
      labels.set(getBlockKey(block), `Page ${block.page} | ${blockType} ${typeIndex}`);
    });
  return labels;
}

function filterSelectedIdsToPage(selectedBlockIds: Set<string>, page: number, blocks: DeepPdfBlock[]): Set<string> {
  const pageBlockIds = new Set(blocks.filter((block) => block.page === page).map(getBlockKey));
  return new Set([...selectedBlockIds].filter((id) => pageBlockIds.has(id)));
}

function removeSelectedBlockReference(blocks: DeepPdfBlock[], selectedBlockIds: Set<string>, referenceLabel: string): Set<string> {
  const targetLabel = normalizePdfReferenceLabel(referenceLabel);
  const labels = buildBlockReferenceLabels(blocks);
  return new Set(
    [...selectedBlockIds].filter((id) => normalizePdfReferenceLabel(labels.get(id) ?? "") !== targetLabel)
  );
}

function normalizePdfReferenceLabel(label: string): string {
  return label.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/\s+x\d+$/i, "");
}

function syncPdfSelectionToPanel(blocks: DeepPdfBlock[], sectionId: string, selection: PdfSelectionPayload): void {
  if (!sectionId) {
    return;
  }

  const quote = selection.text;
  void chrome.runtime
    .sendMessage({
      type: "LEARN_VIEWER_PDF_SELECTION_CHANGED",
      sectionId,
      selection: quote,
      selectionImageDataUrl: selection.imageDataUrl
    })
    .catch(() => undefined);
}

function getSelectionSectionId(blocks: DeepPdfBlock[], selectedBlockIds: Set<string>, fallbackSectionId: string): string {
  return blocks.find((block) => selectedBlockIds.has(getBlockKey(block)))?.sectionId || fallbackSectionId;
}

function compareBbox(a: PdfBoundingBox | undefined, b: PdfBoundingBox | undefined): number {
  if (!a || !b) {
    return 0;
  }
  return a[1] - b[1] || a[0] - b[0];
}

function getSelectionRectStyle(selection: DragSelection): React.CSSProperties {
  const left = Math.min(selection.startX, selection.endX);
  const top = Math.min(selection.startY, selection.endY);
  const width = Math.abs(selection.endX - selection.startX);
  const height = Math.abs(selection.endY - selection.startY);
  return {
    left: `${clampPercent(left)}%`,
    top: `${clampPercent(top)}%`,
    width: `${clampPercent(width)}%`,
    height: `${clampPercent(height)}%`
  };
}

function getBlocksIntersectingSelection(
  selection: DragSelection,
  blocks: DeepPdfBlock[],
  pageSize: PageSize | undefined,
  pageBBox: PdfBoundingBox | undefined
): DeepPdfBlock[] {
  const pageBlocks = blocks.filter((block) => block.page === selection.page && block.bbox);
  if (pageBlocks.length === 0) {
    return [];
  }

  const coordinateBase = getCoordinateBase(pageBlocks, pageSize, pageBBox);
  const selectionRect = {
    left: Math.min(selection.startX, selection.endX),
    top: Math.min(selection.startY, selection.endY),
    right: Math.max(selection.startX, selection.endX),
    bottom: Math.max(selection.startY, selection.endY)
  };

  return pageBlocks.filter((block) => {
    const geometry = getBlockGeometry(block, coordinateBase);
    const blockRect = {
      left: geometry.left,
      top: geometry.top,
      right: geometry.left + geometry.width,
      bottom: geometry.top + geometry.height
    };
    return rectanglesIntersect(selectionRect, blockRect);
  });
}

function rectanglesIntersect(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function cropPageSelectionImage(wrapper: HTMLDivElement | undefined, selection: DragSelection): string | null {
  const canvas = wrapper?.querySelector("canvas");
  if (!canvas) {
    return null;
  }

  const left = Math.min(selection.startX, selection.endX);
  const top = Math.min(selection.startY, selection.endY);
  const width = Math.abs(selection.endX - selection.startX);
  const height = Math.abs(selection.endY - selection.startY);
  if (width < 0.5 || height < 0.5) {
    return null;
  }

  const cropCanvas = document.createElement("canvas");
  const context = cropCanvas.getContext("2d");
  if (!context) {
    return null;
  }

  const sx = Math.max(0, Math.floor((left / 100) * canvas.width));
  const sy = Math.max(0, Math.floor((top / 100) * canvas.height));
  const sw = Math.min(canvas.width - sx, Math.ceil((width / 100) * canvas.width));
  const sh = Math.min(canvas.height - sy, Math.ceil((height / 100) * canvas.height));
  if (sw <= 0 || sh <= 0) {
    return null;
  }

  cropCanvas.width = sw;
  cropCanvas.height = sh;
  context.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const dataUrl = cropCanvas.toDataURL("image/jpeg", 0.82);
  cropCanvas.width = 0;
  cropCanvas.height = 0;
  return dataUrl;
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

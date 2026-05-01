import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import katex from "katex";
import {
  clearAnalysisSessions,
  deleteAnalysisSession,
  loadAnalysisSession,
  saveAnalysisSession,
  type AnalysisSession,
  type SectionAnalysisSessionState
} from "../shared/analysisSession";
import {
  clearHistory,
  deleteHistoryEntry,
  findHistoryEntry,
  HISTORY_EXPORT_SCHEMA,
  HISTORY_EXPORT_VERSION,
  importHistoryEntry,
  loadHistory,
  saveHistoryEntry,
  updateHistoryScrollPos,
  type HistoryEntry,
  type HistoryExportPayload
} from "../shared/history";
import {
  analyzeArticleProgressively,
  analyzeDeepPdfProgressively,
  analyzePdfProgressively,
  answerDeepPdfVisionQuestion,
  answerPdfQuestion,
  answerSectionQuestion,
  generatePdfGuide,
  type AnalysisProgressEvent
} from "../shared/model";
import { parsePdfWithDatalab } from "../shared/datalab";
import {
  getDeepPdfBlocksForViewer,
  loadSavedDeepPdfBoundingBoxesVisible,
  loadSavedDeepPdfParse,
  saveDeepPdfBoundingBoxesVisible,
  saveDeepPdfParse
} from "../shared/deepPdfStorage";
import {
  getPdfSourceUrl,
  getPdfTargetPageFromUrl,
  loadPdfDocument,
  parsePdfPageRange,
  renderPdfPage,
  renderPdfPages,
  type LoadedPdfDocument,
  type PdfPageImage
} from "../shared/pdf";
import { getActiveApiKey, getActiveDeepPdfSummaryApiKey, getActivePdfApiKey, loadSettings } from "../shared/settings";
import type {
  AnalysisResult,
  ContentRequest,
  ContentResponse,
  DeepPdfBlock,
  DeepPdfParseResult,
  DeepPdfSection,
  ExtractedArticle,
  PdfAnalysisMode,
  PdfGuideResult,
  PdfSelectionReference,
  SectionFollowUp,
  Settings
} from "../shared/types";
import "katex/dist/katex.min.css";
import "./styles.css";

const PDF_GUIDE_STORAGE_PREFIX = "learnPanelPdfGuide_";

async function savePdfGuide(sourceUrl: string, guide: PdfGuideResult): Promise<void> {
  const key = PDF_GUIDE_STORAGE_PREFIX + sourceUrl;
  await chrome.storage.local.set({ [key]: guide });
}

async function loadSavedPdfGuide(sourceUrl: string): Promise<PdfGuideResult | null> {
  const key = PDF_GUIDE_STORAGE_PREFIX + sourceUrl;
  const stored = await chrome.storage.local.get(key);
  const guide = stored[key];
  return guide && Array.isArray(guide.pages) ? guide : null;
}

type LoadState = "idle" | "loading" | "ready" | "error";
type AnalyzeState = "idle" | "running" | "done" | "error";
type SectionAnalyzeState = "queued" | "running" | "done" | "error";
type ViewMode = "reader" | "history";
type DocumentMode = "article" | "pdf";
type PdfQuestionState = "idle" | "running" | "error";
type PdfPreviewState = "idle" | "rendering" | "ready" | "error";
type DeepPdfParseState = "idle" | "running" | "done" | "error";

function isCustomPdfViewerUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "chrome-extension:" && u.pathname.endsWith("/pdfviewer.html");
  } catch {
    return false;
  }
}

function getCustomViewerUrl(pdfSourceUrl: string, options: { deepRange?: string } = {}): string {
  const url = new URL(chrome.runtime.getURL("dist/pdfviewer.html"));
  url.searchParams.set("src", pdfSourceUrl);
  if (options.deepRange !== undefined) {
    url.searchParams.set("deepRange", options.deepRange);
  }
  return url.toString();
}
type PdfAnswer = {
  question: string;
  answer: string;
  pages: number[];
  targetPage: number | null;
  createdAt: number;
};

const PDF_PAGE_SECTION_PREFIX = "pdf-page-";

type PageCacheEntry = {
  article: ExtractedArticle;
  analysis: AnalysisResult | null;
  followUps: Record<string, SectionFollowUp[]>;
  analysisState?: AnalyzeState;
  sectionAnalyzeState?: Record<string, SectionAnalyzeState>;
  sectionAnalyzeErrors?: Record<string, string>;
  analysisError?: string;
  rawError?: string;
  scrollPos?: number;
};

function App() {
  const [article, setArticle] = useState<ExtractedArticle | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState("");
  const [analysisState, setAnalysisState] = useState<AnalyzeState>("idle");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState("");
  const [rawError, setRawError] = useState("");
  const [sectionAnalyzeState, setSectionAnalyzeState] = useState<Record<string, SectionAnalyzeState>>({});
  const [sectionAnalyzeErrors, setSectionAnalyzeErrors] = useState<Record<string, string>>({});
  const [followUps, setFollowUps] = useState<Record<string, SectionFollowUp[]>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("reader");
  const [documentMode, setDocumentMode] = useState<DocumentMode>("article");
  const [pdfDocument, setPdfDocument] = useState<LoadedPdfDocument | null>(null);
  const [pdfPageRange, setPdfPageRange] = useState("all");
  const [pdfTargetPage, setPdfTargetPage] = useState("1");
  const [pdfQuestion, setPdfQuestion] = useState("");
  const [pdfSelectionQuote, setPdfSelectionQuote] = useState("");
  const [pdfSelectionImageDataUrl, setPdfSelectionImageDataUrl] = useState("");
  const [pdfQuestionState, setPdfQuestionState] = useState<PdfQuestionState>("idle");
  const [pdfError, setPdfError] = useState("");
  const [pdfRawError, setPdfRawError] = useState("");
  const [pdfAnswers, setPdfAnswers] = useState<PdfAnswer[]>([]);
  const [pdfGuide, setPdfGuide] = useState<PdfGuideResult | null>(null);
  const [pdfGuideState, setPdfGuideState] = useState<PdfQuestionState>("idle");
  const [pdfGuideError, setPdfGuideError] = useState("");
  const [pdfGuideRawError, setPdfGuideRawError] = useState("");
  const [pdfPageImages, setPdfPageImages] = useState<PdfPageImage[]>([]);
  const [pdfPreviewState, setPdfPreviewState] = useState<PdfPreviewState>("idle");
  const [pdfPreviewError, setPdfPreviewError] = useState("");
  const [pdfAnalysisMode, setPdfAnalysisMode] = useState<PdfAnalysisMode>("visual");
  const [deepPdfParse, setDeepPdfParse] = useState<DeepPdfParseResult | null>(null);
  const [deepPdfParseState, setDeepPdfParseState] = useState<DeepPdfParseState>("idle");
  const [deepPdfParseStatus, setDeepPdfParseStatus] = useState("");
  const [deepPdfParseError, setDeepPdfParseError] = useState("");
  const [deepPdfParseRawError, setDeepPdfParseRawError] = useState("");
  const [activeDeepPdfSectionId, setActiveDeepPdfSectionId] = useState<string | null>(null);
  const [showAllDeepPdfBoundingBoxes, setShowAllDeepPdfBoundingBoxes] = useState(false);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [pendingQuestions, setPendingQuestions] = useState<Record<string, boolean>>({});
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>({});
  const [activeQuestionSectionId, setActiveQuestionSectionId] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [selectionQuote, setSelectionQuote] = useState("");
  const [followEnabled, setFollowEnabled] = useState(false);
  const [isInCustomViewer, setIsInCustomViewer] = useState(false);
  const [followedSectionId, setFollowedSectionId] = useState<string | null>(null);
  const [followedPdfPage, setFollowedPdfPage] = useState<number | null>(null);
  const [historyImportNotice, setHistoryImportNotice] = useState<{ type: "info" | "error"; text: string } | null>(null);
  const cacheRef = useRef(new Map<string, PageCacheEntry>());
  const historyImportInputRef = useRef<HTMLInputElement | null>(null);
  const pdfDocumentRef = useRef<LoadedPdfDocument | null>(null);
  const currentPageKeyRef = useRef("");
  const loadVersionRef = useRef(0);
  const pdfPreviewVersionRef = useRef(0);
  const analysisVersionRef = useRef(0);
  const analysisStateRef = useRef<AnalyzeState>("idle");
  const runningSectionIdRef = useRef<string | null>(null);
  const followEnabledRef = useRef(false);
  const currentArticleUrlRef = useRef<string | null>(null);
  const activeQuestionSectionIdRef = useRef<string | null>(null);
  const scrollSaveSuppressionTokenRef = useRef(0);
  const nextScrollSaveSuppressionTokenRef = useRef(1);
  const loadingScrollSuppressionTokenRef = useRef<number | null>(null);

  useEffect(() => {
    void loadActivePage();
    void loadSettings().then(setSettings);
    void refreshHistory();
  }, []);

  useEffect(() => {
    analysisStateRef.current = analysisState;
  }, [analysisState]);

  useEffect(() => {
    followEnabledRef.current = followEnabled;
  }, [followEnabled]);

  useEffect(() => {
    currentArticleUrlRef.current = article?.url ?? null;
  }, [article?.url]);

  useEffect(() => {
    activeQuestionSectionIdRef.current = activeQuestionSectionId;
  }, [activeQuestionSectionId]);

  useEffect(() => {
    const handleViewerMessage = (
      request: ContentRequest,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: ContentResponse) => void
    ) => {
      if (
        request.type !== "LEARN_VIEWER_FOCUS_PDF_SECTION" &&
        request.type !== "LEARN_VIEWER_USE_PDF_SELECTION" &&
        request.type !== "LEARN_VIEWER_PDF_SELECTION_CHANGED"
      ) {
        return false;
      }

      if (request.type === "LEARN_VIEWER_PDF_SELECTION_CHANGED") {
        if (request.selection && request.openQuestion) {
          setActiveQuestionSectionId(request.sectionId);
          setPdfSelectionQuote(request.selection);
          setPdfSelectionImageDataUrl(request.selectionImageDataUrl ?? "");
          requestAnimationFrame(() => scrollPanelToSection(request.sectionId));
        } else if (activeQuestionSectionIdRef.current === request.sectionId) {
          setPdfSelectionQuote(request.selection);
          setPdfSelectionImageDataUrl(request.selectionImageDataUrl ?? "");
        }
        sendResponse({ ok: true });
        return false;
      }

      setViewMode("reader");
      setPdfAnalysisMode("deep");
      setActiveDeepPdfSectionId(request.sectionId);
      if (request.type === "LEARN_VIEWER_USE_PDF_SELECTION") {
        setActiveQuestionSectionId(request.sectionId);
        setPdfSelectionQuote(request.selection);
        setPdfSelectionImageDataUrl(request.selectionImageDataUrl ?? "");
      }
      requestAnimationFrame(() => scrollPanelToSection(request.sectionId));
      sendResponse({ ok: true });
      return false;
    };

    chrome.runtime?.onMessage?.addListener(handleViewerMessage);
    return () => {
      chrome.runtime?.onMessage?.removeListener(handleViewerMessage);
    };
  }, []);

  useEffect(() => {
    if (!followEnabled || viewMode !== "reader" || loadState !== "ready") {
      return;
    }

    let cancelled = false;
    let syncing = false;
    let lastFollowedSection: string | null = null;
    let lastFollowedPage: number | null = null;

    const syncFollowTarget = async () => {
      if (cancelled || syncing) {
        return;
      }
      syncing = true;
      try {
        if (documentMode === "article" && activeTabId && article) {
          const response = await sendToTab(activeTabId, { type: "LEARN_PANEL_GET_ACTIVE_SECTION" });
          if (!cancelled && response.ok && "activeSectionId" in response && response.activeSectionId) {
            setFollowedPdfPage(null);
            setFollowedSectionId(response.activeSectionId);
            if (response.activeSectionId !== lastFollowedSection) {
              lastFollowedSection = response.activeSectionId;
              scrollPanelToSection(response.activeSectionId);
            }
          }
        }

        if (documentMode === "pdf" && pdfDocument && activeTabId) {
          let page: number;
          try {
            const response = await sendToViewer({ type: "LEARN_PANEL_GET_ACTIVE_PDF_PAGE" });
            if (response.ok && "activePage" in response) {
              page = Math.min(response.activePage, pdfDocument.pageCount);
            } else {
              const tab = await getActiveTab();
              page = Math.min(getPdfTargetPageFromUrl(tab.url), pdfDocument.pageCount);
            }
          } catch {
            const tab = await getActiveTab();
            page = Math.min(getPdfTargetPageFromUrl(tab.url), pdfDocument.pageCount);
          }
          if (!cancelled) {
            setFollowedSectionId(null);
            setFollowedPdfPage(page);
            setPdfTargetPage(String(page));
            if (page !== lastFollowedPage) {
              lastFollowedPage = page;
              scrollPanelToPdfPage(page);
            }
          }
        }
      } catch {
        // The active tab can change or reject messages while the panel is open.
      } finally {
        syncing = false;
      }
    };

    void syncFollowTarget();
    const intervalId = window.setInterval(() => void syncFollowTarget(), 700);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [followEnabled, viewMode, loadState, documentMode, activeTabId, article, pdfDocument]);

  useEffect(() => {
    let timeoutId: number;
    const handleScroll = () => {
      if (scrollSaveSuppressionTokenRef.current !== 0) {
        return;
      }
      if (viewMode === "reader" && currentPageKeyRef.current) {
        const cached = cacheRef.current.get(currentPageKeyRef.current);
        if (cached) {
          cached.scrollPos = window.scrollY;

          // Debounce saving to history
          window.clearTimeout(timeoutId);
          timeoutId = window.setTimeout(() => {
            if (article?.url) {
              void updateHistoryScrollPos(article.url, window.scrollY);
            }
          }, 500);
        }
      }
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.clearTimeout(timeoutId);
    };
  }, [viewMode, article?.url]);

  useEffect(() => {
    if (loadState !== "loading") {
      releaseLoadingScrollSaveSuppression();
    }

    if (viewMode === "reader" && loadState === "ready" && article) {
      const cached = cacheRef.current.get(currentPageKeyRef.current);
      if (cached && typeof cached.scrollPos === "number") {
        const restoreToken = beginScrollSaveSuppression();
        // Use a small delay to ensure DOM is fully rendered and layout is stable
        const restore = () => {
          window.scrollTo({ top: cached.scrollPos, behavior: "instant" });
        };
        restore();
        // Sometimes content changes height after initial render, try again
        requestAnimationFrame(restore);
        const restoreTimeout = window.setTimeout(restore, 50);
        const releaseTimeout = window.setTimeout(() => {
          releaseScrollSaveSuppression(restoreToken);
        }, 150);
        return () => {
          window.clearTimeout(restoreTimeout);
          window.clearTimeout(releaseTimeout);
          releaseScrollSaveSuppression(restoreToken);
        };
      }
    }
  }, [article, viewMode, loadState]);

  useEffect(() => {
    const handleActivated = () => {
      void loadActivePage();
    };
    const handleUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (tabId !== activeTabId) {
        return;
      }
      if (changeInfo.url) {
        const currentPdf = pdfDocumentRef.current;
        const nextPdfSource = getPdfSourceUrl(changeInfo.url);
        const nextDeepRange = getDeepPdfRangeFromViewerUrl(changeInfo.url);
        const currentDeepRange = currentPdf ? getDeepPdfRangeFromViewerUrl(currentPdf.url) : null;
        if (currentPdf && nextPdfSource === currentPdf.sourceUrl && nextDeepRange === currentDeepRange) {
          const nextPage = Math.min(getPdfTargetPageFromUrl(changeInfo.url), currentPdf.pageCount);
          const nextPdf = { ...currentPdf, url: changeInfo.url };
          pdfDocumentRef.current = nextPdf;
          setPdfDocument(nextPdf);
          if (followEnabledRef.current) {
            setPdfTargetPage(String(nextPage));
            setFollowedPdfPage(nextPage);
            requestAnimationFrame(() => scrollPanelToPdfPage(nextPage));
          }
          return;
        }

        saveCurrentScrollPosition();
        beginLoadingScrollSaveSuppression();
        setArticle(null);
        setAnalysis(null);
        setFollowUps({});
        setSectionAnalyzeState({});
        setSectionAnalyzeErrors({});
        setActiveQuestionSectionId(null);
        setAnalysisState("idle");
        setPdfDocument(null);
        pdfDocumentRef.current = null;
        setPdfAnswers([]);
        setPdfGuide(null);
        setPdfGuideState("idle");
        setPdfGuideError("");
        setPdfGuideRawError("");
        setPdfPageImages([]);
        setPdfPreviewState("idle");
        setPdfPreviewError("");
        setPdfAnalysisMode("visual");
        setDeepPdfParse(null);
        setDeepPdfParseState("idle");
        setDeepPdfParseStatus("");
        setDeepPdfParseError("");
        setDeepPdfParseRawError("");
        setActiveDeepPdfSectionId(null);
        setShowAllDeepPdfBoundingBoxes(false);
        setPdfError("");
        setPdfRawError("");
        setPdfQuestionState("idle");
        setFollowedSectionId(null);
        setFollowedPdfPage(null);
        setLoadState("loading");
      }
      if (changeInfo.status === "complete") {
        void loadActivePage();
      }
    };
    const handleFocusChanged = (windowId: number) => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) {
        void loadActivePage();
      }
    };

    chrome.tabs?.onActivated?.addListener(handleActivated);
    chrome.tabs?.onUpdated?.addListener(handleUpdated);
    chrome.windows?.onFocusChanged?.addListener(handleFocusChanged);
    return () => {
      chrome.tabs?.onActivated?.removeListener(handleActivated);
      chrome.tabs?.onUpdated?.removeListener(handleUpdated);
      chrome.windows?.onFocusChanged?.removeListener(handleFocusChanged);
    };
  }, [activeTabId]);

  const sectionAnalysis = useMemo(() => {
    const map = new Map<string, AnalysisResult["sections"][number]>();
    analysis?.sections.forEach((section) => map.set(section.id, section));
    return map;
  }, [analysis]);

  async function loadActivePage(force = false) {
    const loadVersion = ++loadVersionRef.current;
    saveCurrentScrollPosition();
    beginLoadingScrollSaveSuppression();
    setLoadState("loading");
    setLoadError("");

    try {
      const tab = await getActiveTab();
      setActiveTabId(tab.id);

      if (getPdfSourceUrl(tab.url) || isCustomPdfViewerUrl(tab.url)) {
        setDocumentMode("pdf");
        await loadActivePdf(tab.url ?? "", loadVersion, force);
        return;
      }

      setDocumentMode("article");
      setPdfDocument(null);
      pdfDocumentRef.current = null;
      setPdfError("");
      setPdfRawError("");
      setPdfQuestionState("idle");
      setPdfGuide(null);
      setPdfGuideState("idle");
      setPdfGuideError("");
      setPdfGuideRawError("");
      setPdfPageImages([]);
      setPdfPreviewState("idle");
      setPdfPreviewError("");
      setPdfAnalysisMode("visual");
      setDeepPdfParse(null);
      setDeepPdfParseState("idle");
      setDeepPdfParseStatus("");
      setDeepPdfParseError("");
      setDeepPdfParseRawError("");
      setActiveDeepPdfSectionId(null);
      setShowAllDeepPdfBoundingBoxes(false);
      setFollowedSectionId(null);
      setFollowedPdfPage(null);

      const optimisticKey = tab.url ? getPageKey(tab.url) : "";
      if (!force && optimisticKey === currentPageKeyRef.current && analysisStateRef.current === "running") {
        setLoadState("ready");
        return;
      }
      if (!force && optimisticKey) {
        const persistedSession = await loadAnalysisSession(optimisticKey);
        if (persistedSession) {
          applyAnalysisSession(persistedSession);
          return;
        }

        const cached = cacheRef.current.get(optimisticKey);
        if (cached) {
          applyPageCache(cached, optimisticKey);
          return;
        }
      }

      const response = await sendToTab(tab.id, { type: "LEARN_PANEL_GET_ARTICLE" });
      if (loadVersion !== loadVersionRef.current) {
        return;
      }
      if (!response.ok || !("article" in response)) {
        throw new Error(response.ok ? "Page did not return article data." : response.error);
      }

      const pageKey = getPageKey(response.article.url);
      const persistedSession = !force ? await loadAnalysisSession(pageKey) : null;
      if (persistedSession) {
        applyAnalysisSession(persistedSession);
        return;
      }

      const cached = !force ? cacheRef.current.get(pageKey) : null;
      if (cached) {
        applyPageCache(cached, pageKey);
        return;
      }

      const persisted = !force ? await findHistoryEntry(response.article.url) : null;
      if (persisted) {
        cacheRef.current.set(pageKey, {
          article: persisted.article,
          analysis: persisted.analysis,
          followUps: persisted.followUps,
          scrollPos: persisted.scrollPos
        });
        applyPage(persisted.article, persisted.analysis, pageKey);
        return;
      }

      cacheRef.current.set(pageKey, { article: response.article, analysis: null, followUps: {} });
      applyPage(response.article, null, pageKey);
    } catch (error) {
      if (loadVersion !== loadVersionRef.current) {
        return;
      }
      setLoadState("error");
      setLoadError((error as Error).message);
      requestAnimationFrame(() => {
        releaseLoadingScrollSaveSuppression();
      });
    }
  }

  async function loadActivePdf(tabUrl: string, loadVersion: number, force: boolean) {
    const inCustomViewer = isCustomPdfViewerUrl(tabUrl);
    setIsInCustomViewer(inCustomViewer);

    const currentPdf = pdfDocumentRef.current;
    if (!force && currentPdf?.url === tabUrl) {
      setPdfDocument(currentPdf);
      setLoadState("ready");
      if (showAllDeepPdfBoundingBoxes && deepPdfParse) {
        void showDeepPdfBoundingBoxesInViewer(deepPdfParse).catch(() => undefined);
      }
      return;
    }

    setArticle(null);
    setAnalysis(null);
    setFollowUps({});
    setSectionAnalyzeState({});
    setSectionAnalyzeErrors({});
    setAnalysisState("idle");
    setAnalysisError("");
    setRawError("");
    setPdfError("");
    setPdfRawError("");
    setPdfQuestionState("idle");
    setPdfGuide(null);
    setPdfGuideState("idle");
    setPdfGuideError("");
    setPdfGuideRawError("");
    setPdfPageImages([]);
    setPdfPreviewState("idle");
    setPdfPreviewError("");
    setPdfAnalysisMode("visual");
    setDeepPdfParse(null);
    setDeepPdfParseState("idle");
    setDeepPdfParseStatus("");
    setDeepPdfParseError("");
    setDeepPdfParseRawError("");
    setActiveDeepPdfSectionId(null);
    setShowAllDeepPdfBoundingBoxes(false);
    setFollowedSectionId(null);
    setFollowedPdfPage(null);
    currentPageKeyRef.current = tabUrl;

    // If not in custom viewer, show landing screen without loading the PDF
    if (!inCustomViewer) {
      setLoadState("ready");
      return;
    }

    if (!getPdfSourceUrl(tabUrl)) {
      setLoadState("ready");
      return;
    }

    const loadedPdf = await loadPdfDocument(tabUrl);
    if (loadVersion !== loadVersionRef.current) {
      return;
    }

    const targetPage = Math.min(getPdfTargetPageFromUrl(tabUrl), loadedPdf.pageCount);
    const pdfArticle = buildPdfArticle(loadedPdf);
    const pageKey = getPageKey(pdfArticle.url);
    pdfDocumentRef.current = loadedPdf;
    setPdfDocument(loadedPdf);
    const requestedDeepRange = getDeepPdfRangeFromViewerUrl(tabUrl);
    setPdfPageRange(requestedDeepRange ? fromDatalabPageRangeLabel(requestedDeepRange) : "all");
    setPdfTargetPage(String(targetPage));
    setPdfQuestion("");
    setPdfAnswers([]);

    // Restore saved guide for this PDF
    const savedGuide = await loadSavedPdfGuide(loadedPdf.sourceUrl);
    setPdfGuide(savedGuide);
    setPdfGuideState("idle");
    setPdfGuideError("");
    setPdfGuideRawError("");
    const savedDeepParse = await loadSavedDeepPdfParse(loadedPdf.sourceUrl, requestedDeepRange ?? "");
    const savedDeepPdfBoundingBoxesVisible = savedDeepParse
      ? await loadSavedDeepPdfBoundingBoxesVisible(savedDeepParse.sourceUrl, savedDeepParse.pageRange)
      : false;
    setDeepPdfParse(savedDeepParse);
    setDeepPdfParseState(savedDeepParse ? "done" : "idle");
    setDeepPdfParseStatus(savedDeepParse ? "Loaded saved deep parse." : "");

    if (savedDeepParse && (requestedDeepRange !== null || savedDeepPdfBoundingBoxesVisible)) {
      await applyDeepPdfParse(savedDeepParse, { restoreSaved: !force });
      void renderPdfPreview(loadedPdf);
      return;
    }

    const persistedSession = !force ? await loadAnalysisSession(pageKey) : null;
    if (persistedSession) {
      applyAnalysisSession(persistedSession);
    } else {
      const cached = !force ? cacheRef.current.get(pageKey) : null;
      if (cached) {
        applyPageCache(cached, pageKey);
      } else {
        const persisted = !force ? await findHistoryEntry(pdfArticle.url) : null;
        if (persisted) {
          cacheRef.current.set(pageKey, {
            article: persisted.article,
            analysis: persisted.analysis,
            followUps: persisted.followUps,
            scrollPos: persisted.scrollPos
          });
          applyPage(persisted.article, persisted.analysis, pageKey);
        } else {
          cacheRef.current.set(pageKey, { article: pdfArticle, analysis: null, followUps: {} });
          applyPage(pdfArticle, null, pageKey);
        }
      }
    }

    void renderPdfPreview(loadedPdf);
  }

  async function renderPdfPreview(loadedPdf: LoadedPdfDocument) {
    const previewVersion = ++pdfPreviewVersionRef.current;
    setPdfPreviewState("rendering");
    setPdfPreviewError("");
    setPdfPageImages([]);

    try {
      for (let page = 1; page <= loadedPdf.pageCount; page += 1) {
        const image = await renderPdfPage(loadedPdf.pdf, page);
        if (previewVersion !== pdfPreviewVersionRef.current || pdfDocumentRef.current?.url !== loadedPdf.url) {
          return;
        }
        setPdfPageImages((images) => [...images, image]);
      }
      setPdfPreviewState("ready");
    } catch (error) {
      if (previewVersion !== pdfPreviewVersionRef.current) {
        return;
      }
      setPdfPreviewState("error");
      setPdfPreviewError((error as Error).message);
    }
  }

  async function refreshPage() {
    setViewMode("reader");
    await loadActivePage(true);
  }

  async function refreshHistory() {
    setHistory(await loadHistory());
  }

  function saveCurrentScrollPosition() {
    if (!currentPageKeyRef.current) {
      return;
    }
    const cached = cacheRef.current.get(currentPageKeyRef.current);
    if (!cached) {
      return;
    }
    const scrollPos = window.scrollY;
    cached.scrollPos = scrollPos;
    const currentUrl = currentArticleUrlRef.current;
    if (currentUrl) {
      void updateHistoryScrollPos(currentUrl, scrollPos);
    }
  }

  function beginScrollSaveSuppression() {
    const token = nextScrollSaveSuppressionTokenRef.current;
    nextScrollSaveSuppressionTokenRef.current += 1;
    scrollSaveSuppressionTokenRef.current = token;
    return token;
  }

  function releaseScrollSaveSuppression(token: number) {
    if (scrollSaveSuppressionTokenRef.current === token) {
      scrollSaveSuppressionTokenRef.current = 0;
    }
  }

  function beginLoadingScrollSaveSuppression() {
    loadingScrollSuppressionTokenRef.current = beginScrollSaveSuppression();
  }

  function releaseLoadingScrollSaveSuppression() {
    const token = loadingScrollSuppressionTokenRef.current;
    if (token === null) {
      return;
    }
    loadingScrollSuppressionTokenRef.current = null;
    releaseScrollSaveSuppression(token);
  }

  function applyPage(nextArticle: ExtractedArticle, nextAnalysis: AnalysisResult | null, pageKey: string) {
    const cached = cacheRef.current.get(pageKey);
    const cachedFollowUps = cached?.followUps ?? {};
    currentPageKeyRef.current = pageKey;
    setArticle(nextArticle);
    setAnalysis(nextAnalysis);
    setFollowUps(cachedFollowUps);
    setQuestionDrafts({});
    setPendingQuestions({});
    setQuestionErrors({});
    setSectionAnalyzeState(cached?.sectionAnalyzeState ?? {});
    setSectionAnalyzeErrors(cached?.sectionAnalyzeErrors ?? {});
    setActiveQuestionSectionId(null);
    setAnalysisState(cached?.analysisState ?? (nextAnalysis ? "done" : "idle"));
    setAnalysisError(cached?.analysisError ?? "");
    setRawError(cached?.rawError ?? "");
    setLoadState("ready");
  }

  function applyPageCache(cached: PageCacheEntry, pageKey: string) {
    applyPage(cached.article, cached.analysis, pageKey);
  }

  function applyAnalysisSession(session: AnalysisSession) {
    const existing = cacheRef.current.get(session.pageKey);
    cacheRef.current.set(session.pageKey, {
      article: session.article,
      analysis: session.analysis,
      followUps: existing?.followUps ?? {},
      analysisState: session.state,
      sectionAnalyzeState: session.sectionState,
      sectionAnalyzeErrors: session.sectionErrors,
      analysisError: session.error,
      rawError: session.rawError,
      scrollPos: existing?.scrollPos
    });
    applyPage(session.article, session.analysis, session.pageKey);
  }

  async function runAnalysis() {
    if (!article || !settings) {
      return;
    }

    const currentSettings = await loadSettings();
    setSettings(currentSettings);
    const pageKey = currentPageKeyRef.current;
    const articleForAnalysis = article;
    const analysisVersion = ++analysisVersionRef.current;
    const queuedState = Object.fromEntries(articleForAnalysis.sections.map((section) => [section.id, "queued" as const]));
    let latestAnalysis: AnalysisResult = { overall: { summary: "", why_read: "" }, sections: [] };
    let latestSectionState: Record<string, SectionAnalysisSessionState> = queuedState;
    setAnalysisState("running");
    setAnalysis(latestAnalysis);
    setAnalysisError("");
    setRawError("");
    setSectionAnalyzeState(queuedState);
    setSectionAnalyzeErrors({});
    void saveAnalysisSession({
      pageKey,
      url: articleForAnalysis.url,
      article: articleForAnalysis,
      analysis: latestAnalysis,
      state: "running",
      sectionState: latestSectionState,
      sectionErrors: {},
      error: "",
      rawError: ""
    });

    try {
      let result: AnalysisResult = latestAnalysis;
      const firstSection = articleForAnalysis.sections[0];
      if (firstSection) {
        runningSectionIdRef.current = firstSection.id;
        latestSectionState = { ...latestSectionState, [firstSection.id]: "running" };
        setSectionAnalyzeState(latestSectionState);
        void saveAnalysisSession({
          pageKey,
          url: articleForAnalysis.url,
          article: articleForAnalysis,
          analysis: result,
          state: "running",
          sectionState: latestSectionState,
          sectionErrors: {},
          error: "",
          rawError: ""
        });
      }

      const progressHandler = (event: AnalysisProgressEvent) => {
        if (analysisVersion !== analysisVersionRef.current) {
          return;
        }

        if (event.type === "overall") {
          result = { ...result, overall: event.overall };
          latestAnalysis = result;
          updateCachedAnalysis(pageKey, articleForAnalysis, result, latestSectionState, {}, "running");
          void saveAnalysisSession({
            pageKey,
            url: articleForAnalysis.url,
            article: articleForAnalysis,
            analysis: result,
            state: "running",
            sectionState: latestSectionState,
            sectionErrors: {},
            error: "",
            rawError: ""
          });
          if (currentPageKeyRef.current === pageKey) {
            setAnalysis(result);
          }
          return;
        }

        result = {
          overall: result.overall,
          sections: [...result.sections.filter((item) => item.id !== event.section.id), event.section]
        };
        const completedIndex = articleForAnalysis.sections.findIndex((section) => section.id === event.section.id);
        const nextSection = articleForAnalysis.sections[completedIndex + 1];
        runningSectionIdRef.current = nextSection?.id ?? null;
        latestAnalysis = result;
        latestSectionState = {
          ...latestSectionState,
          [event.section.id]: "done",
          ...(nextSection ? { [nextSection.id]: "running" as const } : {})
        };
        updateCachedAnalysis(pageKey, articleForAnalysis, result, latestSectionState, {}, "running");
        void saveAnalysisSession({
          pageKey,
          url: articleForAnalysis.url,
          article: articleForAnalysis,
          analysis: result,
          state: "running",
          sectionState: latestSectionState,
          sectionErrors: {},
          error: "",
          rawError: ""
        });
        if (currentPageKeyRef.current === pageKey) {
          setAnalysis(result);
          setSectionAnalyzeState(latestSectionState);
        }
      };

      const pdfImages =
        documentMode === "pdf" && pdfAnalysisMode === "visual" && pdfDocumentRef.current
          ? await getPdfImagesForPages(
              pdfDocumentRef.current,
              articleForAnalysis.sections.map((section) => getPdfPageFromSectionId(section.id)).filter(isKnownPage)
            )
          : [];
      if (pdfImages.length > 0) {
        setPdfPageImages((images) => mergePdfPageImages(images, pdfImages));
      }

      result =
        documentMode === "pdf" && pdfAnalysisMode === "deep"
          ? await analyzeDeepPdfProgressively(articleForAnalysis, currentSettings, progressHandler)
          : documentMode === "pdf" && pdfDocumentRef.current
          ? await analyzePdfProgressively({
              article: articleForAnalysis,
              pageImages: pdfImages,
              settings: currentSettings,
              onProgress: progressHandler
            })
          : await analyzeArticleProgressively(articleForAnalysis, currentSettings, progressHandler);
      if (analysisVersion !== analysisVersionRef.current) {
        return;
      }

      const existing = cacheRef.current.get(pageKey);
      const nextFollowUps = existing?.followUps ?? {};
      cacheRef.current.set(pageKey, {
        article: articleForAnalysis,
        analysis: result,
        followUps: nextFollowUps,
        analysisState: "done",
        sectionAnalyzeState: Object.fromEntries(articleForAnalysis.sections.map((section) => [section.id, "done" as const])),
        sectionAnalyzeErrors: {},
        analysisError: "",
        rawError: "",
        scrollPos: cacheRef.current.get(pageKey)?.scrollPos
      });
      await deleteAnalysisSession(pageKey);
      setHistory(
        await saveHistoryEntry({
          article: articleForAnalysis,
          analysis: result,
          followUps: nextFollowUps,
          scrollPos: cacheRef.current.get(pageKey)?.scrollPos
        })
      );
      if (currentPageKeyRef.current === pageKey) {
        runningSectionIdRef.current = null;
        setAnalysis(result);
        setAnalysisState("done");
      }
    } catch (error) {
      if (analysisVersion !== analysisVersionRef.current) {
        return;
      }
      const typedError = error as Error & { raw?: string };
      const runningSectionId = runningSectionIdRef.current;
      const nextSectionErrors = runningSectionId ? { [runningSectionId]: typedError.message } : {};
      if (runningSectionId) {
        latestSectionState = { ...latestSectionState, [runningSectionId]: "error" };
      }
      updateCachedAnalysis(pageKey, articleForAnalysis, latestAnalysis, latestSectionState, nextSectionErrors, "error", typedError.message, typedError.raw ?? "");
      void saveAnalysisSession({
        pageKey,
        url: articleForAnalysis.url,
        article: articleForAnalysis,
        analysis: latestAnalysis,
        state: "error",
        sectionState: latestSectionState,
        sectionErrors: nextSectionErrors,
        error: typedError.message,
        rawError: typedError.raw ?? ""
      });
      if (currentPageKeyRef.current === pageKey) {
        if (runningSectionId) {
          setSectionAnalyzeState(latestSectionState);
          setSectionAnalyzeErrors(nextSectionErrors);
        }
        setAnalysisState("error");
        setAnalysisError(typedError.message);
        setRawError(typedError.raw ?? "");
      }
    }
  }

  async function askPdf() {
    const loadedPdf = pdfDocumentRef.current;
    if (!loadedPdf || !settings) {
      return;
    }

    const liveSelection = await grabPageSelectionReference();
    const selectedReference = mergePdfSelectionReferences(liveSelection, {
      text: pdfSelectionQuote,
      imageDataUrl: pdfSelectionImageDataUrl || undefined
    });
    const selectedReferenceText = normalizeQuestion(selectedReference.text);
    const question = normalizeQuestion(selectedReferenceText ? `> ${selectedReferenceText}\n\n${pdfQuestion}` : pdfQuestion);
    if (!question) {
      return;
    }

    setPdfQuestionState("running");
    setPdfError("");
    setPdfRawError("");

    try {
      const currentSettings = await loadSettings();
      setSettings(currentSettings);
      const pages = parsePdfPageRange(pdfPageRange, loadedPdf.pageCount);
      if (pages.length > 50) {
        throw new Error("Too many PDF pages for one request. Use a page range of 50 pages or fewer.");
      }

      const parsedTargetPage = Number(pdfTargetPage);
      const targetPage =
        Number.isInteger(parsedTargetPage) && parsedTargetPage >= 1 && parsedTargetPage <= loadedPdf.pageCount
          ? parsedTargetPage
          : null;
      const pageImages = await getPdfImagesForPages(loadedPdf, pages);
      const answer = await answerPdfQuestion({
        title: loadedPdf.title,
        url: loadedPdf.sourceUrl,
        pageImages,
        targetPage,
        question,
        selectionReference: selectedReferenceText || selectedReference.imageDataUrl ? selectedReference : undefined,
        settings: currentSettings
      });

      setPdfAnswers((answers) => [
        ...answers,
        {
          question,
          answer,
          pages,
          targetPage,
          createdAt: Date.now()
        }
      ]);
      setPdfQuestion("");
      setPdfSelectionQuote("");
      setPdfSelectionImageDataUrl("");
      setPdfQuestionState("idle");
    } catch (error) {
      const typedError = error as Error & { raw?: string };
      setPdfQuestionState("error");
      setPdfError(typedError.message);
      setPdfRawError(typedError.raw ?? "");
    }
  }

  async function usePdfSelectionReference() {
    const selection = await grabPageSelectionReference();
    if (selection.text) {
      setPdfSelectionQuote(selection.text);
      setPdfSelectionImageDataUrl(selection.imageDataUrl ?? "");
      const pageMatch = selection.text.match(/^\[Page\s+(\d+)/m);
      const page = pageMatch ? Number(pageMatch[1]) : null;
      if (page) {
        setActiveQuestionSectionId(`${PDF_PAGE_SECTION_PREFIX}${page}`);
        requestAnimationFrame(() => scrollPanelToSection(`${PDF_PAGE_SECTION_PREFIX}${page}`));
      }
    }
  }

  function removePdfSelectionReference(referenceLabel: string) {
    const nextQuote = removePdfQuoteReference(pdfSelectionQuote, referenceLabel);
    setPdfSelectionQuote(nextQuote);
    if (!nextQuote) {
      setPdfSelectionImageDataUrl("");
    }
    void sendToViewer({ type: "LEARN_PANEL_REMOVE_PDF_SELECTION_REFERENCE", referenceLabel }).catch(() => undefined);
  }

  async function runPdfGuide() {
    const loadedPdf = pdfDocumentRef.current;
    if (!loadedPdf || !settings) {
      return;
    }

    setPdfGuideState("running");
    setPdfGuide(null);
    setPdfGuideError("");
    setPdfGuideRawError("");

    try {
      const currentSettings = await loadSettings();
      setSettings(currentSettings);
      const pages = Array.from({ length: loadedPdf.pageCount }, (_, index) => index + 1);
      if (pages.length > 50) {
        throw new Error("Too many PDF pages for one guide request. Use a PDF of 50 pages or fewer for one-click guide generation.");
      }
      const pageImages = await getPdfImagesForPages(loadedPdf, pages);
      const guide = await generatePdfGuide({
        title: loadedPdf.title,
        url: loadedPdf.sourceUrl,
        pageImages,
        settings: currentSettings
      });
      setPdfGuide(guide);
      setPdfGuideState("idle");
      void savePdfGuide(loadedPdf.sourceUrl, guide);
    } catch (error) {
      const typedError = error as Error & { raw?: string };
      setPdfGuideState("error");
      setPdfGuideError(typedError.message);
      setPdfGuideRawError(typedError.raw ?? "");
    }
  }

  async function runDeepPdfParse() {
    const loadedPdf = pdfDocumentRef.current;
    if (!loadedPdf || !settings) {
      return;
    }

    setDeepPdfParseState("running");
    setDeepPdfParseStatus("Preparing deep parse...");
    setDeepPdfParseError("");
    setDeepPdfParseRawError("");

    try {
      const currentSettings = await loadSettings();
      setSettings(currentSettings);
      const pages = parsePdfPageRange(pdfPageRange, loadedPdf.pageCount);
      const datalabPageRange = toDatalabPageRange(pages, loadedPdf.pageCount);
      const result = await parsePdfWithDatalab(loadedPdf, currentSettings, datalabPageRange, setDeepPdfParseStatus);
      setDeepPdfParse(result);
      setDeepPdfParseState("done");
      setDeepPdfParseStatus(
        `Parsed ${result.blocks.length} blocks into ${result.sections.length} pages${datalabPageRange ? ` on pages ${formatPages(pages)}` : ""}.`
      );
      await saveDeepPdfParse(loadedPdf.sourceUrl, datalabPageRange, result);
      const parsedArticle = buildDeepPdfArticle(result);
      const parsedPageKey = getDeepPdfPageKey(result.sourceUrl, result.pageRange);
      cacheRef.current.set(parsedPageKey, { article: parsedArticle, analysis: null, followUps: {} });
      setHistory(
        await saveHistoryEntry({
          article: parsedArticle,
          analysis: null,
          followUps: {}
        })
      );
      await applyDeepPdfParse(result);
    } catch (error) {
      const typedError = error as Error & { raw?: string };
      setDeepPdfParseState("error");
      setDeepPdfParseError(typedError.message);
      setDeepPdfParseRawError(typedError.raw ?? "");
    }
  }

  function switchPdfAnalysisMode(mode: PdfAnalysisMode) {
    setPdfAnalysisMode(mode);
    setActiveDeepPdfSectionId(null);
    setShowAllDeepPdfBoundingBoxes(false);
    void sendToViewer({ type: "LEARN_PANEL_HIGHLIGHT_PDF_BLOCKS", sectionId: "", blocks: [] }).catch(() => undefined);

    const loadedPdf = pdfDocumentRef.current;
    if (!loadedPdf) {
      return;
    }

    if (mode === "visual") {
      const pdfArticle = buildPdfArticle(loadedPdf);
      const pageKey = getPageKey(pdfArticle.url);
      const cached = cacheRef.current.get(pageKey);
      if (cached) {
        applyPageCache(cached, pageKey);
      } else {
        cacheRef.current.set(pageKey, { article: pdfArticle, analysis: null, followUps: {} });
        applyPage(pdfArticle, null, pageKey);
      }
      return;
    }

    let currentDatalabPageRange = "";
    try {
      currentDatalabPageRange = toDatalabPageRange(parsePdfPageRange(pdfPageRange, loadedPdf.pageCount), loadedPdf.pageCount);
    } catch {
      currentDatalabPageRange = deepPdfParse?.pageRange ?? "";
    }

    if (deepPdfParse && deepPdfParse.pageRange === currentDatalabPageRange) {
      void applyDeepPdfParse(deepPdfParse, { restoreSaved: true });
      return;
    }

    void loadSavedDeepPdfForCurrentRange(loadedPdf, { clearOnMiss: true });
  }

  async function loadSavedDeepPdfForCurrentRange(loadedPdf: LoadedPdfDocument, options: { clearOnMiss?: boolean } = {}) {
    try {
      const pages = parsePdfPageRange(pdfPageRange, loadedPdf.pageCount);
      const datalabPageRange = toDatalabPageRange(pages, loadedPdf.pageCount);
      const saved = await loadSavedDeepPdfParse(loadedPdf.sourceUrl, datalabPageRange);
      if (saved) {
        setDeepPdfParse(saved);
        setDeepPdfParseState("done");
        setDeepPdfParseStatus(`Loaded saved deep parse${datalabPageRange ? ` for pages ${formatPages(pages)}` : ""}.`);
        await applyDeepPdfParse(saved, { restoreSaved: true });
        return;
      }
    } catch {
      // Keep the panel usable if the range input is temporarily invalid.
    }

    if (options.clearOnMiss) {
      setAnalysis(null);
      setAnalysisState("idle");
      setSectionAnalyzeState({});
      setSectionAnalyzeErrors({});
      setAnalysisError("");
      setRawError("");
    }
  }

  async function applyDeepPdfParse(result: DeepPdfParseResult, options: { restoreSaved?: boolean } = {}) {
    setPdfAnalysisMode("deep");
    void restoreDeepPdfBoundingBoxesVisibility(result).catch(() => undefined);
    const articleFromParse = buildDeepPdfArticle(result);
    const pageKey = getDeepPdfPageKey(result.sourceUrl, result.pageRange);

    if (options.restoreSaved) {
      const persistedSession = await loadAnalysisSession(pageKey);
      if (persistedSession) {
        applyAnalysisSession(persistedSession);
        return;
      }
    }

    const cached = cacheRef.current.get(pageKey);
    if (cached) {
      applyPageCache(cached, pageKey);
      return;
    }

    if (options.restoreSaved) {
      const persisted = await findHistoryEntry(articleFromParse.url);
      if (persisted) {
        cacheRef.current.set(pageKey, {
          article: persisted.article,
          analysis: persisted.analysis,
          followUps: persisted.followUps,
          scrollPos: persisted.scrollPos
        });
        applyPage(persisted.article, persisted.analysis, pageKey);
        return;
      }
    }

    cacheRef.current.set(pageKey, { article: articleFromParse, analysis: null, followUps: {} });
    applyPage(articleFromParse, null, pageKey);
  }

  async function restoreDeepPdfBoundingBoxesVisibility(result: DeepPdfParseResult) {
    const visible = await loadSavedDeepPdfBoundingBoxesVisible(result.sourceUrl, result.pageRange);
    setShowAllDeepPdfBoundingBoxes(visible);

    if (visible) {
      await showDeepPdfBoundingBoxesInViewer(result);
      return;
    }

    await sendToViewer({ type: "LEARN_PANEL_HIGHLIGHT_PDF_BLOCKS", sectionId: "", blocks: [] }).catch(() => undefined);
  }

  async function showDeepPdfBoundingBoxesInViewer(result: DeepPdfParseResult) {
    await sendToViewer({
      type: "LEARN_PANEL_HIGHLIGHT_PDF_BLOCKS",
      sectionId: activeDeepPdfSectionId ?? "",
      blocks: getDeepPdfBlocksForViewer(result),
      pageBboxes: result.pageBboxes
    });
  }

  function focusDeepPdfSection(section: DeepPdfSection) {
    setActiveDeepPdfSectionId(section.id);
    void sendToViewer({
      type: "LEARN_PANEL_HIGHLIGHT_PDF_BLOCKS",
      sectionId: section.id,
      blocks: showAllDeepPdfBoundingBoxes && deepPdfParse ? getDeepPdfBlocksForViewer(deepPdfParse) : tagDeepPdfSectionBlocks(section),
      pageBboxes: deepPdfParse?.pageBboxes
    }).catch(() => undefined);
    const firstBlockPage = section.blocks[0]?.page ?? section.pageStart;
    setPdfTargetPage(String(firstBlockPage));
  }

  function toggleDeepPdfBoundingBoxes() {
    const nextVisible = !showAllDeepPdfBoundingBoxes;
    setShowAllDeepPdfBoundingBoxes(nextVisible);
    if (!nextVisible || !deepPdfParse) {
      if (deepPdfParse) {
        void saveDeepPdfBoundingBoxesVisible(deepPdfParse.sourceUrl, deepPdfParse.pageRange, false).catch(() => undefined);
      }
      void sendToViewer({ type: "LEARN_PANEL_HIGHLIGHT_PDF_BLOCKS", sectionId: "", blocks: [] }).catch(() => undefined);
      return;
    }

    void saveDeepPdfBoundingBoxesVisible(deepPdfParse.sourceUrl, deepPdfParse.pageRange, true).catch(() => undefined);
    void showDeepPdfBoundingBoxesInViewer(deepPdfParse).catch(() => undefined);
  }

  async function getPdfImagesForPages(loadedPdf: LoadedPdfDocument, pages: number[]): Promise<PdfPageImage[]> {
    const cachedImages = new Map(pdfPageImages.map((image) => [image.page, image]));
    const cachedPageImages = pages.map((page) => cachedImages.get(page));
    return cachedPageImages.every(Boolean)
      ? (cachedPageImages as PdfPageImage[])
      : renderPdfPages(loadedPdf.pdf, pages);
  }

  function updateCachedAnalysis(
    pageKey: string,
    nextArticle: ExtractedArticle,
    nextAnalysis: AnalysisResult,
    nextSectionState: Record<string, SectionAnalyzeState>,
    nextSectionErrors: Record<string, string>,
    nextAnalysisState: AnalyzeState,
    nextAnalysisError = "",
    nextRawError = ""
  ) {
    const existing = cacheRef.current.get(pageKey);
    cacheRef.current.set(pageKey, {
      article: nextArticle,
      analysis: nextAnalysis,
      followUps: existing?.followUps ?? {},
      analysisState: nextAnalysisState,
      sectionAnalyzeState: nextSectionState,
      sectionAnalyzeErrors: nextSectionErrors,
      analysisError: nextAnalysisError,
      rawError: nextRawError,
      scrollPos: existing?.scrollPos
    });
  }

  async function jumpToSection(sectionId: string) {
    const tab = await getActiveTab();
    const response = await sendToTab(tab.id, { type: "LEARN_PANEL_SCROLL_TO_SECTION", sectionId });
    if (!response.ok) {
      setLoadError(response.error);
    }
  }

  async function grabPageSelection(): Promise<string> {
    return (await grabPageSelectionReference()).text;
  }

  async function grabPageSelectionReference(): Promise<PdfSelectionReference> {
    try {
      const tab = await getActiveTab();
      const response = await sendToTab(tab.id, { type: "LEARN_PANEL_GET_SELECTION" });
      if (response.ok && "selection" in response) {
        return {
          text: response.selection,
          imageDataUrl: response.selectionImageDataUrl
        };
      }
    } catch {
      // ignore
    }
    return { text: "" };
  }

  async function openQuestionWithSelection(sectionId: string) {
    setActiveQuestionSectionId(sectionId);
    const selection = await grabPageSelection();
    if (selection) {
      setSelectionQuote(selection);
    }
  }

  function exportConversation() {
    if (!article) return;
    const lines: string[] = [];
    const now = Date.now();
    const existingEntry = history.find((entry) => entry.article.url === article.url);
    const exportEntry: HistoryEntry = {
      id: existingEntry?.id ?? `history-export-${now}`,
      article,
      analysis,
      followUps,
      createdAt: existingEntry?.createdAt ?? now,
      updatedAt: now,
      scrollPos: cacheRef.current.get(currentPageKeyRef.current)?.scrollPos
    };
    const exportPayload: HistoryExportPayload = {
      schema: HISTORY_EXPORT_SCHEMA,
      version: HISTORY_EXPORT_VERSION,
      exportedAt: now,
      entry: exportEntry
    };

    lines.push(`<!-- learn-panel-history:v1:${encodeBase64Json(exportPayload)} -->`);
    lines.push("");
    lines.push(`# ${article.title}`);
    lines.push(`URL: ${article.url}`);
    lines.push("");

    if (analysis?.overall.summary) {
      lines.push("## Overall");
      lines.push(`**Summary:** ${analysis.overall.summary}`);
      lines.push(`**Why read:** ${analysis.overall.why_read}`);
      lines.push("");
    }

    for (const section of article.sections) {
      const result = sectionAnalysis.get(section.id);
      const sectionFollowUps = followUps[section.id] ?? [];
      if (!result && sectionFollowUps.length === 0) continue;

      lines.push(`## ${section.title}`);
      if (result) {
        lines.push(`**Summary:** ${result.summary}`);
        lines.push(`**Interpretation:** ${result.interpretation}`);
        lines.push(`**Role:** ${result.role_in_article}`);
      }
      if (sectionFollowUps.length > 0) {
        lines.push("");
        lines.push("### Q&A");
        for (const fu of sectionFollowUps) {
          lines.push(`**Q:** ${fu.question}`);
          lines.push(`**A:** ${fu.answer}`);
          lines.push("");
        }
      }
      lines.push("");
    }

    const text = lines.join("\n");
    const blob = new Blob([text], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${article.title.slice(0, 60).replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, "_")}_notes.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openHistoryImportPicker() {
    setHistoryImportNotice(null);
    historyImportInputRef.current?.click();
  }

  async function handleHistoryImport(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const importedValue = parseHistoryImportText(text);
      const nextHistory = await importHistoryEntry(importedValue);
      setHistory(nextHistory);

      const importedEntry = getImportedEntryFromValue(importedValue);
      if (importedEntry) {
        const savedEntry = nextHistory.find((entry) => entry.article.url === importedEntry.article.url);
        if (savedEntry) {
          cacheRef.current.set(getPageKey(savedEntry.article.url), {
            article: savedEntry.article,
            analysis: savedEntry.analysis,
            followUps: savedEntry.followUps,
            scrollPos: savedEntry.scrollPos
          });
          setHistoryImportNotice({ type: "info", text: `Imported "${savedEntry.article.title}" into history.` });
        } else {
          setHistoryImportNotice({ type: "info", text: "Imported snapshot into history." });
        }
      } else {
        setHistoryImportNotice({ type: "info", text: "Imported snapshot into history." });
      }
      setViewMode("history");
    } catch (error) {
      setHistoryImportNotice({ type: "error", text: (error as Error).message });
      setViewMode("history");
    }
  }

  async function askSectionQuestion(sectionId: string) {
    if (!article || !settings) {
      return;
    }

    let draft = questionDrafts[sectionId] ?? "";
    if (selectionQuote && activeQuestionSectionId === sectionId) {
      draft = `> ${selectionQuote}\n\n${draft}`;
    }
    const question = normalizeQuestion(draft);
    if (!question) {
      return;
    }

    const section = article.sections.find((candidate) => candidate.id === sectionId);
    if (!section) {
      return;
    }

    const pageKey = currentPageKeyRef.current;
    const currentSettings = await loadSettings();
    setSettings(currentSettings);
    const existingFollowUps = followUps[sectionId] ?? [];
    const cached = existingFollowUps.find((item) => normalizeQuestion(item.question) === question);
    if (cached) {
      setQuestionDrafts((drafts) => ({ ...drafts, [sectionId]: "" }));
      return;
    }

    setPendingQuestions((pending) => ({ ...pending, [sectionId]: true }));
    setQuestionErrors((errors) => ({ ...errors, [sectionId]: "" }));

    try {
      const answer = await answerSectionQuestion({
        article,
        section,
        sectionAnalysis: sectionAnalysis.get(sectionId),
        priorFollowUps: existingFollowUps,
        question,
        settings: currentSettings
      });
      const followUp: SectionFollowUp = {
        question,
        answer,
        createdAt: Date.now()
      };

      const nextFollowUps = {
        ...followUps,
        [sectionId]: [...existingFollowUps, followUp]
      };
      const existing = cacheRef.current.get(pageKey);
      cacheRef.current.set(pageKey, {
        article,
        analysis,
        followUps: nextFollowUps,
        scrollPos: cacheRef.current.get(pageKey)?.scrollPos
      });
      setHistory(await saveHistoryEntry({
        article,
        analysis,
        followUps: nextFollowUps,
        scrollPos: cacheRef.current.get(pageKey)?.scrollPos
      }));

      if (currentPageKeyRef.current === pageKey) {
        setFollowUps(nextFollowUps);
        setQuestionDrafts((drafts) => ({ ...drafts, [sectionId]: "" }));
        if (selectionQuote && activeQuestionSectionId === sectionId) {
          setSelectionQuote("");
        }
      } else if (existing) {
        cacheRef.current.set(pageKey, {
          ...existing,
          followUps: nextFollowUps
        });
      }
    } catch (error) {
      if (currentPageKeyRef.current === pageKey) {
        setQuestionErrors((errors) => ({ ...errors, [sectionId]: (error as Error).message }));
      }
    } finally {
      if (currentPageKeyRef.current === pageKey) {
        setPendingQuestions((pending) => ({ ...pending, [sectionId]: false }));
      }
    }
  }

  async function askPdfCardQuestion(sectionId: string) {
    if (!article || !settings) {
      return;
    }

    let draft = questionDrafts[sectionId] ?? "";
    let displayDraft = draft;
    if (pdfSelectionQuote && activeQuestionSectionId === sectionId) {
      draft = `> ${pdfSelectionQuote}\n\n${draft}`;
      displayDraft = `> ${formatPdfQuoteTitle(pdfSelectionQuote)}\n\n${displayDraft}`;
    }
    const question = normalizeQuestion(draft);
    const displayQuestion = normalizeQuestion(displayDraft);
    if (!question) {
      return;
    }

    const section = article.sections.find((candidate) => candidate.id === sectionId);
    if (!section) {
      return;
    }

    const pageKey = currentPageKeyRef.current;
    const currentSettings = await loadSettings();
    setSettings(currentSettings);
    const existingFollowUps = followUps[sectionId] ?? [];
    const cached = existingFollowUps.find((item) => normalizeQuestion(item.question) === displayQuestion);
    if (cached) {
      setQuestionDrafts((drafts) => ({ ...drafts, [sectionId]: "" }));
      return;
    }

    setPendingQuestions((pending) => ({ ...pending, [sectionId]: true }));
    setQuestionErrors((errors) => ({ ...errors, [sectionId]: "" }));

    try {
      let answer = "";
      if (article.siteName === "PDF Deep") {
        const liveSelection = await grabPageSelectionReference();
        const selectedReference =
          pdfSelectionQuote && activeQuestionSectionId === sectionId
            ? mergePdfSelectionReferences(liveSelection, {
              text: pdfSelectionQuote,
              imageDataUrl: pdfSelectionImageDataUrl || undefined
            })
            : liveSelection.text || liveSelection.imageDataUrl
              ? liveSelection
              : undefined;

        if (selectedReference?.imageDataUrl) {
          const loadedPdf = pdfDocumentRef.current;
          const page = getPdfPageFromSectionId(sectionId);
          if (!loadedPdf || !page) {
            throw new Error("Could not find the PDF page for this screenshot reference.");
          }
          const pageImages = await getPdfImagesForPages(loadedPdf, [page]);
          answer = await answerDeepPdfVisionQuestion({
            title: loadedPdf.title,
            url: loadedPdf.sourceUrl,
            pageImages,
            targetPage: page,
            question,
            selectionReference: selectedReference,
            sectionText: section.text,
            settings: currentSettings
          });
        } else {
          answer = await answerSectionQuestion({
            article,
            section,
            sectionAnalysis: sectionAnalysis.get(sectionId),
            priorFollowUps: existingFollowUps,
            question,
            settings: currentSettings
          });
        }
      } else {
        const loadedPdf = pdfDocumentRef.current;
        const page = getPdfPageFromSectionId(sectionId);
        if (!loadedPdf || !page) {
          throw new Error("Could not find the PDF page for this card.");
        }
        const pageImages = await getPdfImagesForPages(loadedPdf, [page]);
        const liveSelection = await grabPageSelectionReference();
        const selectedReference =
          pdfSelectionQuote && activeQuestionSectionId === sectionId
            ? mergePdfSelectionReferences(liveSelection, {
              text: pdfSelectionQuote,
              imageDataUrl: pdfSelectionImageDataUrl || undefined
            })
            : liveSelection.text || liveSelection.imageDataUrl
              ? liveSelection
              : undefined;
        answer = await answerPdfQuestion({
          title: loadedPdf.title,
          url: loadedPdf.sourceUrl,
          pageImages,
          targetPage: page,
          question,
          selectionReference: selectedReference,
          settings: currentSettings
        });
      }

      const followUp: SectionFollowUp = {
        question: displayQuestion,
        answer,
        createdAt: Date.now()
      };
      const nextFollowUps = {
        ...followUps,
        [sectionId]: [...existingFollowUps, followUp]
      };
      const existing = cacheRef.current.get(pageKey);
      cacheRef.current.set(pageKey, {
        article,
        analysis,
        followUps: nextFollowUps,
        scrollPos: cacheRef.current.get(pageKey)?.scrollPos
      });
      setHistory(await saveHistoryEntry({
        article,
        analysis,
        followUps: nextFollowUps,
        scrollPos: cacheRef.current.get(pageKey)?.scrollPos
      }));

      if (currentPageKeyRef.current === pageKey) {
        setFollowUps(nextFollowUps);
        setQuestionDrafts((drafts) => ({ ...drafts, [sectionId]: "" }));
        if (pdfSelectionQuote && activeQuestionSectionId === sectionId) {
          setPdfSelectionQuote("");
          setPdfSelectionImageDataUrl("");
        }
      } else if (existing) {
        cacheRef.current.set(pageKey, {
          ...existing,
          followUps: nextFollowUps
        });
      }
    } catch (error) {
      if (currentPageKeyRef.current === pageKey) {
        setQuestionErrors((errors) => ({ ...errors, [sectionId]: (error as Error).message }));
      }
    } finally {
      if (currentPageKeyRef.current === pageKey) {
        setPendingQuestions((pending) => ({ ...pending, [sectionId]: false }));
      }
    }
  }

  async function openPdfCardQuestion(sectionId: string) {
    setActiveQuestionSectionId(sectionId);
    const selection = await grabPageSelectionReference();
    if (selection.text) {
      setPdfSelectionQuote(selection.text);
      setPdfSelectionImageDataUrl(selection.imageDataUrl ?? "");
    }
  }

  async function restoreHistoryEntry(entry: HistoryEntry) {
    if (entry.article.siteName === "PDF" || entry.article.siteName === "PDF Deep") {
      setViewMode("reader");
      const tab = await getActiveTab();
      await chrome.tabs.update(tab.id, {
        url: getCustomViewerUrl(getPdfSourceFromArticleUrl(entry.article.url), {
          deepRange: entry.article.siteName === "PDF Deep" ? getDeepPdfRangeFromArticleUrl(entry.article.url) : undefined
        })
      });
      return;
    }

    const pageKey = getPageKey(entry.article.url);
    cacheRef.current.set(pageKey, {
      article: entry.article,
      analysis: entry.analysis,
      followUps: entry.followUps,
      scrollPos: entry.scrollPos
    });
    applyPage(entry.article, entry.analysis, pageKey);
    setViewMode("reader");
  }

  async function removeHistoryEntry(entry: HistoryEntry) {
    const nextHistory = await deleteHistoryEntry(entry.id);
    setHistory(nextHistory);
    const pageKey = getPageKey(entry.article.url);
    cacheRef.current.delete(pageKey);
    void deleteAnalysisSession(pageKey);
    if (article?.url === entry.article.url) {
      setAnalysis(null);
      setFollowUps({});
      setSectionAnalyzeState({});
      setSectionAnalyzeErrors({});
      setAnalysisState("idle");
    }
  }

  async function removeAllHistory() {
    await clearHistory();
    await clearAnalysisSessions();
    setHistory([]);
    cacheRef.current.clear();
    setAnalysis(null);
    setFollowUps({});
    setSectionAnalyzeState({});
    setSectionAnalyzeErrors({});
    setAnalysisState("idle");
  }

  const needsSettings = settings ? !getActiveApiKey(settings) || !settings.model.trim() || !settings.endpoint.trim() : false;
  const needsPdfSettings = settings
    ? !getActivePdfApiKey(settings) || !settings.pdfModel.trim() || !settings.pdfEndpoint.trim()
    : false;
  const needsDeepPdfParserSettings = settings ? !settings.deepPdfParserApiKey.trim() || !settings.deepPdfParserEndpoint.trim() : false;
  const needsDeepPdfSummarySettings = settings
    ? !getActiveDeepPdfSummaryApiKey(settings) ||
      !settings.deepPdfSummaryModel.trim() ||
      !settings.deepPdfSummaryEndpoint.trim()
    : false;
  const completedSectionCount = article ? article.sections.filter((section) => sectionAnalyzeState[section.id] === "done").length : 0;
  const runningSectionIndex = article?.sections.findIndex((section) => sectionAnalyzeState[section.id] === "running") ?? -1;
  const hasAnyFollowUps = Object.values(followUps).some((list) => list.length > 0);
  const hasAnalysis = Boolean(analysis && (analysis.overall.summary || analysis.overall.why_read || analysis.sections.length > 0));

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Learning Panel</p>
          <h1>{documentMode === "pdf" ? pdfDocument?.title || "PDF document" : article?.title || "Current page"}</h1>
        </div>
        <div className="topbar-actions">
          <button
            className={`icon-button follow-button${followEnabled ? " active" : ""}`}
            type="button"
            onClick={() => {
              setFollowEnabled((enabled) => !enabled);
              setViewMode("reader");
            }}
            title="Follow the visible webpage section or PDF page"
          >
            跟随
          </button>
          {(hasAnalysis || hasAnyFollowUps) && (
            <button className="icon-button" type="button" onClick={exportConversation} title="Export notes as Markdown">
              Export
            </button>
          )}
          <button className="icon-button" type="button" onClick={() => void refreshPage()} title="Refresh current page extraction">
            Refresh
          </button>
        </div>
      </header>

      <nav className="view-tabs" aria-label="Panel views">
        <button className={viewMode === "reader" ? "active" : ""} type="button" onClick={() => setViewMode("reader")}>
          Reader
        </button>
        <button className={viewMode === "history" ? "active" : ""} type="button" onClick={() => setViewMode("history")}>
          History
        </button>
      </nav>

      {viewMode === "history" && (
        <HistoryView
          history={history}
          importNotice={historyImportNotice}
          onClear={() => void removeAllHistory()}
          onDelete={(entry) => void removeHistoryEntry(entry)}
          onImport={openHistoryImportPicker}
          onRestore={(entry) => void restoreHistoryEntry(entry)}
        />
      )}
      <input
        ref={historyImportInputRef}
        className="hidden-file-input"
        type="file"
        accept=".md,.markdown,.json,application/json,text/markdown,text/plain"
        onChange={(event) => void handleHistoryImport(event)}
      />

      {viewMode === "reader" && loadState === "loading" && <Status text="Reading this page..." />}
      {viewMode === "reader" && loadState === "error" && (
        <EmptyState
          title="Could not read this page"
          body={loadError || "Open an article page, then reopen the side panel."}
          actionLabel="Open settings"
          onAction={() => chrome.runtime.openOptionsPage()}
        />
      )}

      {viewMode === "reader" && documentMode === "pdf" && !isInCustomViewer && loadState === "ready" && (
        <PdfLanding
          sourceUrl={getPdfSourceUrl(pdfDocumentRef.current?.url ?? currentPageKeyRef.current) ?? currentPageKeyRef.current}
          onOpenInViewer={async (sourceUrl) => {
            const tab = await getActiveTab();
            const viewerUrl = getCustomViewerUrl(sourceUrl);
            await chrome.tabs.update(tab.id, { url: viewerUrl });
          }}
          onOpenLocal={async () => {
            const tab = await getActiveTab();
            const viewerUrl = chrome.runtime.getURL("dist/pdfviewer.html");
            await chrome.tabs.update(tab.id, { url: viewerUrl });
          }}
        />
      )}

      {viewMode === "reader" && documentMode === "pdf" && isInCustomViewer && !pdfDocument && loadState === "ready" && (
        <EmptyState
          title="No PDF loaded"
          body="Open a PDF file in this viewer, or choose a saved PDF from History."
          actionLabel="Open Local PDF"
          onAction={async () => {
            const tab = await getActiveTab();
            const viewerUrl = chrome.runtime.getURL("dist/pdfviewer.html");
            await chrome.tabs.update(tab.id, { url: viewerUrl });
          }}
        />
      )}

      {viewMode === "reader" && documentMode === "pdf" && isInCustomViewer && pdfDocument && (
        <PdfReader
          pdfDocument={pdfDocument}
          pageRange={pdfPageRange}
          targetPage={pdfTargetPage}
          question={pdfQuestion}
          selectionQuote={pdfSelectionQuote}
          selectionImageDataUrl={pdfSelectionImageDataUrl}
          answers={pdfAnswers}
          guide={pdfGuide}
          guideState={pdfGuideState}
          guideError={pdfGuideError}
          guideRawError={pdfGuideRawError}
          followedPdfPage={followedPdfPage}
          pageImages={pdfPageImages}
          pdfAnalysisMode={pdfAnalysisMode}
          deepPdfParse={deepPdfParse}
          deepPdfParseState={deepPdfParseState}
          deepPdfParseStatus={deepPdfParseStatus}
          deepPdfParseError={deepPdfParseError}
          deepPdfParseRawError={deepPdfParseRawError}
          activeDeepPdfSectionId={activeDeepPdfSectionId}
          showAllDeepPdfBoundingBoxes={showAllDeepPdfBoundingBoxes}
          activeQuestionSectionId={activeQuestionSectionId}
          analysis={analysis}
          analysisState={analysisState}
          analysisError={analysisError}
          rawAnalysisError={rawError}
          sectionAnalyzeState={sectionAnalyzeState}
          sectionAnalyzeErrors={sectionAnalyzeErrors}
          followUps={followUps}
          questionDrafts={questionDrafts}
          pendingQuestions={pendingQuestions}
          questionErrors={questionErrors}
          previewState={pdfPreviewState}
          previewError={pdfPreviewError}
          state={pdfQuestionState}
          error={pdfError}
          rawError={pdfRawError}
          needsSettings={pdfAnalysisMode === "deep" ? needsDeepPdfSummarySettings : needsPdfSettings}
          needsParserSettings={needsDeepPdfParserSettings}
          onPageRangeChange={setPdfPageRange}
          onTargetPageChange={setPdfTargetPage}
          onQuestionChange={setPdfQuestion}
          onQuestionDraftChange={(sectionId, value) =>
            setQuestionDrafts((drafts) => ({ ...drafts, [sectionId]: value }))
          }
          onUseSelection={() => void usePdfSelectionReference()}
          onClearSelection={() => {
            setPdfSelectionQuote("");
            setPdfSelectionImageDataUrl("");
          }}
          onRemoveSelectionReference={removePdfSelectionReference}
          onOpenCardQuestion={(sectionId) => void openPdfCardQuestion(sectionId)}
          onAskCardQuestion={(sectionId) => void askPdfCardQuestion(sectionId)}
          onGenerateGuide={() => void runAnalysis()}
          onParseDeepPdf={() => void runDeepPdfParse()}
          onModeChange={switchPdfAnalysisMode}
          onFocusDeepSection={focusDeepPdfSection}
          onToggleDeepBoundingBoxes={toggleDeepPdfBoundingBoxes}
          onFocusPage={(page) => {
            setPdfTargetPage(String(page));
            setPdfPageRange("all");
            void sendToViewer({ type: "LEARN_PANEL_SCROLL_TO_PDF_PAGE", page });
          }}
          onAsk={() => void askPdf()}
          onOpenSettings={() => chrome.runtime.openOptionsPage()}
        />
      )}

      {viewMode === "reader" && documentMode === "article" && article && (
        <>
          <section className="page-meta">
            <div>
              <span>{article.siteName}</span>
              <a href={article.url} target="_blank" rel="noreferrer">
                Open page
              </a>
            </div>
            <p>{article.sections.length} sections detected</p>
          </section>

          {needsSettings && (
            <section className="warning">
              <strong>Settings needed</strong>
              <span>Add your API key, endpoint, and model before analysis.</span>
              <button type="button" onClick={() => chrome.runtime.openOptionsPage()}>
                Open settings
              </button>
            </section>
          )}

          <section className="action-row">
            <button type="button" disabled={analysisState === "running" || needsSettings} onClick={() => void runAnalysis()}>
              {analysisState === "running" ? "Analyzing..." : "Analyze"}
            </button>
          </section>

          {analysisState === "running" && article && (
            <Status
              text={
                runningSectionIndex >= 0
                  ? `Analyzing section ${runningSectionIndex + 1} of ${article.sections.length}. ${completedSectionCount} done.`
                  : "Preparing article overview..."
              }
            />
          )}

          {analysisState === "error" && (
            <section className="error-box">
              <strong>Analysis failed</strong>
              <p>{analysisError}</p>
              {rawError && <pre>{rawError}</pre>}
            </section>
          )}

          {analysis?.overall.summary && analysis.overall.why_read && (
            <section className="overall">
              <h2>Overall</h2>
              <InfoBlock title="Summary" body={analysis.overall.summary} />
              <InfoBlock title="Why read this" body={analysis.overall.why_read} />
            </section>
          )}

          <section className="sections">
            <h2>Sections</h2>
            {article.sections.map((section) => {
              const result = sectionAnalysis.get(section.id);
              const sectionFollowUps = followUps[section.id] ?? [];
              const pending = pendingQuestions[section.id] ?? false;
              const sectionStatus = sectionAnalyzeState[section.id];
              const showQA = sectionFollowUps.length > 0 || activeQuestionSectionId === section.id || pending;
              return (
                <article
                  key={section.id}
                  className={`section-card${followedSectionId === section.id ? " followed" : ""}`}
                  data-learn-panel-section-card-id={section.id}
                  onClick={() => void jumpToSection(section.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void openQuestionWithSelection(section.id);
                  }}
                >
                  <div className="section-card-header">
                    <span>H{section.level}</span>
                    <h3>{section.title}</h3>
                    {sectionStatus && sectionStatus !== "done" && (
                      <span className={`section-status ${sectionStatus}`}>{formatSectionAnalyzeState(sectionStatus)}</span>
                    )}
                  </div>
                  {result ? (
                    <>
                      <InfoBlock title="Summary" body={result.summary} />
                      <InfoBlock title="What this means" body={result.interpretation} />
                      <InfoBlock title="Role in article" body={result.role_in_article} />
                    </>
                  ) : (
                    <>
                      <p className="preview">{section.text.slice(0, 260)}</p>
                      {sectionStatus && sectionStatus !== "done" && (
                        <p className={`section-progress ${sectionStatus}`}>
                          {sectionStatus === "error"
                            ? sectionAnalyzeErrors[section.id] || "This section failed to analyze."
                            : sectionStatus === "running"
                              ? "Analyzing this section now..."
                              : "Waiting for earlier sections..."}
                        </p>
                      )}
                    </>
                  )}
                  {sectionFollowUps.length > 0 && (
                    <div className="follow-up-list" onClick={(event) => event.stopPropagation()}>
                      {sectionFollowUps.map((item, idx) => (
                        <FollowUpItem
                          key={`${item.createdAt}-${item.question}`}
                          item={item}
                          defaultExpanded={idx === sectionFollowUps.length - 1}
                        />
                      ))}
                    </div>
                  )}
                  {questionErrors[section.id] && <p className="follow-up-error">{questionErrors[section.id]}</p>}
                  {showQA && (
                    <form
                      className="follow-up-form"
                      onClick={(event) => event.stopPropagation()}
                      onContextMenu={(event) => event.stopPropagation()}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void askSectionQuestion(section.id);
                      }}
                    >
                      {selectionQuote && activeQuestionSectionId === section.id && (
                        <div className="selection-quote">
                          <span className="quote-label">Quoted from page:</span>
                          <button
                            type="button"
                            className="quote-dismiss-button"
                            onClick={() => setSelectionQuote("")}
                          >
                            ✕
                          </button>
                          <blockquote>{selectionQuote.slice(0, 200)}{selectionQuote.length > 200 ? "…" : ""}</blockquote>
                        </div>
                      )}
                      <div className="follow-up-input-row">
                        <input
                          type="text"
                          value={questionDrafts[section.id] ?? ""}
                          disabled={pending || needsSettings}
                          placeholder="Ask about this section..."
                          onChange={(event) =>
                            setQuestionDrafts((drafts) => ({ ...drafts, [section.id]: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              const hasContent = normalizeQuestion(questionDrafts[section.id] ?? "") || (selectionQuote && activeQuestionSectionId === section.id);
                              if (hasContent) {
                                void askSectionQuestion(section.id);
                              }
                            }
                          }}
                          onFocus={() => {
                            setActiveQuestionSectionId(section.id);
                            void grabPageSelection().then((sel) => {
                              if (sel) setSelectionQuote(sel);
                            });
                          }}
                        />
                        <button
                          type="submit"
                          disabled={
                            pending ||
                            needsSettings ||
                            !(normalizeQuestion(questionDrafts[section.id] ?? "") || (selectionQuote && activeQuestionSectionId === section.id))
                          }
                        >
                          {pending ? "..." : "Ask"}
                        </button>
                      </div>
                    </form>
                  )}
                </article>
              );
            })}
          </section>
        </>
      )}
    </main>
  );
}

function PdfReader({
  pdfDocument,
  pageRange,
  targetPage,
  question,
  selectionQuote,
  selectionImageDataUrl,
  answers,
  guide,
  guideState,
  guideError,
  guideRawError,
  followedPdfPage,
  pageImages,
  pdfAnalysisMode,
  deepPdfParse,
  deepPdfParseState,
  deepPdfParseStatus,
  deepPdfParseError,
  deepPdfParseRawError,
  activeDeepPdfSectionId,
  showAllDeepPdfBoundingBoxes,
  activeQuestionSectionId,
  analysis,
  analysisState,
  analysisError,
  rawAnalysisError,
  sectionAnalyzeState,
  sectionAnalyzeErrors,
  followUps,
  questionDrafts,
  pendingQuestions,
  questionErrors,
  previewState,
  previewError,
  state,
  error,
  rawError,
  needsSettings,
  needsParserSettings,
  onPageRangeChange,
  onTargetPageChange,
  onQuestionChange,
  onQuestionDraftChange,
  onUseSelection,
  onClearSelection,
  onRemoveSelectionReference,
  onOpenCardQuestion,
  onAskCardQuestion,
  onGenerateGuide,
  onParseDeepPdf,
  onModeChange,
  onFocusDeepSection,
  onToggleDeepBoundingBoxes,
  onFocusPage,
  onAsk,
  onOpenSettings
}: {
  pdfDocument: LoadedPdfDocument;
  pageRange: string;
  targetPage: string;
  question: string;
  selectionQuote: string;
  selectionImageDataUrl: string;
  answers: PdfAnswer[];
  guide: PdfGuideResult | null;
  guideState: PdfQuestionState;
  guideError: string;
  guideRawError: string;
  followedPdfPage: number | null;
  pageImages: PdfPageImage[];
  pdfAnalysisMode: PdfAnalysisMode;
  deepPdfParse: DeepPdfParseResult | null;
  deepPdfParseState: DeepPdfParseState;
  deepPdfParseStatus: string;
  deepPdfParseError: string;
  deepPdfParseRawError: string;
  activeDeepPdfSectionId: string | null;
  showAllDeepPdfBoundingBoxes: boolean;
  activeQuestionSectionId: string | null;
  analysis: AnalysisResult | null;
  analysisState: AnalyzeState;
  analysisError: string;
  rawAnalysisError: string;
  sectionAnalyzeState: Record<string, SectionAnalyzeState>;
  sectionAnalyzeErrors: Record<string, string>;
  followUps: Record<string, SectionFollowUp[]>;
  questionDrafts: Record<string, string>;
  pendingQuestions: Record<string, boolean>;
  questionErrors: Record<string, string>;
  previewState: PdfPreviewState;
  previewError: string;
  state: PdfQuestionState;
  error: string;
  rawError: string;
  needsSettings: boolean;
  needsParserSettings: boolean;
  onPageRangeChange: (value: string) => void;
  onTargetPageChange: (value: string) => void;
  onQuestionChange: (value: string) => void;
  onQuestionDraftChange: (sectionId: string, value: string) => void;
  onUseSelection: () => void;
  onClearSelection: () => void;
  onRemoveSelectionReference: (referenceLabel: string) => void;
  onOpenCardQuestion: (sectionId: string) => void;
  onAskCardQuestion: (sectionId: string) => void;
  onGenerateGuide: () => void;
  onParseDeepPdf: () => void;
  onModeChange: (mode: PdfAnalysisMode) => void;
  onFocusDeepSection: (section: DeepPdfSection) => void;
  onToggleDeepBoundingBoxes: () => void;
  onFocusPage: (page: number) => void;
  onAsk: () => void;
  onOpenSettings: () => void;
}) {
  const canGenerateGuide = !needsSettings && analysisState !== "running";
  const focusedPage = Number(targetPage);
  const guideByPage = useMemo(() => new Map((guide?.pages ?? []).map((pageGuide) => [pageGuide.page, pageGuide])), [guide]);
  const analysisByPage = useMemo(() => {
    const map = new Map<number, AnalysisResult["sections"][number]>();
    analysis?.sections.forEach((section) => {
      const page = getPdfPageFromSectionId(section.id);
      if (page) {
        map.set(page, section);
      }
    });
    return map;
  }, [analysis]);
  const completedPages = pageImages.filter((image) => sectionAnalyzeState[`${PDF_PAGE_SECTION_PREFIX}${image.page}`] === "done").length;
  const runningPage = pageImages.find((image) => sectionAnalyzeState[`${PDF_PAGE_SECTION_PREFIX}${image.page}`] === "running")?.page;
  const completedDeepSections = deepPdfParse
    ? deepPdfParse.sections.filter((section) => sectionAnalyzeState[section.id] === "done").length
    : 0;
  const canParseDeepPdf = !needsParserSettings && deepPdfParseState !== "running";
  const canAnalyze = !needsSettings && analysisState !== "running" && (pdfAnalysisMode === "visual" || Boolean(deepPdfParse));
  const renderPdfCardQa = (sectionId: string, placeholder: string) => {
    const sectionFollowUps = followUps[sectionId] ?? [];
    const pending = pendingQuestions[sectionId] ?? false;
    const showQA = sectionFollowUps.length > 0 || activeQuestionSectionId === sectionId || pending;
    if (!showQA) {
      return null;
    }

    const hasQuote = Boolean(selectionQuote && activeQuestionSectionId === sectionId);
    const hasContent = Boolean(normalizeQuestion(questionDrafts[sectionId] ?? "") || hasQuote);
    const quoteReferenceLabels = hasQuote ? getPdfQuoteReferenceLabels(selectionQuote) : [];

    return (
      <>
        {sectionFollowUps.length > 0 && (
          <div className="follow-up-list" onClick={(event) => event.stopPropagation()}>
            {sectionFollowUps.map((item, idx) => (
              <FollowUpItem
                key={`${item.createdAt}-${item.question}`}
                item={item}
                defaultExpanded={idx === sectionFollowUps.length - 1}
              />
            ))}
          </div>
        )}
        {questionErrors[sectionId] && <p className="follow-up-error">{questionErrors[sectionId]}</p>}
        <form
          className="follow-up-form"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            onAskCardQuestion(sectionId);
          }}
        >
          {hasQuote && (
            <div className="selection-quote">
              <span className="quote-label">Quoted from PDF:</span>
              <button
                type="button"
                className="quote-dismiss-button"
                onClick={onClearSelection}
              >
                x
              </button>
              <div className="quote-reference-list">
                {quoteReferenceLabels.map((label) => (
                  <button
                    key={label}
                    type="button"
                    className="quote-reference-chip"
                    onClick={() => onRemoveSelectionReference(label)}
                    title="Remove this reference"
                  >
                    {label}
                  </button>
                ))}
              </div>
              {selectionImageDataUrl && (
                <img className="quote-selection-image" src={selectionImageDataUrl} alt="Selected PDF region" />
              )}
            </div>
          )}
          <div className="follow-up-input-row">
            <input
              type="text"
              value={questionDrafts[sectionId] ?? ""}
              disabled={pending || needsSettings}
              placeholder={placeholder}
              onChange={(event) => onQuestionDraftChange(sectionId, event.target.value)}
              onFocus={() => onOpenCardQuestion(sectionId)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (hasContent) {
                    onAskCardQuestion(sectionId);
                  }
                }
              }}
            />
            <button type="submit" disabled={pending || needsSettings || !hasContent}>
              {pending ? "Asking..." : "Ask"}
            </button>
          </div>
        </form>
      </>
    );
  };
  return (
    <>
      <section className="page-meta">
        <div>
          <span>{pdfDocument.pageCount} pages</span>
          <a href={pdfDocument.sourceUrl} target="_blank" rel="noreferrer">
            Open PDF
          </a>
        </div>
        <p>{pdfDocument.sourceUrl}</p>
      </section>

      {needsSettings && (
        <section className="warning">
          <strong>PDF settings needed</strong>
          <span>
            {pdfAnalysisMode === "deep"
              ? "Add your deep PDF summary API key, endpoint, and model before analysis."
              : "Add your API key, endpoint, and PDF parsing model before asking about this PDF."}
          </span>
          <button type="button" onClick={onOpenSettings}>
            Open settings
          </button>
        </section>
      )}

      {pdfAnalysisMode === "deep" && needsParserSettings && (
        <section className="warning">
          <strong>Datalab settings needed</strong>
          <span>Add your Datalab API key and parser endpoint before deep parsing this PDF.</span>
          <button type="button" onClick={onOpenSettings}>
            Open settings
          </button>
        </section>
      )}

      <section className="pdf-panel">
        <div className="pdf-mode-switch" role="group" aria-label="PDF analysis mode">
          <button
            type="button"
            className={pdfAnalysisMode === "visual" ? "active" : ""}
            onClick={() => onModeChange("visual")}
          >
            图片解析
          </button>
          <button
            type="button"
            className={pdfAnalysisMode === "deep" ? "active" : ""}
            onClick={() => onModeChange("deep")}
          >
            深度解析
          </button>
        </div>

        {pdfAnalysisMode === "deep" ? (
          <div className="pdf-deep-actions">
            <button className="pdf-guide-button" type="button" disabled={!canParseDeepPdf} onClick={onParseDeepPdf}>
              {deepPdfParseState === "running" ? "Parsing with Datalab..." : deepPdfParse ? "Re-parse PDF" : "Parse with Datalab"}
            </button>
            <button className="pdf-guide-button" type="button" disabled={!canAnalyze} onClick={onGenerateGuide}>
              {analysisState === "running" ? "Analyzing pages..." : analysis ? "Re-analyze pages" : "Analyze parsed pages"}
            </button>
            <button className="secondary-button" type="button" disabled={!deepPdfParse} onClick={onToggleDeepBoundingBoxes}>
              {showAllDeepPdfBoundingBoxes ? "Hide bounding boxes" : "Show bounding boxes"}
            </button>
          </div>
        ) : (
          <button className="pdf-guide-button" type="button" disabled={!canGenerateGuide} onClick={onGenerateGuide}>
            {analysisState === "running" ? "Analyzing PDF..." : analysis ? "Re-analyze PDF" : "Analyze PDF"}
          </button>
        )}

        <div className="pdf-controls">
          <label>
            <span>{pdfAnalysisMode === "deep" ? "Pages to parse" : "Pages sent to model"}</span>
            <input value={pageRange} onChange={(event) => onPageRangeChange(event.target.value)} placeholder="all or 1-5" />
          </label>
          <label>
            <span>Focus page</span>
            <input
              type="number"
              min={1}
              max={pdfDocument.pageCount}
              value={targetPage}
              onChange={(event) => onTargetPageChange(event.target.value)}
            />
          </label>
        </div>

        {pdfAnalysisMode === "deep" && (
          <button className="secondary-button" type="button" disabled={state === "running"} onClick={onUseSelection}>
            Use viewer selection on active card
          </button>
        )}
      </section>

      {analysisState === "running" && (
        <Status
          text={
            pdfAnalysisMode === "deep"
              ? `Analyzing parsed page ${completedDeepSections + 1} of ${deepPdfParse?.sections.length ?? 0}. ${completedDeepSections} done.`
              : runningPage
              ? `Analyzing page ${runningPage} of ${pdfDocument.pageCount}. ${completedPages} done.`
              : "Preparing PDF overview..."
          }
        />
      )}
      {analysisState === "error" && (
        <section className="error-box">
          <strong>PDF analysis failed</strong>
          <p>{analysisError}</p>
          {rawAnalysisError && <pre>{rawAnalysisError}</pre>}
        </section>
      )}
      {guideState === "error" && (
        <section className="error-box">
          <strong>PDF page guide failed</strong>
          <p>{guideError}</p>
          {guideRawError && <pre>{guideRawError}</pre>}
        </section>
      )}

      {analysis?.overall.summary && analysis.overall.why_read && (
        <section className="overall">
          <h2>Overall</h2>
          <InfoBlock title="Summary" body={analysis.overall.summary} />
          <InfoBlock title="Why read this" body={analysis.overall.why_read} />
        </section>
      )}

      {state === "running" && <Status text="Rendering PDF pages and sending them to the vision model..." />}
      {state === "error" && (
        <section className="error-box">
          <strong>PDF question failed</strong>
          <p>{error}</p>
          {rawError && <pre>{rawError}</pre>}
        </section>
      )}

      {pdfAnalysisMode === "deep" && (
        <>
          {deepPdfParseState === "running" && <Status text={deepPdfParseStatus || "Parsing PDF with Datalab..."} />}
          {deepPdfParseState === "done" && deepPdfParseStatus && <p className="pdf-deep-status">{deepPdfParseStatus}</p>}
          {deepPdfParse?.parseQualityScore !== undefined && (
            <p className="pdf-deep-status">Parse quality: {deepPdfParse.parseQualityScore.toFixed(1)} / 5</p>
          )}
          {deepPdfParseState === "error" && (
            <section className="error-box">
              <strong>Datalab parse failed</strong>
              <p>{deepPdfParseError}</p>
              {deepPdfParseRawError && <pre>{deepPdfParseRawError}</pre>}
            </section>
          )}
          {!deepPdfParse && deepPdfParseState !== "running" && (
            <p className="pdf-deep-empty">Parse this PDF first to create page-level text and layout blocks with bounding boxes.</p>
          )}
          {deepPdfParse && (
            <div className="pdf-deep-section-list">
              {deepPdfParse.sections.map((section) => {
                const result = analysis?.sections.find((item) => item.id === section.id);
                const sectionStatus = sectionAnalyzeState[section.id];
                return (
                  <article
                    className={`pdf-deep-section-card${activeDeepPdfSectionId === section.id ? " active" : ""}`}
                    data-learn-panel-section-card-id={section.id}
                    key={section.id}
                    onClick={() => onFocusDeepSection(section)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onFocusDeepSection(section);
                      onOpenCardQuestion(section.id);
                    }}
                    onMouseEnter={() => {
                      if (activeDeepPdfSectionId !== section.id) {
                        onFocusDeepSection(section);
                      }
                    }}
                  >
                    <div className="pdf-page-header">
                      <span>{formatPdfSectionPageTitle(section.pageStart, section.pageEnd)}</span>
                      <strong>{section.blocks.length} blocks</strong>
                      {sectionStatus && sectionStatus !== "done" && (
                        <span className={`section-status ${sectionStatus}`}>{formatSectionAnalyzeState(sectionStatus)}</span>
                      )}
                    </div>
                    {!isRedundantPdfSectionTitle(section.title, section.pageStart, section.pageEnd) && <h3>{section.title}</h3>}
                    {result ? (
                      <div className="pdf-page-guide">
                        <InfoBlock title="Summary" body={result.summary} pdfPage={section.pageStart} />
                        <InfoBlock title="What this means" body={result.interpretation} pdfPage={section.pageStart} />
                        <InfoBlock title="Role in PDF" body={result.role_in_article} pdfPage={section.pageStart} />
                      </div>
                    ) : (
                      <>
                        <p className="preview">{formatDeepPdfPreview(section.text)}</p>
                        {sectionStatus && sectionStatus !== "done" && (
                          <p className={`section-progress ${sectionStatus}`}>
                            {sectionStatus === "error"
                              ? sectionAnalyzeErrors[section.id] || "This parsed page failed to analyze."
                              : sectionStatus === "running"
                                ? "Analyzing this parsed page now..."
                                : "Waiting for earlier parsed pages..."}
                          </p>
                        )}
                      </>
                    )}
                    {renderPdfCardQa(section.id, "Ask about this page...")}
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}

      {pdfAnalysisMode === "visual" && <section className="pdf-pages">
        <div className="pdf-pages-header">
          <h2>Pages</h2>
          <span>
            {pageImages.length} / {pdfDocument.pageCount} rendered
          </span>
        </div>
        {previewState === "rendering" && <Status text="Rendering PDF page previews..." />}
        {previewState === "error" && (
          <section className="error-box">
            <strong>PDF preview failed</strong>
            <p>{previewError}</p>
          </section>
        )}
        <div className="pdf-page-list">
          {pageImages.map((image) => {
            const pageGuide = guideByPage.get(image.page);
            const pageAnalysis = analysisByPage.get(image.page);
            const sectionId = `${PDF_PAGE_SECTION_PREFIX}${image.page}`;
            const pageStatus = sectionAnalyzeState[sectionId];
            return (
              <article
                className={`pdf-page-card${image.page === focusedPage ? " active" : ""}${image.page === followedPdfPage ? " followed" : ""}`}
                data-learn-panel-pdf-page={image.page}
                key={image.page}
                onClick={() => onFocusPage(image.page)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onFocusPage(image.page);
                  onOpenCardQuestion(sectionId);
                }}
              >
                <div className="pdf-page-header">
                  <span>Page {image.page}</span>
                  {image.page === focusedPage && <strong>Focus</strong>}
                  {pageStatus && pageStatus !== "done" && (
                    <span className={`section-status ${pageStatus}`}>{formatSectionAnalyzeState(pageStatus)}</span>
                  )}
                </div>
                {pageAnalysis ? (
                  <div className="pdf-page-guide">
                    <InfoBlock title="Summary" body={pageAnalysis.summary} pdfPage={image.page} />
                    <InfoBlock title="What this means" body={pageAnalysis.interpretation} pdfPage={image.page} />
                    <InfoBlock title="Role in PDF" body={pageAnalysis.role_in_article} pdfPage={image.page} />
                  </div>
                ) : pageGuide ? (
                  <div className="pdf-page-guide">
                    <InfoBlock title="Summary" body={pageGuide.summary} pdfPage={image.page} />
                    <InfoBlock title="Explanation" body={pageGuide.explanation} pdfPage={image.page} />
                    <InfoBlock title="Goal" body={pageGuide.goal} pdfPage={image.page} />
                  </div>
                ) : (
                  <div className="pdf-page-image-button">
                    <img src={image.dataUrl} alt={`PDF page ${image.page}`} loading="lazy" />
                  </div>
                )}
                {!pageAnalysis && pageStatus && pageStatus !== "done" && (
                  <p className={`section-progress ${pageStatus}`}>
                    {pageStatus === "error"
                      ? sectionAnalyzeErrors[sectionId] || "This page failed to analyze."
                      : pageStatus === "running"
                        ? "Analyzing this page now..."
                        : "Waiting for earlier pages..."}
                  </p>
                )}
                {renderPdfCardQa(sectionId, "Ask about this page...")}
              </article>
            );
          })}
        </div>
      </section>}
    </>
  );
}

function PdfLanding({
  sourceUrl,
  onOpenInViewer,
  onOpenLocal
}: {
  sourceUrl: string;
  onOpenInViewer: (sourceUrl: string) => void;
  onOpenLocal: () => void;
}) {
  return (
    <section className="pdf-landing">
      <div className="pdf-landing-icon">📄</div>
      <h2>PDF Detected</h2>
      <p className="pdf-landing-url">{sourceUrl}</p>
      <p className="pdf-landing-desc">Open this PDF in the custom viewer for full page-following and analysis support.</p>
      <button
        className="pdf-landing-open-button"
        type="button"
        onClick={() => onOpenInViewer(sourceUrl)}
      >
        Open in PDF Viewer
      </button>
      <button
        className="pdf-landing-local-button"
        type="button"
        onClick={onOpenLocal}
      >
        Open Local PDF
      </button>
    </section>
  );
}

function HistoryView({
  history,
  importNotice,
  onClear,
  onDelete,
  onImport,
  onRestore
}: {
  history: HistoryEntry[];
  importNotice: { type: "info" | "error"; text: string } | null;
  onClear: () => void;
  onDelete: (entry: HistoryEntry) => void;
  onImport: () => void;
  onRestore: (entry: HistoryEntry) => void;
}) {
  return (
    <section className="history-panel">
      <div className="history-header">
        <div>
          <h2>History</h2>
          <p>{history.length} saved pages</p>
        </div>
        <div className="history-actions">
          <button className="secondary-button" type="button" onClick={onImport}>
            Import
          </button>
          <button className="secondary-button" type="button" disabled={history.length === 0} onClick={onClear}>
            Clear
          </button>
        </div>
      </div>
      {importNotice && <p className={`history-import-notice ${importNotice.type}`}>{importNotice.text}</p>}
      {history.length === 0 ? (
        <p className="history-empty">Analyzed pages and follow-up questions will show up here.</p>
      ) : (
        <div className="history-list">
          {history.map((entry) => (
            <article className="history-item" key={entry.id}>
              <button className="history-main" type="button" onClick={() => onRestore(entry)}>
                <span>{entry.article.siteName}</span>
                <strong>{entry.article.title}</strong>
                <small>{formatHistoryTime(entry.updatedAt)}</small>
              </button>
              <button className="danger-button" type="button" onClick={() => onDelete(entry)}>
                Delete
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Status({ text }: { text: string }) {
  return <p className="status">{text}</p>;
}

function EmptyState({
  title,
  body,
  actionLabel,
  onAction
}: {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <section className="empty-state">
      <h2>{title}</h2>
      <p>{body}</p>
      <button type="button" onClick={onAction}>
        {actionLabel}
      </button>
    </section>
  );
}

function FollowUpItem({
  item,
  defaultExpanded
}: {
  item: SectionFollowUp;
  defaultExpanded: boolean;
}) {
  // null = no lock, true/false = locked state
  const [locked, setLocked] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);

  const isExpanded = locked !== null ? locked : (defaultExpanded || hovered);

  return (
    <div
      className={`follow-up-item${isExpanded ? " expanded" : " collapsed"}`}
      title={!isExpanded ? item.answer : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        // If locked, toggle the lock; if unlocked, lock to the opposite of the current visual state
        setLocked((prev) => (prev === null ? !isExpanded : !prev));
      }}
    >
      <h4 className="follow-up-question">
        <span className="follow-up-chevron">{isExpanded ? "▾" : "▸"}</span>
        <InlineMarkup text={item.question} />
      </h4>
      {isExpanded && (
        <div className="follow-up-answer">
          <MarkupBlocks text={item.answer} />
        </div>
      )}
    </div>
  );
}

function InfoBlock({ title, body, pdfPage }: { title: string; body: string; pdfPage?: number }) {
  const displayBody = pdfPage ? stripRepeatedPdfPageLabel(body, pdfPage) : body;
  return (
    <div className="info-block">
      <h3>{title}</h3>
      <MarkupBlocks text={displayBody} />
    </div>
  );
}

function stripRepeatedPdfPageLabel(text: string, page: number) {
  const pageLabel = String(page);
  const prefix = String.raw`(^|\n)(\s*(?:(?:[-*•]|\d+[.)])\s+)?)(?:\*\*)?`;
  const suffix = String.raw`\s*[:：.\-–—]?\s*(?:\*\*)?\s*`;
  return text
    .replace(new RegExp(`${prefix}(?:PDF\\s+)?Page\\s+${pageLabel}${suffix}`, "gi"), "$1$2")
    .replace(new RegExp(`${prefix}P\\.?\\s*${pageLabel}${suffix}`, "gi"), "$1$2")
    .replace(new RegExp(`${prefix}第\\s*${pageLabel}\\s*页${suffix}`, "g"), "$1$2")
    .trimStart();
}

function formatPdfSectionPageTitle(pageStart: number, pageEnd: number) {
  return pageStart === pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}-${pageEnd}`;
}

function isRedundantPdfSectionTitle(title: string, pageStart: number, pageEnd: number) {
  return title.trim().toLowerCase() === formatPdfSectionPageTitle(pageStart, pageEnd).toLowerCase();
}

function formatDeepPdfPreview(text: string) {
  return text
    .replace(/^\[Page\s+\d+\s+\|\s+[^\]\n]+\]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <pre className="markup-code-block">
      {language && <span className="markup-code-language">{language}</span>}
      <code>{code}</code>
    </pre>
  );
}

function MarkupBlocks({ text }: { text: string }) {
  const lines = normalizeMarkupText(text).split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const codeBlock = readCodeBlock(lines, index);
    if (codeBlock) {
      blocks.push(<CodeBlock key={`code-${index}`} code={codeBlock.code} language={codeBlock.language} />);
      index = codeBlock.nextIndex;
      continue;
    }

    const mathBlock = readMathBlock(lines, index);
    if (mathBlock) {
      blocks.push(<MathFormula key={`math-${index}`} formula={mathBlock.formula} display />);
      index = mathBlock.nextIndex;
      continue;
    }

    if (isHorizontalRule(lines[index])) {
      blocks.push(<hr className="markup-divider" key={`divider-${index}`} />);
      index += 1;
      continue;
    }

    const heading = readHeadingLine(lines[index]);
    if (heading) {
      blocks.push(
        <h4 className={`markup-heading level-${heading.level}`} key={`heading-${index}`}>
          <InlineMarkup text={heading.text} />
        </h4>
      );
      index += 1;
      continue;
    }

    if (isBlockquoteLine(lines[index])) {
      const quoteLines: string[] = [];
      while (index < lines.length && isBlockquoteLine(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote className="markup-blockquote" key={`quote-${index}`}>
          <MarkupBlocks text={quoteLines.join("\n")} />
        </blockquote>
      );
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && isMarkdownTableBlockLine(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      blocks.push(<MarkdownTable key={`table-${index}`} lines={tableLines} />);
      continue;
    }

    const listInfo = readListLine(lines[index]);
    if (listInfo) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = readListLine(lines[index]);
        if (!item || item.ordered !== listInfo.ordered) {
          break;
        }
        items.push(item.text);
        index += 1;
      }
      const ListTag = listInfo.ordered ? "ol" : "ul";
      blocks.push(
        <ListTag className="markup-list" key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>
              <InlineMarkup text={item} />
            </li>
          ))}
        </ListTag>
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !readListLine(lines[index]) &&
      !readCodeBlock(lines, index) &&
      !readHeadingLine(lines[index]) &&
      !isBlockquoteLine(lines[index]) &&
      !isHorizontalRule(lines[index]) &&
      !isMathBlockStart(lines[index]) &&
      !isMarkdownTableStart(lines, index)
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        <InlineMarkup text={paragraphLines.join("\n")} />
      </p>
    );
  }

  return <>{blocks}</>;
}

function readCodeBlock(lines: string[], index: number) {
  const opening = lines[index].trim().match(/^(```|~~~)\s*([\w.+-]*)\s*$/);
  if (!opening) {
    return null;
  }

  const fence = opening[1];
  const language = opening[2] || undefined;
  const codeLines: string[] = [];
  let currentIndex = index + 1;
  while (currentIndex < lines.length) {
    if (lines[currentIndex].trim() === fence) {
      return { code: codeLines.join("\n"), language, nextIndex: currentIndex + 1 };
    }
    codeLines.push(lines[currentIndex]);
    currentIndex += 1;
  }

  return { code: codeLines.join("\n"), language, nextIndex: currentIndex };
}

function readHeadingLine(line: string) {
  const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!heading) {
    return null;
  }
  return { level: heading[1].length, text: heading[2] };
}

function isBlockquoteLine(line: string) {
  return /^\s*>\s?/.test(line);
}

function isHorizontalRule(line: string) {
  return /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function MarkdownTable({ lines }: { lines: string[] }) {
  const rows = lines
    .filter((line) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
    .map(parseTableRow)
    .filter((cells) => cells.length > 0);

  if (rows.length === 0) {
    return null;
  }

  const [header, ...bodyRows] = rows;
  return (
    <div className="markup-table-wrap">
      <table className="markup-table">
        <thead>
          <tr>
            {header.map((cell, cellIndex) => (
              <th key={`${cell}-${cellIndex}`}>
                <InlineMarkup text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, rowIndex) => (
            <tr key={`${row.join("|")}-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cell}-${cellIndex}`}>
                  <InlineMarkup text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isListLine(line: string) {
  return Boolean(readListLine(line));
}

function readListLine(line: string) {
  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  if (ordered) {
    return { ordered: true, text: ordered[1] };
  }
  const unordered = line.match(/^\s*[-*•]\s+(.+)$/);
  if (unordered) {
    return { ordered: false, text: unordered[1] };
  }
  return null;
}

function normalizeMarkupText(text: string) {
  const withRealLineBreaks = text.replace(/\\n/g, "\n");
  if (/\r?\n/.test(withRealLineBreaks)) {
    return withRealLineBreaks;
  }

  const inlineListMarkers = withRealLineBreaks.match(/(?:^|\s)(?:[-*•]|\d+[.)])\s+\S/g) ?? [];
  if (inlineListMarkers.length < 2) {
    return withRealLineBreaks;
  }

  return withRealLineBreaks.replace(/\s+(?=(?:[-*•]|\d+[.)])\s+\S)/g, "\n");
}

function isMarkdownTableStart(lines: string[], index: number) {
  const current = lines[index]?.trim() ?? "";
  const next = lines[index + 1]?.trim() ?? "";
  return isMarkdownTableLine(current) && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(next);
}

function isMarkdownTableLine(line: string) {
  const trimmed = line.trim();
  return trimmed.includes("|") && !/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(trimmed);
}

function isMarkdownTableBlockLine(line: string) {
  const trimmed = line.trim();
  return trimmed.includes("|") || /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed);
}

function parseTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

type InlineMarkupToken =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "em"; value: string }
  | { type: "code"; value: string }
  | { type: "math"; value: string; display: boolean };

type InlineMarkupMatch = {
  start: number;
  end: number;
  token: InlineMarkupToken;
};

const MATH_BLOCK_DELIMITERS = [
  { open: "\\[", close: "\\]" },
  { open: "\\\\[", close: "\\\\]" },
  { open: "$$", close: "$$" }
] as const;

function readMathBlock(lines: string[], index: number) {
  const trimmed = lines[index].trim();
  const delimiter = MATH_BLOCK_DELIMITERS.find((item) => trimmed.startsWith(item.open));
  if (!delimiter) {
    return null;
  }

  let current = trimmed.slice(delimiter.open.length);
  const formulaLines: string[] = [];
  let currentIndex = index;

  while (currentIndex < lines.length) {
    const closeIndex = current.indexOf(delimiter.close);
    if (closeIndex >= 0) {
      formulaLines.push(current.slice(0, closeIndex));
      return {
        formula: formulaLines.join("\n").trim(),
        nextIndex: currentIndex + 1
      };
    }

    formulaLines.push(current);
    currentIndex += 1;
    current = lines[currentIndex] ?? "";
  }

  return null;
}

function isMathBlockStart(line: string) {
  const trimmed = line.trim();
  return MATH_BLOCK_DELIMITERS.some((item) => trimmed.startsWith(item.open));
}

function InlineMarkup({ text }: { text: string }) {
  const parts = tokenizeInlineMarkup(text);
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "strong") {
          return (
            <strong key={`${part.value}-${index}`}>
              <InlineMarkup text={part.value} />
            </strong>
          );
        }
        if (part.type === "em") {
          return (
            <em key={`${part.value}-${index}`}>
              <InlineMarkup text={part.value} />
            </em>
          );
        }
        if (part.type === "code") {
          return <code key={`${part.value}-${index}`}>{part.value}</code>;
        }
        if (part.type === "math") {
          return <MathFormula key={`${part.value}-${index}`} formula={part.value} display={part.display} block={false} />;
        }
        return <React.Fragment key={`${part.value}-${index}`}>{part.value}</React.Fragment>;
      })}
    </>
  );
}

function tokenizeInlineMarkup(text: string): InlineMarkupToken[] {
  const tokens: InlineMarkupToken[] = [];
  let index = 0;

  while (index < text.length) {
    const next = findNextInlineMarkup(text, index);
    if (!next) {
      tokens.push({ type: "text", value: text.slice(index) });
      break;
    }

    if (next.start > index) {
      tokens.push({ type: "text", value: text.slice(index, next.start) });
    }
    tokens.push(next.token);
    index = next.end;
  }

  return tokens.filter((token) => token.value.length > 0);
}

function findNextInlineMarkup(text: string, from: number): InlineMarkupMatch | null {
  const candidates = [
    findDelimitedToken(text, from, "`", "`", "code"),
    findDelimitedToken(text, from, "**", "**", "strong"),
    findEmphasisToken(text, from),
    findDelimitedToken(text, from, "\\(", "\\)", "math", false),
    findDelimitedToken(text, from, "\\\\(", "\\\\)", "math", false),
    findDelimitedToken(text, from, "\\[", "\\]", "math", true),
    findDelimitedToken(text, from, "\\\\[", "\\\\]", "math", true),
    findDelimitedToken(text, from, "$$", "$$", "math", true),
    findDollarMathToken(text, from)
  ].filter((candidate): candidate is InlineMarkupMatch => candidate !== null);

  return candidates.sort((left, right) => left.start - right.start)[0] ?? null;
}

function findDelimitedToken(
  text: string,
  from: number,
  open: string,
  close: string,
  type: "strong" | "code" | "math",
  display = false
) {
  const start = text.indexOf(open, from);
  if (start < 0) {
    return null;
  }
  const valueStart = start + open.length;
  const closeIndex = text.indexOf(close, valueStart);
  if (closeIndex < 0) {
    return null;
  }

  return {
    start,
    end: closeIndex + close.length,
    token: {
      type,
      value: text.slice(valueStart, closeIndex),
      ...(type === "math" ? { display } : {})
    } as InlineMarkupToken
  } satisfies InlineMarkupMatch;
}

function findEmphasisToken(text: string, from: number) {
  let start = text.indexOf("*", from);
  while (start >= 0) {
    const previous = text[start - 1] ?? "";
    const next = text[start + 1] ?? "";
    if (previous !== "*" && next !== "*" && next.trim()) {
      let close = text.indexOf("*", start + 1);
      while (close >= 0) {
        const beforeClose = text[close - 1] ?? "";
        const afterClose = text[close + 1] ?? "";
        if (beforeClose.trim() && beforeClose !== "*" && afterClose !== "*") {
          return {
            start,
            end: close + 1,
            token: {
              type: "em",
              value: text.slice(start + 1, close)
            } as InlineMarkupToken
          } satisfies InlineMarkupMatch;
        }
        close = text.indexOf("*", close + 1);
      }
    }
    start = text.indexOf("*", start + 1);
  }

  return null;
}

function findDollarMathToken(text: string, from: number) {
  let start = text.indexOf("$", from);
  while (start >= 0) {
    const previous = text[start - 1] ?? "";
    const next = text[start + 1] ?? "";
    if (next !== "$" && previous !== "\\" && next.trim() && !/[\d,.]/.test(next)) {
      const close = findClosingDollar(text, start + 1);
      if (close >= 0) {
        return {
          start,
          end: close + 1,
          token: {
            type: "math",
            value: text.slice(start + 1, close),
            display: false
          } as InlineMarkupToken
        } satisfies InlineMarkupMatch;
      }
    }
    start = text.indexOf("$", start + 1);
  }

  return null;
}

function findClosingDollar(text: string, from: number) {
  let index = text.indexOf("$", from);
  while (index >= 0) {
    const previous = text[index - 1] ?? "";
    const next = text[index + 1] ?? "";
    if (previous !== "\\" && next !== "$" && previous.trim()) {
      return index;
    }
    index = text.indexOf("$", index + 1);
  }

  return -1;
}

function MathFormula({ formula, display, block = display }: { formula: string; display: boolean; block?: boolean }) {
  const html = useMemo(
    () =>
      katex.renderToString(formula, {
        displayMode: display,
        output: "html",
        strict: "ignore",
        throwOnError: false,
        trust: false
      }),
    [display, formula]
  );

  if (block) {
    return <div className="math-formula math-formula-display" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return <span className="math-formula math-formula-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

function scrollPanelToSection(sectionId: string) {
  const target = document.querySelector<HTMLElement>(
    `[data-learn-panel-section-card-id="${CSS.escape(sectionId)}"]`
  );
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function scrollPanelToPdfPage(page: number) {
  const target = document.querySelector<HTMLElement>(`[data-learn-panel-pdf-page="${page}"]`);
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function buildPdfArticle(pdfDocument: LoadedPdfDocument): ExtractedArticle {
  const sections = Array.from({ length: pdfDocument.pageCount }, (_, index) => {
    const page = index + 1;
    return {
      id: `${PDF_PAGE_SECTION_PREFIX}${page}`,
      title: `Page ${page}`,
      level: 2 as const,
      text: `PDF page ${page}. The page screenshot is attached to the PDF vision model request.`
    };
  });

  return {
    title: pdfDocument.title,
    url: pdfDocument.sourceUrl,
    siteName: "PDF",
    language: "unknown",
    excerpt: `${pdfDocument.pageCount} page PDF document`,
    text: sections.map((section) => section.text).join("\n\n"),
    sections
  };
}

function buildDeepPdfArticle(result: DeepPdfParseResult): ExtractedArticle {
  const rangeLabel = result.pageRange ? ` pages ${fromDatalabPageRangeLabel(result.pageRange)}` : "";
  return {
    title: `${result.title} - 深度解析${rangeLabel}`,
    url: getDeepPdfPageKey(result.sourceUrl, result.pageRange),
    siteName: "PDF Deep",
    language: "unknown",
    excerpt: `${result.pageCount} page PDF parsed by Datalab into ${result.sections.length} pages${rangeLabel}`,
    text: result.sections.map((section) => section.text).join("\n\n"),
    sections: result.sections.map((section) => ({
      id: section.id,
      title: section.title,
      level: section.level,
      text: section.text
    }))
  };
}

function tagDeepPdfSectionBlocks(section: DeepPdfSection): DeepPdfBlock[] {
  return section.blocks.map((block) => ({
    ...block,
    sectionId: section.id
  }));
}

function getDeepPdfPageKey(sourceUrl: string, pageRange = ""): string {
  const suffix = pageRange ? `?range=${encodeURIComponent(pageRange)}` : "";
  return `${sourceUrl}#learn-panel-deep${suffix}`;
}

function getPdfSourceFromArticleUrl(url: string): string {
  return url.replace(/#learn-panel-deep(?:\?range=.*)?$/, "");
}

function getDeepPdfRangeFromArticleUrl(url: string): string {
  const match = url.match(/#learn-panel-deep(?:\?range=([^#]+))?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function getDeepPdfRangeFromViewerUrl(tabUrl: string): string | null {
  try {
    const url = new URL(tabUrl);
    return url.searchParams.has("deepRange") ? url.searchParams.get("deepRange") ?? "" : null;
  } catch {
    return null;
  }
}

function getPdfPageFromSectionId(sectionId: string): number | null {
  if (!sectionId.startsWith(PDF_PAGE_SECTION_PREFIX)) {
    return null;
  }
  const page = Number(sectionId.slice(PDF_PAGE_SECTION_PREFIX.length));
  return Number.isInteger(page) && page > 0 ? page : null;
}

function isKnownPage(page: number | null): page is number {
  return typeof page === "number";
}

function toDatalabPageRange(pages: number[], pageCount: number): string {
  if (pages.length === pageCount && pages[0] === 1 && pages[pages.length - 1] === pageCount) {
    return "";
  }

  const segments: string[] = [];
  let start = pages[0];
  let previous = pages[0];
  for (const page of pages.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    segments.push(formatDatalabRangeSegment(start, previous));
    start = page;
    previous = page;
  }
  segments.push(formatDatalabRangeSegment(start, previous));
  return segments.join(",");
}

function formatDatalabRangeSegment(startPage: number, endPage: number): string {
  const start = startPage - 1;
  const end = endPage - 1;
  return start === end ? String(start) : `${start}-${end}`;
}

function fromDatalabPageRangeLabel(pageRange: string): string {
  return pageRange
    .split(",")
    .map((segment) => {
      const [rawStart, rawEnd] = segment.split("-");
      const start = Number(rawStart);
      const end = rawEnd === undefined ? start : Number(rawEnd);
      return start === end ? String(start + 1) : `${start + 1}-${end + 1}`;
    })
    .join(",");
}

function mergePdfPageImages(existing: PdfPageImage[], next: PdfPageImage[]): PdfPageImage[] {
  const byPage = new Map(existing.map((image) => [image.page, image]));
  next.forEach((image) => byPage.set(image.page, image));
  return [...byPage.values()].sort((a, b) => a.page - b.page);
}

async function getActiveTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }
  return tab as chrome.tabs.Tab & { id: number };
}

async function sendToTab(tabId: number, request: ContentRequest): Promise<ContentResponse> {
  return chrome.tabs.sendMessage(tabId, request);
}

async function sendToViewer(request: ContentRequest): Promise<ContentResponse> {
  return chrome.runtime.sendMessage(request);
}

function mergePdfSelectionReferences(primary: PdfSelectionReference, fallback: PdfSelectionReference): PdfSelectionReference {
  return {
    text: primary.text || fallback.text,
    imageDataUrl: primary.imageDataUrl || fallback.imageDataUrl
  };
}

function parseHistoryImportText(text: string): unknown {
  const embeddedPayload = text.match(/<!--\s*learn-panel-history:v1:([A-Za-z0-9+/=]+)\s*-->/);
  if (embeddedPayload?.[1]) {
    return JSON.parse(decodeBase64Json(embeddedPayload[1]));
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  throw new Error("Choose a Learn Panel Markdown export or JSON history snapshot.");
}

function getImportedEntryFromValue(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const maybePayload = value as Partial<HistoryExportPayload>;
  const candidate = maybePayload.schema === HISTORY_EXPORT_SCHEMA ? maybePayload.entry : value;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const entry = candidate as Partial<HistoryEntry>;
  const candidateArticle = entry.article as Partial<ExtractedArticle> | undefined;
  return candidateArticle && typeof candidateArticle.url === "string" ? (entry as HistoryEntry) : null;
}

function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64Json(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function getPageKey(url: string): string {
  return url;
}

function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function getPdfQuoteReferenceLabels(value: string): string[] {
  const labels = [...value.matchAll(/^\[Page\s+\d+\s+\|\s+[^\]\n]+\]/gm)].map((match) => match[0]);
  if (labels.length === 0) {
    return ["Selected PDF text"];
  }

  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => (count > 1 ? `${label} x${count}` : label));
}

function removePdfQuoteReference(value: string, referenceLabel: string): string {
  const references = parsePdfQuoteReferences(value);
  if (references.length === 0) {
    return "";
  }

  const targetLabel = normalizePdfReferenceLabel(referenceLabel);
  return references
    .filter((reference) => normalizePdfReferenceLabel(reference.label) !== targetLabel)
    .map((reference) => `${reference.label}\n${reference.text}`.trim())
    .join("\n\n");
}

function parsePdfQuoteReferences(value: string): Array<{ label: string; text: string }> {
  return [...value.matchAll(/^(\[Page\s+\d+\s+\|\s+[^\]\n]+\])\n([\s\S]*?)(?=^\[Page\s+\d+\s+\|\s+[^\]\n]+\]\n|\s*$)/gm)]
    .map((match) => ({
      label: match[1],
      text: match[2].trim()
    }))
    .filter((reference) => reference.label && reference.text);
}

function normalizePdfReferenceLabel(label: string): string {
  return label.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/\s+x\d+$/i, "");
}

function formatPdfQuoteTitle(value: string): string {
  return getPdfQuoteReferenceLabels(value).join("\n");
}

function formatPages(pages: number[]): string {
  if (pages.length <= 8) {
    return pages.join(", ");
  }
  return `${pages.slice(0, 4).join(", ")} ... ${pages.slice(-2).join(", ")}`;
}

function formatSectionAnalyzeState(state: SectionAnalyzeState): string {
  if (state === "running") {
    return "Analyzing";
  }
  if (state === "error") {
    return "Failed";
  }
  if (state === "done") {
    return "Done";
  }
  return "Waiting";
}

function formatHistoryTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(value);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

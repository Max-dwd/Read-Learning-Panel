import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
  loadHistory,
  saveHistoryEntry,
  updateHistoryScrollPos,
  type HistoryEntry
} from "../shared/history";
import { analyzeArticleProgressively, answerPdfQuestion, answerSectionQuestion, generatePdfGuide } from "../shared/model";
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
import { getActiveApiKey, getActivePdfApiKey, loadSettings } from "../shared/settings";
import type {
  AnalysisResult,
  ContentRequest,
  ContentResponse,
  ExtractedArticle,
  PdfGuideResult,
  SectionFollowUp,
  Settings
} from "../shared/types";
import "./styles.css";

type LoadState = "idle" | "loading" | "ready" | "error";
type AnalyzeState = "idle" | "running" | "done" | "error";
type SectionAnalyzeState = "queued" | "running" | "done" | "error";
type ViewMode = "reader" | "history";
type DocumentMode = "article" | "pdf";
type PdfQuestionState = "idle" | "running" | "error";
type PdfPreviewState = "idle" | "rendering" | "ready" | "error";

function isCustomPdfViewerUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "chrome-extension:" && u.pathname.endsWith("/pdfviewer.html");
  } catch {
    return false;
  }
}

function getCustomViewerUrl(pdfSourceUrl: string): string {
  const viewerBase = chrome.runtime.getURL("dist/pdfviewer.html");
  return `${viewerBase}?src=${encodeURIComponent(pdfSourceUrl)}`;
}
type PdfAnswer = {
  question: string;
  answer: string;
  pages: number[];
  targetPage: number | null;
  createdAt: number;
};
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
  const cacheRef = useRef(new Map<string, PageCacheEntry>());
  const pdfDocumentRef = useRef<LoadedPdfDocument | null>(null);
  const currentPageKeyRef = useRef("");
  const loadVersionRef = useRef(0);
  const pdfPreviewVersionRef = useRef(0);
  const analysisVersionRef = useRef(0);
  const analysisStateRef = useRef<AnalyzeState>("idle");
  const runningSectionIdRef = useRef<string | null>(null);
  const followEnabledRef = useRef(false);

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
    if (viewMode === "reader" && loadState === "ready" && article) {
      const cached = cacheRef.current.get(currentPageKeyRef.current);
      if (cached && typeof cached.scrollPos === "number") {
        // Use a small delay to ensure DOM is fully rendered and layout is stable
        const restore = () => {
          window.scrollTo({ top: cached.scrollPos, behavior: "instant" });
        };
        restore();
        // Sometimes content changes height after initial render, try again
        requestAnimationFrame(restore);
        setTimeout(restore, 50);
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
        if (currentPdf && nextPdfSource === currentPdf.sourceUrl) {
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
    setLoadState("loading");
    setLoadError("");

    try {
      const tab = await getActiveTab();
      setActiveTabId(tab.id);

      if (getPdfSourceUrl(tab.url)) {
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
    }
  }

  async function loadActivePdf(tabUrl: string, loadVersion: number, force: boolean) {
    const inCustomViewer = isCustomPdfViewerUrl(tabUrl);
    setIsInCustomViewer(inCustomViewer);

    const currentPdf = pdfDocumentRef.current;
    if (!force && currentPdf?.url === tabUrl) {
      setPdfDocument(currentPdf);
      setLoadState("ready");
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
    setFollowedSectionId(null);
    setFollowedPdfPage(null);
    currentPageKeyRef.current = tabUrl;

    // If not in custom viewer, show landing screen without loading the PDF
    if (!inCustomViewer) {
      setLoadState("ready");
      return;
    }

    const loadedPdf = await loadPdfDocument(tabUrl);
    if (loadVersion !== loadVersionRef.current) {
      return;
    }

    const targetPage = Math.min(getPdfTargetPageFromUrl(tabUrl), loadedPdf.pageCount);
    pdfDocumentRef.current = loadedPdf;
    setPdfDocument(loadedPdf);
    setPdfPageRange("all");
    setPdfTargetPage(String(targetPage));
    setPdfQuestion("");
    setPdfAnswers([]);
    setPdfGuide(null);
    setPdfGuideState("idle");
    setPdfGuideError("");
    setPdfGuideRawError("");
    setLoadState("ready");
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

      result = await analyzeArticleProgressively(articleForAnalysis, currentSettings, (event) => {
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
      });
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

    const question = normalizeQuestion(pdfQuestion);
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
      setPdfQuestionState("idle");
    } catch (error) {
      const typedError = error as Error & { raw?: string };
      setPdfQuestionState("error");
      setPdfError(typedError.message);
      setPdfRawError(typedError.raw ?? "");
    }
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
    } catch (error) {
      const typedError = error as Error & { raw?: string };
      setPdfGuideState("error");
      setPdfGuideError(typedError.message);
      setPdfGuideRawError(typedError.raw ?? "");
    }
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
    try {
      const tab = await getActiveTab();
      const response = await sendToTab(tab.id, { type: "LEARN_PANEL_GET_SELECTION" });
      if (response.ok && "selection" in response) {
        return response.selection;
      }
    } catch {
      // ignore
    }
    return "";
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

  function restoreHistoryEntry(entry: HistoryEntry) {
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
          onClear={() => void removeAllHistory()}
          onDelete={(entry) => void removeHistoryEntry(entry)}
          onRestore={restoreHistoryEntry}
        />
      )}

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

      {viewMode === "reader" && documentMode === "pdf" && isInCustomViewer && pdfDocument && (
        <PdfReader
          pdfDocument={pdfDocument}
          pageRange={pdfPageRange}
          targetPage={pdfTargetPage}
          question={pdfQuestion}
          answers={pdfAnswers}
          guide={pdfGuide}
          guideState={pdfGuideState}
          guideError={pdfGuideError}
          guideRawError={pdfGuideRawError}
          followedPdfPage={followedPdfPage}
          pageImages={pdfPageImages}
          previewState={pdfPreviewState}
          previewError={pdfPreviewError}
          state={pdfQuestionState}
          error={pdfError}
          rawError={pdfRawError}
          needsSettings={needsPdfSettings}
          onPageRangeChange={setPdfPageRange}
          onTargetPageChange={setPdfTargetPage}
          onQuestionChange={setPdfQuestion}
          onGenerateGuide={() => void runPdfGuide()}
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
  answers,
  guide,
  guideState,
  guideError,
  guideRawError,
  followedPdfPage,
  pageImages,
  previewState,
  previewError,
  state,
  error,
  rawError,
  needsSettings,
  onPageRangeChange,
  onTargetPageChange,
  onQuestionChange,
  onGenerateGuide,
  onFocusPage,
  onAsk,
  onOpenSettings
}: {
  pdfDocument: LoadedPdfDocument;
  pageRange: string;
  targetPage: string;
  question: string;
  answers: PdfAnswer[];
  guide: PdfGuideResult | null;
  guideState: PdfQuestionState;
  guideError: string;
  guideRawError: string;
  followedPdfPage: number | null;
  pageImages: PdfPageImage[];
  previewState: PdfPreviewState;
  previewError: string;
  state: PdfQuestionState;
  error: string;
  rawError: string;
  needsSettings: boolean;
  onPageRangeChange: (value: string) => void;
  onTargetPageChange: (value: string) => void;
  onQuestionChange: (value: string) => void;
  onGenerateGuide: () => void;
  onFocusPage: (page: number) => void;
  onAsk: () => void;
  onOpenSettings: () => void;
}) {
  const canAsk = !needsSettings && state !== "running" && normalizeQuestion(question);
  const canGenerateGuide = !needsSettings && guideState !== "running";
  const focusedPage = Number(targetPage);
  const guideByPage = useMemo(() => new Map((guide?.pages ?? []).map((pageGuide) => [pageGuide.page, pageGuide])), [guide]);
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
          <span>Add your API key, endpoint, and PDF parsing model before asking about this PDF.</span>
          <button type="button" onClick={onOpenSettings}>
            Open settings
          </button>
        </section>
      )}

      <section className="pdf-panel">
        <button className="pdf-guide-button" type="button" disabled={!canGenerateGuide} onClick={onGenerateGuide}>
          {guideState === "running" ? "Generating page guides..." : "Generate page guides"}
        </button>

        <div className="pdf-controls">
          <label>
            <span>Pages sent to model</span>
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

        <form
          className="pdf-question-form"
          onSubmit={(event) => {
            event.preventDefault();
            onAsk();
          }}
        >
          <textarea
            value={question}
            disabled={state === "running"}
            placeholder="Ask about this PDF..."
            onChange={(event) => onQuestionChange(event.target.value)}
          />
          <button type="submit" disabled={!canAsk}>
            {state === "running" ? "Reading PDF..." : "Ask PDF"}
          </button>
        </form>
      </section>

      {guideState === "running" && <Status text="Generating summary, explanation, and goal for every PDF page..." />}
      {guideState === "error" && (
        <section className="error-box">
          <strong>PDF page guide failed</strong>
          <p>{guideError}</p>
          {guideRawError && <pre>{guideRawError}</pre>}
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

      <section className="pdf-pages">
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
            return (
              <article
                className={`pdf-page-card${image.page === focusedPage ? " active" : ""}${image.page === followedPdfPage ? " followed" : ""}`}
                data-learn-panel-pdf-page={image.page}
                key={image.page}
              >
                <button type="button" className="pdf-page-header" onClick={() => onFocusPage(image.page)}>
                  <span>Page {image.page}</span>
                  {image.page === focusedPage && <strong>Focus</strong>}
                </button>
                {pageGuide ? (
                  <div className="pdf-page-guide">
                    <InfoBlock title="Summary" body={pageGuide.summary} />
                    <InfoBlock title="Explanation" body={pageGuide.explanation} />
                    <InfoBlock title="Goal" body={pageGuide.goal} />
                  </div>
                ) : (
                  <button type="button" className="pdf-page-image-button" onClick={() => onFocusPage(image.page)}>
                    <img src={image.dataUrl} alt={`PDF page ${image.page}`} loading="lazy" />
                  </button>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {answers.length > 0 && (
        <section className="pdf-answers">
          <h2>PDF Q&A</h2>
          {answers.map((item) => (
            <article className="pdf-answer" key={`${item.createdAt}-${item.question}`}>
              <div className="pdf-answer-meta">
                <span>Pages {formatPages(item.pages)}</span>
                {item.targetPage && <span>Target {item.targetPage}</span>}
              </div>
              <h3>{item.question}</h3>
              <MarkupBlocks text={item.answer} />
            </article>
          ))}
        </section>
      )}
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
  onClear,
  onDelete,
  onRestore
}: {
  history: HistoryEntry[];
  onClear: () => void;
  onDelete: (entry: HistoryEntry) => void;
  onRestore: (entry: HistoryEntry) => void;
}) {
  return (
    <section className="history-panel">
      <div className="history-header">
        <div>
          <h2>History</h2>
          <p>{history.length} saved pages</p>
        </div>
        <button className="secondary-button" type="button" disabled={history.length === 0} onClick={onClear}>
          Clear
        </button>
      </div>
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
        <p>
          <InlineMarkup text={item.answer} />
        </p>
      )}
    </div>
  );
}

function InfoBlock({ title, body }: { title: string; body: string }) {
  return (
    <div className="info-block">
      <h3>{title}</h3>
      <MarkupBlocks text={body} />
    </div>
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

    if (isMarkdownTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      blocks.push(<MarkdownTable key={`table-${index}`} lines={tableLines} />);
      continue;
    }

    if (isListLine(lines[index])) {
      const items: string[] = [];
      while (index < lines.length && isListLine(lines[index])) {
        items.push(lines[index].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul className="markup-list" key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>
              <InlineMarkup text={item} />
            </li>
          ))}
        </ul>
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isListLine(lines[index]) &&
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
  return /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line);
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
  return current.startsWith("|") && current.endsWith("|") && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(next);
}

function parseTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function InlineMarkup({ text }: { text: string }) {
  const parts = text.split(/(\*\*[\s\S]+?\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={`${part}-${index}`}>
              <InlineMarkup text={part.slice(2, -2)} />
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>;
        }
        return <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>;
      })}
    </>
  );
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

function getPageKey(url: string): string {
  return url;
}

function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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

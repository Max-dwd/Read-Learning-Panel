import type { AnalysisResult, ExtractedArticle, SectionFollowUp } from "./types";

export type HistoryEntry = {
  id: string;
  article: ExtractedArticle;
  analysis: AnalysisResult | null;
  followUps: Record<string, SectionFollowUp[]>;
  createdAt: number;
  updatedAt: number;
  scrollPos?: number;
};

const HISTORY_KEY = "learnPanelHistory";
const MAX_HISTORY_ITEMS = 25;
const MAX_ARTICLE_TEXT_CHARS = 42000;
const MAX_SECTION_TEXT_CHARS = 9000;

export async function loadHistory(): Promise<HistoryEntry[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const entries = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  return entries.filter(isHistoryEntry).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function findHistoryEntry(url: string): Promise<HistoryEntry | null> {
  const history = await loadHistory();
  return history.find((entry) => entry.article.url === url) ?? null;
}

export async function saveHistoryEntry(entry: {
  article: ExtractedArticle;
  analysis: AnalysisResult | null;
  followUps: Record<string, SectionFollowUp[]>;
  scrollPos?: number;
}): Promise<HistoryEntry[]> {
  const history = await loadHistory();
  const existing = history.find((item) => item.article.url === entry.article.url);
  const now = Date.now();
  const nextEntry: HistoryEntry = {
    id: existing?.id ?? buildHistoryId(entry.article.url),
    article: trimArticleForStorage(entry.article),
    analysis: entry.analysis,
    followUps: entry.followUps,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    scrollPos: entry.scrollPos ?? existing?.scrollPos
  };

  const nextHistory = [nextEntry, ...history.filter((item) => item.article.url !== entry.article.url)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_HISTORY_ITEMS);

  await chrome.storage.local.set({ [HISTORY_KEY]: nextHistory });
  return nextHistory;
}
export async function deleteHistoryEntry(id: string): Promise<HistoryEntry[]> {
  const history = await loadHistory();
  const nextHistory = history.filter((entry) => entry.id !== id);
  await chrome.storage.local.set({ [HISTORY_KEY]: nextHistory });
  return nextHistory;
}

export async function updateHistoryScrollPos(url: string, scrollPos: number): Promise<void> {
  const history = await loadHistory();
  const entry = history.find((item) => item.article.url === url);
  if (entry) {
    entry.scrollPos = scrollPos;
    // We don't necessarily want to update updatedAt for just a scroll position change
    // as it might reorder the history list unexpectedly.
    await chrome.storage.local.set({ [HISTORY_KEY]: history });
  }
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(HISTORY_KEY);
}

function trimArticleForStorage(article: ExtractedArticle): ExtractedArticle {
  return {
    ...article,
    text: article.text.slice(0, MAX_ARTICLE_TEXT_CHARS),
    excerpt: article.excerpt.slice(0, 1800),
    sections: article.sections.map((section) => ({
      ...section,
      text: section.text.slice(0, MAX_SECTION_TEXT_CHARS)
    }))
  };
}

function buildHistoryId(url: string): string {
  let hash = 0;
  for (let index = 0; index < url.length; index += 1) {
    hash = (hash * 31 + url.charCodeAt(index)) >>> 0;
  }
  return `history-${hash.toString(36)}`;
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<HistoryEntry>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    !!candidate.article &&
    typeof candidate.article === "object"
  );
}

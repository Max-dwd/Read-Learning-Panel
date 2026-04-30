import type { AnalysisResult, ExtractedArticle } from "./types";

export type AnalysisSessionState = "running" | "done" | "error";
export type SectionAnalysisSessionState = "queued" | "running" | "done" | "error";

export type AnalysisSession = {
  pageKey: string;
  url: string;
  article: ExtractedArticle;
  analysis: AnalysisResult | null;
  state: AnalysisSessionState;
  sectionState: Record<string, SectionAnalysisSessionState>;
  sectionErrors: Record<string, string>;
  error: string;
  rawError: string;
  updatedAt: number;
};

const ANALYSIS_SESSIONS_KEY = "learnPanelAnalysisSessions";
const MAX_ANALYSIS_SESSIONS = 25;

export async function loadAnalysisSession(pageKey: string): Promise<AnalysisSession | null> {
  const sessions = await loadAnalysisSessions();
  return sessions[pageKey] ?? null;
}

export async function saveAnalysisSession(session: Omit<AnalysisSession, "updatedAt">): Promise<void> {
  const sessions = await loadAnalysisSessions();
  const nextSessions: Record<string, AnalysisSession> = {
    ...sessions,
    [session.pageKey]: {
      ...session,
      updatedAt: Date.now()
    }
  };

  await chrome.storage.local.set({ [ANALYSIS_SESSIONS_KEY]: pruneSessions(nextSessions) });
}

export async function deleteAnalysisSession(pageKey: string): Promise<void> {
  const sessions = await loadAnalysisSessions();
  if (!sessions[pageKey]) {
    return;
  }
  delete sessions[pageKey];
  await chrome.storage.local.set({ [ANALYSIS_SESSIONS_KEY]: sessions });
}

export async function clearAnalysisSessions(): Promise<void> {
  await chrome.storage.local.remove(ANALYSIS_SESSIONS_KEY);
}

async function loadAnalysisSessions(): Promise<Record<string, AnalysisSession>> {
  const stored = await chrome.storage.local.get(ANALYSIS_SESSIONS_KEY);
  const sessions = stored[ANALYSIS_SESSIONS_KEY];
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
    return {};
  }

  const validSessions: Record<string, AnalysisSession> = {};
  for (const [key, value] of Object.entries(sessions)) {
    if (isAnalysisSession(value)) {
      validSessions[key] = value;
    }
  }
  return validSessions;
}

function pruneSessions(sessions: Record<string, AnalysisSession>): Record<string, AnalysisSession> {
  return Object.fromEntries(
    Object.entries(sessions)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ANALYSIS_SESSIONS)
  );
}

function isAnalysisSession(value: unknown): value is AnalysisSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AnalysisSession>;
  return (
    typeof candidate.pageKey === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.updatedAt === "number" &&
    !!candidate.article &&
    typeof candidate.article === "object" &&
    (candidate.state === "running" || candidate.state === "done" || candidate.state === "error")
  );
}

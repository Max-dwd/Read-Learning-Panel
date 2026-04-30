export type OutputLanguage = "follow-page" | "zh" | "en";

export type ProviderConfig = {
  endpoint: string;
  model: string;
};

export type Settings = {
  providerId: string;
  apiKeys: Record<string, string>;
  providerConfigs: Record<string, ProviderConfig>;
  endpoint: string;
  model: string;
  pdfProviderId: string;
  pdfApiKeys: Record<string, string>;
  pdfProviderConfigs: Record<string, ProviderConfig>;
  pdfEndpoint: string;
  pdfModel: string;
  outputLanguage: OutputLanguage;
};

export type ExtractedSection = {
  id: string;
  title: string;
  level: 2 | 3;
  text: string;
};

export type ExtractedArticle = {
  title: string;
  url: string;
  siteName: string;
  language: string;
  excerpt: string;
  text: string;
  sections: ExtractedSection[];
};

export type AnalysisSection = {
  id: string;
  summary: string;
  interpretation: string;
  role_in_article: string;
};

export type AnalysisResult = {
  overall: {
    summary: string;
    why_read: string;
  };
  sections: AnalysisSection[];
};

export type PdfPageGuide = {
  page: number;
  summary: string;
  explanation: string;
  goal: string;
};

export type PdfGuideResult = {
  pages: PdfPageGuide[];
};

export type SectionFollowUp = {
  question: string;
  answer: string;
  createdAt: number;
};

export type ContentRequest =
  | { type: "LEARN_PANEL_GET_ARTICLE" }
  | { type: "LEARN_PANEL_SCROLL_TO_SECTION"; sectionId: string }
  | { type: "LEARN_PANEL_GET_SELECTION" };

export type ContentResponse =
  | { ok: true; article: ExtractedArticle }
  | { ok: true }
  | { ok: true; selection: string }
  | { ok: false; error: string };

export type AnalyzeError = {
  message: string;
  raw?: string;
};

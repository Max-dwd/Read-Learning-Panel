export type OutputLanguage = "follow-page" | "zh" | "en";
export type PdfAnalysisMode = "visual" | "deep";
export type DatalabParseMode = "fast" | "balanced" | "accurate";

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
  deepPdfParserEndpoint: string;
  deepPdfParserApiKey: string;
  deepPdfParserMode: DatalabParseMode;
  deepPdfSummaryProviderId: string;
  deepPdfSummaryApiKeys: Record<string, string>;
  deepPdfSummaryProviderConfigs: Record<string, ProviderConfig>;
  deepPdfSummaryEndpoint: string;
  deepPdfSummaryModel: string;
  deepPdfVisionProviderId: string;
  deepPdfVisionApiKeys: Record<string, string>;
  deepPdfVisionProviderConfigs: Record<string, ProviderConfig>;
  deepPdfVisionEndpoint: string;
  deepPdfVisionModel: string;
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

export type PdfBoundingBox = [number, number, number, number];

export type DeepPdfBlock = {
  id: string;
  page: number;
  type: string;
  text: string;
  html?: string;
  bbox?: PdfBoundingBox;
};

export type DeepPdfSection = {
  id: string;
  title: string;
  level: 2 | 3;
  text: string;
  pageStart: number;
  pageEnd: number;
  blocks: DeepPdfBlock[];
};

export type DeepPdfParseResult = {
  sourceUrl: string;
  title: string;
  pageCount: number;
  pageRange: string;
  parseQualityScore?: number;
  markdown?: string;
  pageBboxes?: Record<number, PdfBoundingBox>;
  blocks: DeepPdfBlock[];
  sections: DeepPdfSection[];
  createdAt: number;
};

export type SectionFollowUp = {
  question: string;
  answer: string;
  createdAt: number;
};

export type ContentRequest =
  | { type: "LEARN_PANEL_GET_ARTICLE" }
  | { type: "LEARN_PANEL_SCROLL_TO_SECTION"; sectionId: string }
  | { type: "LEARN_PANEL_GET_SELECTION" }
  | { type: "LEARN_PANEL_GET_ACTIVE_SECTION" }
  | { type: "LEARN_PANEL_GET_ACTIVE_PDF_PAGE" }
  | { type: "LEARN_PANEL_SCROLL_TO_PDF_PAGE"; page: number }
  | {
      type: "LEARN_PANEL_HIGHLIGHT_PDF_BLOCKS";
      sectionId: string;
      blocks: DeepPdfBlock[];
      pageBboxes?: Record<number, PdfBoundingBox>;
    };

export type ContentResponse =
  | { ok: true; article: ExtractedArticle }
  | { ok: true }
  | { ok: true; selection: string }
  | { ok: true; activeSectionId: string | null }
  | { ok: true; activePage: number }
  | { ok: false; error: string };

export type AnalyzeError = {
  message: string;
  raw?: string;
};

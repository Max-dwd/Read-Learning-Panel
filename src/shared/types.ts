export type OutputLanguage = "follow-page" | "zh" | "en";
export type PdfAnalysisMode = "visual" | "deep";
export type DatalabParseMode = "fast" | "balanced" | "accurate";
export type AnalysisDetailLevel = "handout" | "study" | "textbook";

export const DEEP_PDF_GEOMETRY_VERSION = 4;

export type ProviderConfig = {
  endpoint: string;
  model: string;
  isMultimodal?: boolean;
};

export type ModelConfig = {
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  isMultimodal: boolean;
};

export type FeatureModelKey =
  | "articleAnalysis"
  | "articleQuestion"
  | "articleVisualRewrite"
  | "pdfVisualAnalysis"
  | "pdfVisualQuestion"
  | "pdfDeepAnalysis";

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
  modelConfigs: Record<string, ModelConfig>;
  featureModelSelections: Partial<Record<FeatureModelKey, string>>;
  outputLanguage: OutputLanguage;
};

export type ExtractedSectionVisual = {
  id: string;
  kind: "image" | "gif" | "component_screenshot";
  src?: string;
  imageDataUrl?: string;
  alt?: string;
  caption?: string;
};

export type ExtractedSection = {
  id: string;
  title: string;
  level: 2 | 3;
  text: string;
  visuals?: ExtractedSectionVisual[];
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
  title?: string;
  summary: string;
  interpretation: string;
  role_in_article: string;
  visual_description?: string;
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
  title?: string;
  summary: string;
  explanation: string;
  goal: string;
};

export type PdfGuideResult = {
  pages: PdfPageGuide[];
};

export type PdfSelectionReference = {
  text: string;
  imageDataUrl?: string;
};

export type PdfPoint = [number, number];
export type PdfBoundingBox = [number, number, number, number];
export type PdfPolygon = PdfPoint[];

export type DeepPdfBlock = {
  id: string;
  sectionId?: string;
  page: number;
  type: string;
  text: string;
  caption?: string;
  html?: string;
  bbox?: PdfBoundingBox;
  polygon?: PdfPolygon;
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
  geometryVersion?: number;
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
  | { type: "LEARN_PANEL_GET_ACTIVE_DEEP_PDF_SECTION" }
  | { type: "LEARN_PANEL_SCROLL_TO_PDF_PAGE"; page: number; scrollBehavior?: ScrollBehavior }
  | {
      type: "LEARN_PANEL_HIGHLIGHT_PDF_BLOCKS";
      sectionId: string;
      blocks: DeepPdfBlock[];
      pageBboxes?: Record<number, PdfBoundingBox>;
      targetPage?: number;
      scrollBehavior?: ScrollBehavior;
    }
  | { type: "LEARN_PANEL_REMOVE_PDF_SELECTION_REFERENCE"; referenceLabel: string }
  | { type: "LEARN_VIEWER_FOCUS_PDF_SECTION"; sectionId: string }
  | {
      type: "LEARN_VIEWER_PDF_SELECTION_CHANGED";
      sectionId: string;
      selection: string;
      selectionImageDataUrl?: string;
      openQuestion?: boolean;
    }
  | { type: "LEARN_VIEWER_USE_PDF_SELECTION"; sectionId: string; selection: string; selectionImageDataUrl?: string };

export type ContentResponse =
  | { ok: true; article: ExtractedArticle }
  | { ok: true }
  | { ok: true; selection: string; selectionImageDataUrl?: string }
  | { ok: true; activeSectionId: string | null }
  | { ok: true; activeDeepPdfSectionId: string | null }
  | { ok: true; activePage: number }
  | { ok: false; error: string };

export type AnalyzeError = {
  message: string;
  raw?: string;
};

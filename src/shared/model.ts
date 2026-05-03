import type {
  AnalysisDetailLevel,
  AnalysisSection,
  AnalysisResult,
  ExtractedArticle,
  ExtractedSection,
  ExtractedSectionVisual,
  OutputLanguage,
  PdfGuideResult,
  PdfSelectionReference,
  SectionFollowUp,
  Settings
} from "./types";
import { getChatCompletionsEndpoint, getFeatureModelClientConfig, type FeatureModelClientConfig } from "./settings";
import type { PdfPageImage } from "./pdf";

const MAX_TOTAL_CHARS = 42000;
const MAX_SECTION_CHARS = 3600;
const MAX_FOLLOW_UP_SECTION_CHARS = 9000;
const FOLLOW_UP_MARKDOWN_FORMAT_INSTRUCTION =
  "Format the answer as standard Markdown when structure helps: use headings, bullet/numbered lists, blockquotes, fenced code, math, and GitHub-style tables with blank lines around block elements. Do not use HTML.";
const INTERPRETATION_MARKDOWN_RULES =
  "Use real Markdown block structure: each bullet must start on its own line with '- '. Inside JSON/NDJSON strings, encode those line breaks as \\n. Use a compact markdown table only when comparison is clearer. Do not put bullets inline in one sentence. Put the most important takeaway in **bold**.";

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: string;
  };
};

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

type VisionImageInput = {
  url: string;
};

export type AnalysisProgressEvent =
  | { type: "overall"; overall: AnalysisResult["overall"] }
  | { type: "section"; section: AnalysisSection };

export async function analyzeArticle(
  article: ExtractedArticle,
  settings: Settings,
  detailLevel: AnalysisDetailLevel = "study"
): Promise<AnalysisResult> {
  const client = getArticleAnalysisClientConfig(settings);
  const apiKey = client.apiKey;
  if (!apiKey) {
    throw new Error(client.missingApiKeyMessage);
  }

  const response = await fetch(getChatCompletionsEndpoint(client.endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: client.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a rigorous reading and learning assistant. Return only valid JSON. Do not wrap the JSON in markdown."
        },
        {
          role: "user",
          content: buildPrompt(article, settings.outputLanguage, detailLevel)
        }
      ]
    })
  });

  const body = (await response.json().catch(() => null)) as OpenAIResponse | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Model request failed with HTTP ${response.status}`);
  }

  const raw = extractResponseText(body);
  if (!raw) {
    throw new Error("Model response did not contain choices[0].message.content.");
  }

  return parseAnalysis(raw, article.sections);
}

export async function analyzeArticleProgressively(
  article: ExtractedArticle,
  settings: Settings,
  onProgress: (event: AnalysisProgressEvent) => void,
  detailLevel: AnalysisDetailLevel = "study"
): Promise<AnalysisResult> {
  const client = getArticleAnalysisClientConfig(settings);
  const apiKey = client.apiKey;
  if (!apiKey) {
    throw new Error(client.missingApiKeyMessage);
  }

  const response = await fetch(getChatCompletionsEndpoint(client.endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: client.model,
      temperature: 0.2,
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "You are a rigorous reading and learning assistant. Return only newline-delimited JSON objects. Do not wrap the output in markdown."
        },
        {
          role: "user",
          content: buildProgressivePrompt(article, settings.outputLanguage, detailLevel)
        }
      ]
    })
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as OpenAIResponse | null;
    throw new Error(body?.error?.message ?? `Model request failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Model response did not include a readable stream.");
  }

  return readProgressiveAnalysisStream(response.body, article.sections, onProgress);
}

async function readProgressiveAnalysisStream(
  body: ReadableStream<Uint8Array>,
  sourceSections: ExtractedSection[],
  onProgress: (event: AnalysisProgressEvent) => void
): Promise<AnalysisResult> {
  const knownIds = new Set(sourceSections.map((section) => section.id));
  const sections: AnalysisSection[] = [];
  let overall: AnalysisResult["overall"] | null = null;
  let contentBuffer = "";

  for await (const content of readOpenAIStream(body)) {
    contentBuffer += content;
    const lines = contentBuffer.split(/\r?\n/);
    contentBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = parseProgressLine(line, knownIds);
      if (!event) {
        continue;
      }

      onProgress(event);
      if (event.type === "overall") {
        overall = event.overall;
      } else {
        sections.push(event.section);
      }
    }
  }

  const finalEvent = parseProgressLine(contentBuffer, knownIds);
  if (finalEvent) {
    onProgress(finalEvent);
    if (finalEvent.type === "overall") {
      overall = finalEvent.overall;
    } else {
      sections.push(finalEvent.section);
    }
  }

  if (!overall) {
    throw new Error("Model stream did not include an overall analysis object.");
  }

  const uniqueSections = sourceSections
    .map((sourceSection) => sections.find((section) => section.id === sourceSection.id))
    .filter((section): section is AnalysisSection => Boolean(section));

  if (uniqueSections.length !== sourceSections.length) {
    throw new Error(`Model stream returned ${uniqueSections.length} of ${sourceSections.length} section analyses.`);
  }

  return { overall, sections: uniqueSections };
}

export async function analyzePdfProgressively({
  article,
  pageImages,
  settings,
  onProgress,
  detailLevel = "study"
}: {
  article: ExtractedArticle;
  pageImages: PdfPageImage[];
  settings: Settings;
  onProgress: (event: AnalysisProgressEvent) => void;
  detailLevel?: AnalysisDetailLevel;
}): Promise<AnalysisResult> {
  const client = getPdfVisualAnalysisClientConfig(settings);
  const apiKey = client.apiKey;
  if (!apiKey) {
    throw new Error(client.missingApiKeyMessage);
  }

  const pdfEndpoint = getChatCompletionsEndpoint(client.endpoint);
  const pdfModel = client.model.trim();
  if (!pdfEndpoint) {
    throw new Error(client.missingEndpointMessage);
  }
  if (!pdfModel) {
    throw new Error(client.missingModelMessage);
  }

  const response = await fetch(pdfEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    },
    body: JSON.stringify({
      model: pdfModel,
      max_tokens: getProgressiveMaxTokens(pageImages.length, detailLevel),
      temperature: 0.2,
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "You are a rigorous reading and learning assistant. Return only newline-delimited JSON objects. Do not wrap the output in markdown."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildPdfProgressivePrompt(article, pageImages.map((image) => image.page), settings.outputLanguage, detailLevel)
            },
            ...pageImages.map((image) => ({
              type: "image_url",
              image_url: {
                url: image.dataUrl
              }
            }))
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as OpenAIResponse | null;
    const raw = body ? JSON.stringify(body).slice(0, 4000) : "";
    const error = new Error(body?.error?.message ?? `Model request failed with HTTP ${response.status}`) as Error & {
      raw?: string;
    };
    error.raw = raw;
    throw error;
  }
  if (!response.body) {
    throw new Error("Model response did not include a readable stream.");
  }

  return readProgressiveAnalysisStream(response.body, article.sections, onProgress);
}

export async function analyzeDeepPdfProgressively(
  article: ExtractedArticle,
  settings: Settings,
  onProgress: (event: AnalysisProgressEvent) => void,
  detailLevel: AnalysisDetailLevel = "study"
): Promise<AnalysisResult> {
  const client = getDeepPdfAnalysisClientConfig(settings);
  const apiKey = client.apiKey;
  if (!apiKey) {
    throw new Error(client.missingApiKeyMessage);
  }

  const endpoint = getChatCompletionsEndpoint(client.endpoint);
  const model = client.model.trim();
  if (!endpoint) {
    throw new Error(client.missingEndpointMessage);
  }
  if (!model) {
    throw new Error(client.missingModelMessage);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "You are a rigorous reading and learning assistant. Return only newline-delimited JSON objects. Do not wrap the output in markdown."
        },
        {
          role: "user",
          content: buildDeepPdfProgressivePrompt(article, settings.outputLanguage, detailLevel)
        }
      ]
    })
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as OpenAIResponse | null;
    throw new Error(body?.error?.message ?? `Model request failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Model response did not include a readable stream.");
  }

  return readProgressiveAnalysisStream(response.body, article.sections, onProgress);
}

export async function analyzeArticleOverview(
  article: ExtractedArticle,
  settings: Settings
): Promise<AnalysisResult["overall"]> {
  const client = getArticleAnalysisClientConfig(settings);
  const apiKey = client.apiKey;
  if (!apiKey) {
    throw new Error(client.missingApiKeyMessage);
  }

  const response = await fetch(getChatCompletionsEndpoint(client.endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: client.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a rigorous reading and learning assistant. Return only valid JSON. Do not wrap the JSON in markdown."
        },
        {
          role: "user",
          content: buildOverviewPrompt(article, settings.outputLanguage)
        }
      ]
    })
  });

  const body = (await response.json().catch(() => null)) as OpenAIResponse | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Model request failed with HTTP ${response.status}`);
  }

  const raw = extractResponseText(body);
  if (!raw) {
    throw new Error("Model response did not contain choices[0].message.content.");
  }

  return parseOverview(raw);
}

export async function analyzeArticleSection({
  article,
  section,
  sectionIndex,
  settings
}: {
  article: ExtractedArticle;
  section: ExtractedSection;
  sectionIndex: number;
  settings: Settings;
}): Promise<AnalysisSection> {
  const client = getArticleAnalysisClientConfig(settings);
  const apiKey = client.apiKey;
  if (!apiKey) {
    throw new Error(client.missingApiKeyMessage);
  }

  const response = await fetch(getChatCompletionsEndpoint(client.endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: client.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a rigorous reading and learning assistant. Return only valid JSON. Do not wrap the JSON in markdown."
        },
        {
          role: "user",
          content: buildSingleSectionPrompt({
            article,
            section,
            sectionIndex,
            outputLanguage: settings.outputLanguage
          })
        }
      ]
    })
  });

  const body = (await response.json().catch(() => null)) as OpenAIResponse | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Model request failed with HTTP ${response.status}`);
  }

  const raw = extractResponseText(body);
  if (!raw) {
    throw new Error("Model response did not contain choices[0].message.content.");
  }

  return parseSectionAnalysis(raw, section.id);
}

export async function rewriteArticleSectionWithVisuals({
  article,
  section,
  sectionAnalysis,
  visuals,
  settings
}: {
  article: ExtractedArticle;
  section: ExtractedSection;
  sectionAnalysis: AnalysisSection;
  visuals: ExtractedSectionVisual[];
  settings: Settings;
}): Promise<AnalysisSection> {
  const images = visuals
    .map((visual) => visual.imageDataUrl || visual.src || "")
    .filter((url) => /^data:image\//i.test(url) || /^https?:\/\//i.test(url));
  if (images.length === 0) {
    return sectionAnalysis;
  }

  const raw = await requestVision({
    images: images.slice(0, 3).map((url) => ({ url })),
    prompt: buildArticleVisualRewritePrompt({
      article,
      section,
      sectionAnalysis,
      visuals,
      outputLanguage: settings.outputLanguage
    }),
    client: getArticleVisualRewriteClientConfig(settings),
    maxTokens: 2200
  });
  return parseSectionAnalysis(raw, section.id);
}

export async function answerSectionQuestion({
  article,
  section,
  sectionAnalysis,
  priorFollowUps,
  question,
  settings,
  featureModelKey = "articleQuestion"
}: {
  article: ExtractedArticle;
  section: ExtractedSection;
  sectionAnalysis: AnalysisSection | undefined;
  priorFollowUps: SectionFollowUp[];
  question: string;
  settings: Settings;
  featureModelKey?: "articleQuestion" | "pdfDeepAnalysis";
}): Promise<string> {
  const client =
    featureModelKey === "pdfDeepAnalysis" ? getDeepPdfAnalysisClientConfig(settings) : getArticleQuestionClientConfig(settings);
  const apiKey = client.apiKey;
  if (!apiKey) {
    throw new Error(client.missingApiKeyMessage);
  }

  const response = await fetch(getChatCompletionsEndpoint(client.endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: client.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You answer focused follow-up questions about one section of an article. Use the provided section context. Be concrete and concise."
        },
        {
          role: "user",
          content: buildSectionQuestionPrompt({
            article,
            section,
            sectionAnalysis,
            priorFollowUps,
            question,
            outputLanguage: settings.outputLanguage
          })
        }
      ]
    })
  });

  const body = (await response.json().catch(() => null)) as OpenAIResponse | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Model request failed with HTTP ${response.status}`);
  }

  const answer = extractResponseText(body).trim();
  if (!answer) {
    throw new Error("Model response did not contain choices[0].message.content.");
  }

  return stripCodeFence(answer);
}

export async function answerPdfQuestion({
  title,
  url,
  pageImages,
  targetPage,
  question,
  selectionReference,
  settings
}: {
  title: string;
  url: string;
  pageImages: PdfPageImage[];
  targetPage: number | null;
  question: string;
  selectionReference?: PdfSelectionReference;
  settings: Settings;
}): Promise<string> {
  return requestPdfVision({
    pageImages,
    supplementalImageDataUrls: selectionReference?.imageDataUrl ? [selectionReference.imageDataUrl] : [],
    prompt: buildPdfQuestionPrompt({
      title,
      url,
      pages: pageImages.map((image) => image.page),
      targetPage,
      question,
      selectionReference,
      outputLanguage: settings.outputLanguage
    }),
    settings,
    maxTokens: 1800
  });
}

export async function answerDeepPdfVisionQuestion({
  title,
  url,
  pageImages,
  targetPage,
  question,
  selectionReference,
  sectionText,
  settings
}: {
  title: string;
  url: string;
  pageImages: PdfPageImage[];
  targetPage: number | null;
  question: string;
  selectionReference?: PdfSelectionReference;
  sectionText?: string;
  settings: Settings;
}): Promise<string> {
  return requestPdfVision({
    pageImages,
    supplementalImageDataUrls: selectionReference?.imageDataUrl ? [selectionReference.imageDataUrl] : [],
    prompt: buildPdfQuestionPrompt({
      title,
      url,
      pages: pageImages.map((image) => image.page),
      targetPage,
      question,
      selectionReference,
      supportingContext: sectionText ? `Datalab parsed text for the target page:\n${truncate(sectionText, MAX_FOLLOW_UP_SECTION_CHARS)}` : "",
      outputLanguage: settings.outputLanguage
    }),
    settings,
    maxTokens: 1800
  });
}

export async function generatePdfGuide({
  title,
  url,
  pageImages,
  settings
}: {
  title: string;
  url: string;
  pageImages: PdfPageImage[];
  settings: Settings;
}): Promise<PdfGuideResult> {
  const raw = await requestPdfVision({
    pageImages,
    prompt: buildPdfGuidePrompt({
      title,
      url,
      pages: pageImages.map((image) => image.page),
      outputLanguage: settings.outputLanguage
    }),
    settings,
    client: getPdfVisualAnalysisClientConfig(settings),
    maxTokens: Math.max(2600, Math.min(12000, pageImages.length * 450))
  });
  return parsePdfGuide(raw, pageImages.map((image) => image.page));
}

async function requestPdfVision({
  pageImages,
  supplementalImageDataUrls = [],
  prompt,
  settings,
  client = getPdfVisualQuestionClientConfig(settings),
  maxTokens
}: {
  pageImages: PdfPageImage[];
  supplementalImageDataUrls?: string[];
  prompt: string;
  settings: Settings;
  client?: FeatureModelClientConfig;
  maxTokens: number;
}): Promise<string> {
  return requestVision({
    images: [
      ...pageImages.map((image) => ({ url: image.dataUrl })),
      ...supplementalImageDataUrls.map((url) => ({ url }))
    ],
    prompt,
    client,
    maxTokens
  });
}

async function requestVision({
  images,
  prompt,
  client,
  maxTokens
}: {
  images: VisionImageInput[];
  prompt: string;
  client: FeatureModelClientConfig;
  maxTokens: number;
}): Promise<string> {
  const apiKey = client.apiKey;
  if (!apiKey) {
    throw new Error(client.missingApiKeyMessage);
  }

  const pdfEndpoint = getChatCompletionsEndpoint(client.endpoint);
  const pdfModel = client.model.trim();
  if (!pdfEndpoint) {
    throw new Error(client.missingEndpointMessage);
  }
  if (!pdfModel) {
    throw new Error(client.missingModelMessage);
  }

  const response = await fetch(pdfEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    },
    body: JSON.stringify({
      model: pdfModel,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            },
            ...images.map((image) => ({
              type: "image_url",
              image_url: {
                url: image.url
              }
            }))
          ]
        }
      ]
    })
  });

  const body = (await response.json().catch(() => null)) as OpenAIResponse | null;
  if (!response.ok) {
    const raw = body ? JSON.stringify(body).slice(0, 4000) : "";
    const error = new Error(body?.error?.message ?? `Model request failed with HTTP ${response.status}`) as Error & {
      raw?: string;
    };
    error.raw = raw;
    throw error;
  }

  const answer = extractResponseText(body).trim();
  if (!answer) {
    throw new Error("Model response did not contain choices[0].message.content.");
  }

  return stripCodeFence(answer);
}

function getArticleAnalysisClientConfig(settings: Settings): FeatureModelClientConfig {
  return getFeatureModelClientConfig(settings, "articleAnalysis", "text", {
    missingApiKeyMessage: "Missing article analysis API key. Open settings and add the selected model API key.",
    missingEndpointMessage: "Missing article analysis endpoint. Open settings and add the selected model endpoint.",
    missingModelMessage: "Missing article analysis model. Open settings and choose a model."
  });
}

function getArticleQuestionClientConfig(settings: Settings): FeatureModelClientConfig {
  return getFeatureModelClientConfig(settings, "articleQuestion", "text", {
    missingApiKeyMessage: "Missing article Q&A API key. Open settings and add the selected model API key.",
    missingEndpointMessage: "Missing article Q&A endpoint. Open settings and add the selected model endpoint.",
    missingModelMessage: "Missing article Q&A model. Open settings and choose a model."
  });
}

function getArticleVisualRewriteClientConfig(settings: Settings): FeatureModelClientConfig {
  return getFeatureModelClientConfig(settings, "articleVisualRewrite", "multimodal", {
    missingApiKeyMessage: "Missing article image rewrite API key. Open settings and add the selected multimodal model API key.",
    missingEndpointMessage: "Missing article image rewrite endpoint. Open settings and add the selected model endpoint.",
    missingModelMessage: "Missing article image rewrite model. Open settings and choose a multimodal model."
  });
}

function getPdfVisualAnalysisClientConfig(settings: Settings): FeatureModelClientConfig {
  return getFeatureModelClientConfig(settings, "pdfVisualAnalysis", "multimodal", {
    missingApiKeyMessage: "Missing PDF image analysis API key. Open settings and add the selected multimodal model API key.",
    missingEndpointMessage: "Missing PDF image analysis endpoint. Open settings and add the selected model endpoint.",
    missingModelMessage: "Missing PDF image analysis model. Open settings and choose a multimodal model."
  });
}

function getPdfVisualQuestionClientConfig(settings: Settings): FeatureModelClientConfig {
  return getFeatureModelClientConfig(settings, "pdfVisualQuestion", "multimodal", {
    missingApiKeyMessage: "Missing PDF image Q&A API key. Open settings and add the selected multimodal model API key.",
    missingEndpointMessage: "Missing PDF image Q&A endpoint. Open settings and add the selected model endpoint.",
    missingModelMessage: "Missing PDF image Q&A model. Open settings and choose a multimodal model."
  });
}

function getDeepPdfAnalysisClientConfig(settings: Settings): FeatureModelClientConfig {
  return getFeatureModelClientConfig(settings, "pdfDeepAnalysis", "text", {
    missingApiKeyMessage: "Missing deep PDF analysis API key. Open settings and add the selected summary model API key.",
    missingEndpointMessage: "Missing deep PDF analysis endpoint. Open settings and add the selected summary model endpoint.",
    missingModelMessage: "Missing deep PDF analysis model. Open settings and choose a summary model."
  });
}

function buildPdfGuidePrompt({
  title,
  url,
  pages,
  outputLanguage
}: {
  title: string;
  url: string;
  pages: number[];
  outputLanguage: OutputLanguage;
}): string {
  const languageInstruction =
    outputLanguage === "follow-page"
      ? "Write in Chinese if the PDF or browser context is Chinese; otherwise use the PDF's main language."
      : outputLanguage === "zh"
        ? "Write in Chinese."
        : "Write in English.";

  return [
    languageInstruction,
    `PDF title: ${title}`,
    `PDF URL: ${url}`,
    `下面是 PDF 的第 ${pages.join(", ")} 页截图。PDF 的 section 单位就是页。`,
    "不要输出整份 PDF 的总导读。必须为每一页都生成一个独立结果。",
    "Return only valid JSON. Do not wrap it in markdown. Use exactly this shape:",
    `{"pages":[{"page":1,"title":"short precise page title","summary":"string","explanation":"string","goal":"string"}]}`,
    `The pages array must contain exactly these page numbers, in order: ${pages.join(", ")}.`,
    "For each page.title, write a concise keyword-style title that precisely captures that page's content. Do not include the page number. Keep it under 8 words or 14 Chinese characters. Avoid duplicate titles across pages; if two pages share the same core topic, add a specific suffix after ' - ' such as 'Method - Assumptions' or '结果 - 消融'.",
    "Do not start any summary, explanation, or goal with a page label such as 'Page 1:' or '第 1 页：'; the UI already shows the page number.",
    "For each page.summary, summarize only what this page says. Put the main point in **bold**.",
    "For each page.explanation, explain what this page means in concrete quick-scan bullets. Use real markdown bullets with '\\n- ' line breaks inside the JSON string. Put the key idea in **bold**.",
    "For each page.goal, explain this page's job in the PDF: why this page exists, what the reader should get from it, or how it moves the material forward. Be concrete without repeating the page number.",
    "If a page is mostly cover, references, or blank, still return that page and state its actual purpose instead of skipping it."
  ].join("\n\n");
}

function buildPdfQuestionPrompt({
  title,
  url,
  pages,
  targetPage,
  question,
  selectionReference,
  supportingContext,
  outputLanguage
}: {
  title: string;
  url: string;
  pages: number[];
  targetPage: number | null;
  question: string;
  selectionReference?: PdfSelectionReference;
  supportingContext?: string;
  outputLanguage: OutputLanguage;
}): string {
  const languageInstruction =
    outputLanguage === "follow-page"
      ? "Answer in the same language as the user question when possible."
      : outputLanguage === "zh"
        ? "Write the answer in Chinese."
        : "Write the answer in English.";
  const focusText = targetPage
    ? `重点回答第 ${targetPage} 页；其他页面只作为上下文参考。`
    : "Use all provided pages as context.";

  return [
    languageInstruction,
    `PDF title: ${title}`,
    `PDF URL: ${url}`,
    FOLLOW_UP_MARKDOWN_FORMAT_INSTRUCTION,
    `下面是 PDF 的第 ${pages.join(", ")} 页截图。请先基于截图内容理解页面，再回答用户问题；如果是多页，请按页组织要点。`,
    selectionReference?.imageDataUrl
      ? "用户引用了一个框选区域；完整页截图之后还附带了该框选区域的小截图。回答时优先参考这个小截图，再结合整页上下文。"
      : "",
    selectionReference?.text ? `引用内容：\n${selectionReference.text}` : "",
    supportingContext ? `辅助文本上下文：\n${supportingContext}` : "",
    focusText,
    `用户问题：${question}`
  ].filter(Boolean).join("\n\n");
}

function extractResponseText(body: OpenAIResponse | null): string {
  return extractContentText(body?.choices?.[0]?.message?.content);
}

function extractContentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractContentText).join("");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const candidate = value as { text?: unknown; content?: unknown; message?: unknown };
  if (typeof candidate.text === "string") {
    return candidate.text;
  }
  if (candidate.content) {
    return extractContentText(candidate.content);
  }
  if (candidate.message) {
    return extractContentText(candidate.message);
  }
  return "";
}

function buildDetailGuidance(detailLevel: AnalysisDetailLevel): string {
  if (detailLevel === "handout") {
    return [
      "Detail level: Handout.",
      "Write like a concise guided-reading handout: fast to scan, useful before class or before reading the full text.",
      "Keep overall.summary to 1-2 compact sentences and overall.why_read to 1 compact sentence.",
      "For each section, keep summary to 1 sentence, interpretation to 2-3 real bullets, and role_in_article to 1 short sentence.",
      "Prioritize the core claim, the must-remember concept, and why the section exists. Avoid examples unless they are essential."
    ].join(" ");
  }

  if (detailLevel === "textbook") {
    return [
      "Detail level: Textbook.",
      "Write like compact textbook notes for self-study, not a slide summary.",
      "Treat section.interpretation as the teaching surface: unpack definitions, mechanisms, examples, assumptions, consequences, and how the section fits the article.",
      "Do not compress bullets into slogans. A bullet may contain multiple sentences when the concept needs explanation.",
      "Use bold like **the new paradigm of AI application eval** when it helps identify the concept being taught."
    ].join(" ");
  }

  return [
    "Detail level: Study.",
    "Write balanced study notes: more useful than a skim, but still compact.",
    "For each section.interpretation, use 3-5 real bullets by default. Explain the central idea, why it matters, and how it connects to the article."
  ].join(" ");
}

function buildInterpretationGuidance(
  detailLevel: AnalysisDetailLevel,
  target: "section.interpretation" | "interpretation" = "section.interpretation"
): string {
  const prefix = target === "interpretation" ? "For interpretation" : "For each section.interpretation";

  if (detailLevel === "handout") {
    return [
      `${prefix}, write a quick 'What this means' explanation for learning.`,
      "Use 2-3 real bullets. Each bullet may be one or two sentences, but stay focused on the core claim, the must-remember concept, and why the section exists.",
      "Avoid examples unless they are essential.",
      INTERPRETATION_MARKDOWN_RULES
    ].join(" ");
  }

  if (detailLevel === "textbook") {
    return [
      `${prefix}, write a textbook-style 'What this means' lesson, not a one-line paraphrase.`,
      "Use 4-7 real bullets by default. Each bullet must be a mini-explanation of 2-4 sentences, or one short paragraph plus a concrete example, analogy, condition, or contrast when helpful.",
      "Teach the concept explicitly: define the key term, unpack the mechanism or causal logic, explain why it matters, show how the evidence/example supports it, and connect it to nearby sections.",
      "Do not use single-sentence bullets unless the source section is trivial. If the source contains multiple concepts, split them into separate bullets so a student can study from the result without asking a follow-up.",
      "Prefer concrete instructional language over abstract labels. Include formulas, conditions, contrasts, examples, or failure cases when they are present or necessary to understand the concept.",
      INTERPRETATION_MARKDOWN_RULES
    ].join(" ");
  }

  return [
    `${prefix}, write a 'What this means' explanation that is long enough for learning.`,
    "Use 3-5 real bullets by default. Each bullet should usually have 1-3 sentences explaining the central idea, why it matters, and how it connects to the article.",
    "Avoid dense paragraphs, abstract wording, and long caveats.",
    INTERPRETATION_MARKDOWN_RULES
  ].join(" ");
}

function getProgressiveMaxTokens(sectionCount: number, detailLevel: AnalysisDetailLevel): number {
  const perSection = detailLevel === "handout" ? 360 : detailLevel === "textbook" ? 1200 : 520;
  const floor = detailLevel === "textbook" ? 6000 : 2600;
  const ceiling = detailLevel === "textbook" ? 24000 : 16000;
  return Math.max(floor, Math.min(ceiling, sectionCount * perSection));
}

function buildPrompt(article: ExtractedArticle, outputLanguage: OutputLanguage, detailLevel: AnalysisDetailLevel = "study"): string {
  const languageInstruction =
    outputLanguage === "follow-page"
      ? `Use the same language as the article when possible. Detected page language: ${article.language || "unknown"}.`
      : outputLanguage === "zh"
        ? "Write all user-facing fields in Chinese."
        : "Write all user-facing fields in English.";

  return [
    languageInstruction,
    buildDetailGuidance(detailLevel),
    "Analyze this article for a reader who wants to learn from it, not just skim it.",
    "Return strict JSON with exactly this shape:",
    `{
  "overall": {
    "summary": "string",
    "why_read": "string"
  },
  "sections": [
    {
      "id": "same section id from input",
      "summary": "string",
      "interpretation": "string",
      "role_in_article": "string"
    }
  ]
}`,
    "For overall.why_read, answer the high-level learning goal: why this is worth reading, and what worldview, values, mental model, or life perspective it may offer.",
    "Use **bold** in every user-facing analysis field to mark the key term, claim, contrast, problem, or contribution. This applies to overall.summary, overall.why_read, section.summary, section.interpretation, and section.role_in_article.",
    "For each section.summary, summarize only what this section says, with the main point in **bold**.",
    buildInterpretationGuidance(detailLevel),
    [
      "For each section.role_in_article, be concise: 1-2 short sentences only.",
      "Explain how this section changes or advances the article by referencing nearby or related sections when useful.",
      'Prefer relationship language such as: "This solves the **planning gap** left by `Naive agent loop`" or "This prepares the later **tool-use** section by defining the failure mode."',
      "Use **bold** around the key problem, shift, or contribution. Do not write a generic paragraph about the section's importance."
    ].join(" "),
    "Do not invent section ids. Include one result per input section.",
    "",
    formatArticleForPrompt(article)
  ].join("\n");
}

function buildOverviewPrompt(article: ExtractedArticle, outputLanguage: OutputLanguage): string {
  const languageInstruction =
    outputLanguage === "follow-page"
      ? `Use the same language as the article when possible. Detected page language: ${article.language || "unknown"}.`
      : outputLanguage === "zh"
        ? "Write all user-facing fields in Chinese."
        : "Write all user-facing fields in English.";

  return [
    languageInstruction,
    "Analyze this article for a reader who wants to learn from it, not just skim it.",
    "Return strict JSON with exactly this shape:",
    `{
  "overall": {
    "summary": "string",
    "why_read": "string"
  }
}`,
    "For overall.summary, summarize the article's central argument or lesson with the main point in **bold**.",
    "For overall.why_read, answer the high-level learning goal: why this is worth reading, and what worldview, values, mental model, or life perspective it may offer.",
    "Use **bold** in every user-facing field to mark the key term, claim, contrast, problem, or contribution.",
    "",
    formatArticleForPrompt(article)
  ].join("\n");
}

function buildProgressivePrompt(
  article: ExtractedArticle,
  outputLanguage: OutputLanguage,
  detailLevel: AnalysisDetailLevel = "study"
): string {
  const languageInstruction =
    outputLanguage === "follow-page"
      ? [
        `Use the same language as the article when possible. Detected page language: ${article.language || "unknown"}.`,
        "Every user-facing JSON string value must use that page language. Keep JSON keys type, id, title, summary, why_read, interpretation, and role_in_article exactly as written."
      ].join(" ")
      : outputLanguage === "zh"
        ? "Write every user-facing JSON string value in Chinese. Keep JSON keys type, id, title, summary, why_read, interpretation, and role_in_article exactly as written."
        : "Write every user-facing JSON string value in English. Keep JSON keys type, id, title, summary, why_read, interpretation, and role_in_article exactly as written.";

  return [
    languageInstruction,
    buildDetailGuidance(detailLevel),
    "Analyze this article for a reader who wants to learn from it, not just skim it.",
    "Return newline-delimited JSON. Each line must be one complete compact JSON object. Do not output an array. Do not pretty-print. Do not use markdown fences.",
    "First output exactly one overall line:",
    `{"type":"overall","summary":"string","why_read":"string"}`,
    "Then output one section line per input section, in the same order as the input:",
    `{"type":"section","id":"same section id from input","title":"short title","summary":"string","interpretation":"string","role_in_article":"string"}`,
    "For each section.title, write a concise content title. For normal article sections, keep or lightly tighten the input section title. For PDF page sections, write a keyword-style page title without the page number.",
    "Use **bold** in every user-facing analysis field to mark the key term, claim, contrast, problem, or contribution.",
    "For overall.why_read, answer the high-level learning goal: why this is worth reading, and what worldview, values, mental model, or life perspective it may offer.",
    "For each section.summary, summarize only what this section says, with the main point in **bold**.",
    buildInterpretationGuidance(detailLevel),
    "For each section.role_in_article, be concise: 1-2 short sentences only. Explain how this section changes or advances the article by referencing nearby or related sections when useful.",
    "Do not invent section ids. Include one section line per input section.",
    "",
    formatArticleForPrompt(article)
  ].join("\n");
}

function buildPdfProgressivePrompt(
  article: ExtractedArticle,
  pages: number[],
  outputLanguage: OutputLanguage,
  detailLevel: AnalysisDetailLevel = "study"
): string {
  const basePrompt = buildProgressivePrompt(article, outputLanguage, detailLevel);
  return [
    basePrompt,
    "",
    "PDF-specific input rules:",
    `The attached images are PDF pages ${pages.join(", ")} in the same order as the input sections.`,
    "Treat each PDF page as one article section. Use the page screenshot as the source of truth for that section.",
    "For each section.title, write a precise keyword-style title for that page. Do not include page numbers or labels such as 'Page 1'. Keep it under 8 words or 14 Chinese characters. Avoid duplicate titles across pages; if the same keyword repeats, expand it with a specific suffix after ' - ', for example 'Pipeline - Evaluation' or '实验 - 数据集'.",
    "For section.role_in_article, explain how this page changes or advances the PDF by referencing all pages when useful.",
    "If a page is mostly cover, references, agenda, or blank space, still analyze its actual role instead of skipping it."
  ].join("\n");
}

function buildDeepPdfProgressivePrompt(
  article: ExtractedArticle,
  outputLanguage: OutputLanguage,
  detailLevel: AnalysisDetailLevel = "study"
): string {
  const basePrompt = buildProgressivePrompt(article, outputLanguage, detailLevel);
  return [
    basePrompt,
    "",
    "PDF deep-analysis input rules:",
    "This PDF was parsed into structured blocks by Datalab Marker. Each input section is exactly one PDF page, not one heading or subsection.",
    "Section text contains that page's blocks in reading order. Blocks may be headings, paragraphs, lists, tables, figures, equations, or captions.",
    "Analyze the page as the main unit. Do not treat H3/H4-like blocks as separate document sections.",
    "For each section.title, write a precise keyword-style title for that page. Do not include page numbers or labels such as 'Page 1'. Keep it under 8 words or 14 Chinese characters. Avoid duplicate titles across parsed pages; if the same keyword repeats, expand it with a specific suffix after ' - ', for example 'Pipeline - Evaluation' or '实验 - 数据集'.",
    "Do not start section.summary, section.interpretation, or section.role_in_article with a page label such as 'Page 1:' or '第 1 页：'; the UI already shows the page number.",
    "For section.summary, summarize what this page says as a whole.",
    "For section.interpretation, explain the relationships among blocks on the same page: how definitions, claims, evidence, tables, figures, equations, and captions support or contrast each other.",
    "For section.role_in_article, explain how this page advances the PDF document as a whole across all parsed pages."
  ].join("\n");
}

function buildSingleSectionPrompt({
  article,
  section,
  sectionIndex,
  outputLanguage
}: {
  article: ExtractedArticle;
  section: ExtractedSection;
  sectionIndex: number;
  outputLanguage: OutputLanguage;
}): string {
  const languageInstruction =
    outputLanguage === "follow-page"
      ? `Use the same language as the article when possible. Detected page language: ${article.language || "unknown"}.`
      : outputLanguage === "zh"
        ? "Write all user-facing fields in Chinese."
        : "Write all user-facing fields in English.";

  const sectionMap = article.sections
    .map((candidate, index) => `${index + 1}. ${candidate.id} - H${candidate.level} - ${candidate.title}`)
    .join("\n");

  return [
    languageInstruction,
    "Analyze one section from this article. Return strict JSON with exactly this shape:",
    `{
  "id": "same section id from input",
  "summary": "string",
  "interpretation": "string",
  "role_in_article": "string"
}`,
    "For summary, summarize only what this section says, with the main point in **bold**.",
    buildInterpretationGuidance("study", "interpretation"),
    "For role_in_article, be concise: 1-2 short sentences only. Explain how this section changes or advances the article by referencing nearby or related sections when useful. Use **bold** around the key problem, shift, or contribution.",
    "Do not invent section ids.",
    "",
    `Article title: ${article.title}`,
    `Article URL: ${article.url}`,
    `Article excerpt: ${truncate(article.excerpt, 1200)}`,
    "",
    "Article section map:",
    sectionMap,
    "",
    `Target section number: ${sectionIndex + 1} of ${article.sections.length}`,
    `Target section id: ${section.id}`,
    `Target section title: ${section.title}`,
    `Target section level: H${section.level}`,
    "Target section text:",
    truncate(section.text, MAX_SECTION_CHARS)
  ].join("\n");
}

function buildArticleVisualRewritePrompt({
  article,
  section,
  sectionAnalysis,
  visuals,
  outputLanguage
}: {
  article: ExtractedArticle;
  section: ExtractedSection;
  sectionAnalysis: AnalysisSection;
  visuals: ExtractedSectionVisual[];
  outputLanguage: OutputLanguage;
}): string {
  const languageInstruction =
    outputLanguage === "follow-page"
      ? `Use the same language as the article when possible. Detected page language: ${article.language || "unknown"}.`
      : outputLanguage === "zh"
        ? "Write all user-facing fields in Chinese."
        : "Write all user-facing fields in English.";
  const visualContext = visuals
    .map((visual, index) =>
      [
        `VISUAL ${index + 1}`,
        `kind: ${visual.kind}`,
        visual.alt ? `alt: ${visual.alt}` : "",
        visual.caption ? `caption: ${visual.caption}` : "",
        visual.src ? `source: ${visual.src}` : ""
      ].filter(Boolean).join("\n")
    )
    .join("\n\n");

  return [
    languageInstruction,
    "You are improving an existing section analysis after seeing the section's image, GIF frame, or visual component screenshot.",
    "The text-only analysis is already useful. Rewrite it only where the visuals add concrete meaning. Do not discard the original textual argument.",
    "Return strict JSON with exactly this shape:",
    `{
  "id": "same section id from input",
  "title": "optional short title",
  "summary": "rewritten string",
  "interpretation": "rewritten string",
  "role_in_article": "rewritten string",
  "visual_description": "concise concrete description of what the visual shows and why it matters"
}`,
    "For visual_description, describe visible structure, labels, relationships, examples, UI states, chart trends, or interaction cues. Avoid generic phrases like 'the image illustrates the concept'.",
    "For summary, mention the visual only if it changes what the section says.",
    "For interpretation, explicitly connect the visual evidence to the section's idea. Use real markdown bullets with '\\n- ' line breaks when helpful. Put the key visual takeaway in **bold**.",
    "For role_in_article, stay concise: 1-2 short sentences. Explain how the text plus visual moves the article forward.",
    "Use **bold** in the rewritten user-facing fields to mark the key term, claim, contrast, or visual takeaway.",
    "Do not invent section ids. Do not describe visuals that are not visible in the attached images.",
    "",
    `Article title: ${article.title}`,
    `Article URL: ${article.url}`,
    `Article excerpt: ${truncate(article.excerpt, 1200)}`,
    "",
    `Target section id: ${section.id}`,
    `Target section title: ${section.title}`,
    "Target section text:",
    truncate(section.text, MAX_FOLLOW_UP_SECTION_CHARS),
    "",
    "Existing text-only analysis:",
    `summary: ${sectionAnalysis.summary}`,
    `interpretation: ${sectionAnalysis.interpretation}`,
    `role_in_article: ${sectionAnalysis.role_in_article}`,
    "",
    "Visual metadata:",
    visualContext || "No visual metadata available. Use only the attached image content."
  ].join("\n");
}

function buildSectionQuestionPrompt({
  article,
  section,
  sectionAnalysis,
  priorFollowUps,
  question,
  outputLanguage
}: {
  article: ExtractedArticle;
  section: ExtractedSection;
  sectionAnalysis: AnalysisSection | undefined;
  priorFollowUps: SectionFollowUp[];
  question: string;
  outputLanguage: OutputLanguage;
}): string {
  const languageInstruction =
    outputLanguage === "follow-page"
      ? `Answer in the same language as the user's question when possible. Page language: ${article.language || "unknown"}.`
      : outputLanguage === "zh"
        ? "Answer in Chinese."
        : "Answer in English.";

  const cachedAnalysis = sectionAnalysis
    ? [
      "Cached section analysis:",
      `summary: ${sectionAnalysis.summary}`,
      `interpretation: ${sectionAnalysis.interpretation}`,
      `role_in_article: ${sectionAnalysis.role_in_article}`
    ].join("\n")
    : "Cached section analysis: not available.";

  const prior = priorFollowUps.length
    ? priorFollowUps
      .slice(-4)
      .map((item, index) => `Q${index + 1}: ${item.question}\nA${index + 1}: ${item.answer}`)
      .join("\n\n")
    : "No prior follow-up questions for this section.";

  return [
    languageInstruction,
    "The user is asking a follow-up question about a single section. Answer using the section text and cached analysis. Do not re-summarize the whole article unless needed.",
    FOLLOW_UP_MARKDOWN_FORMAT_INSTRUCTION,
    "",
    `Article title: ${article.title}`,
    `Article URL: ${article.url}`,
    `Section title: ${section.title}`,
    `Section id: ${section.id}`,
    "",
    cachedAnalysis,
    "",
    "Prior Q&A cache for this section:",
    prior,
    "",
    "Section text:",
    truncate(section.text, MAX_FOLLOW_UP_SECTION_CHARS),
    "",
    `User question: ${question}`
  ].join("\n");
}

function formatArticleForPrompt(article: ExtractedArticle): string {
  const budgetedSections = budgetSections(article.sections);
  return [
    `Title: ${article.title}`,
    `URL: ${article.url}`,
    `Site: ${article.siteName}`,
    `Excerpt: ${truncate(article.excerpt, 1200)}`,
    "",
    "Sections:",
    ...budgetedSections.map((section, index) =>
      [
        `SECTION ${index + 1}`,
        `id: ${section.id}`,
        `title: ${section.title}`,
        `level: H${section.level}`,
        "text:",
        section.text
      ].join("\n")
    )
  ].join("\n\n");
}

function budgetSections(sections: ExtractedSection[]): ExtractedSection[] {
  let remaining = MAX_TOTAL_CHARS;
  return sections.map((section) => {
    const maxForThis = Math.min(MAX_SECTION_CHARS, Math.max(900, Math.floor(remaining / Math.max(1, sections.length))));
    const text = truncate(section.text, maxForThis);
    remaining -= text.length;
    return { ...section, text };
  });
}

function parseAnalysis(raw: string, sourceSections: ExtractedSection[]): AnalysisResult {
  const cleaned = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const parseError = new Error(`Could not parse model JSON: ${(error as Error).message}`);
    (parseError as Error & { raw?: string }).raw = raw;
    throw parseError;
  }

  if (!isAnalysisResult(parsed)) {
    const shapeError = new Error("Model JSON did not match the expected analysis shape.");
    (shapeError as Error & { raw?: string }).raw = raw;
    throw shapeError;
  }

  const knownIds = new Set(sourceSections.map((section) => section.id));
  return {
    overall: parsed.overall,
    sections: parsed.sections.filter((section) => knownIds.has(section.id))
  };
}

function parseOverview(raw: string): AnalysisResult["overall"] {
  const cleaned = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const parseError = new Error(`Could not parse model JSON: ${(error as Error).message}`);
    (parseError as Error & { raw?: string }).raw = raw;
    throw parseError;
  }

  const candidate = parsed as Pick<AnalysisResult, "overall">;
  if (typeof candidate?.overall?.summary !== "string" || typeof candidate.overall.why_read !== "string") {
    const shapeError = new Error("Model JSON did not match the expected overview shape.");
    (shapeError as Error & { raw?: string }).raw = raw;
    throw shapeError;
  }

  return candidate.overall;
}

async function* readOpenAIStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") {
          continue;
        }

        const chunk = JSON.parse(data) as OpenAIStreamChunk;
        if (chunk.error?.message) {
          throw new Error(chunk.error.message);
        }
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseProgressLine(line: string, knownIds: Set<string>): AnalysisProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(trimmed));
  } catch {
    return null;
  }

  const candidate = parsed as {
    type?: string;
    id?: string;
    title?: string;
    summary?: string;
    why_read?: string;
    interpretation?: string;
    role_in_article?: string;
  };

  if (candidate.type === "overall" && typeof candidate.summary === "string" && typeof candidate.why_read === "string") {
    return {
      type: "overall",
      overall: {
        summary: candidate.summary,
        why_read: candidate.why_read
      }
    };
  }

  if (
    candidate.type === "section" &&
    typeof candidate.id === "string" &&
    knownIds.has(candidate.id) &&
    typeof candidate.summary === "string" &&
    typeof candidate.interpretation === "string" &&
    typeof candidate.role_in_article === "string"
  ) {
    return {
      type: "section",
      section: {
        id: candidate.id,
        ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
        summary: candidate.summary,
        interpretation: candidate.interpretation,
        role_in_article: candidate.role_in_article
      }
    };
  }

  return null;
}

function parseSectionAnalysis(raw: string, expectedId: string): AnalysisSection {
  const cleaned = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const parseError = new Error(`Could not parse model JSON: ${(error as Error).message}`);
    (parseError as Error & { raw?: string }).raw = raw;
    throw parseError;
  }

  const candidate = parsed as AnalysisSection;
  if (
    candidate?.id !== expectedId ||
    typeof candidate.summary !== "string" ||
    typeof candidate.interpretation !== "string" ||
    typeof candidate.role_in_article !== "string"
  ) {
    const shapeError = new Error("Model JSON did not match the expected section analysis shape.");
    (shapeError as Error & { raw?: string }).raw = raw;
    throw shapeError;
  }

  return candidate;
}

function parsePdfGuide(raw: string, expectedPages: number[]): PdfGuideResult {
  const cleaned = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const parseError = new Error(`Could not parse PDF guide JSON: ${(error as Error).message}`);
    (parseError as Error & { raw?: string }).raw = raw;
    throw parseError;
  }

  const candidate = parsed as PdfGuideResult;
  const expectedSet = new Set(expectedPages);
  const pages = Array.isArray(candidate?.pages) ? candidate.pages : [];
  const hasValidShape =
    pages.length === expectedPages.length &&
    expectedPages.every((page) => pages.some((pageGuide) => pageGuide?.page === page)) &&
    pages.every(
      (pageGuide) =>
        Number.isInteger(pageGuide?.page) &&
        expectedSet.has(pageGuide.page) &&
        typeof pageGuide.summary === "string" &&
        typeof pageGuide.explanation === "string" &&
        typeof pageGuide.goal === "string"
    );

  if (!hasValidShape) {
    const shapeError = new Error("Model JSON did not include one PDF guide object for every requested page.");
    (shapeError as Error & { raw?: string }).raw = raw;
    throw shapeError;
  }

  const byPage = new Map(pages.map((pageGuide) => [pageGuide.page, pageGuide]));
  return {
    pages: expectedPages.map((page) => byPage.get(page)).filter((pageGuide): pageGuide is PdfGuideResult["pages"][number] => Boolean(pageGuide))
  };
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
  const candidate = value as AnalysisResult;
  return (
    Boolean(candidate) &&
    typeof candidate.overall?.summary === "string" &&
    typeof candidate.overall?.why_read === "string" &&
    Array.isArray(candidate.sections) &&
    candidate.sections.every(
      (section) =>
        typeof section?.id === "string" &&
        typeof section?.summary === "string" &&
        typeof section?.interpretation === "string" &&
        typeof section?.role_in_article === "string"
    )
  );
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const headSize = Math.floor(maxChars * 0.72);
  const tailSize = Math.max(0, maxChars - headSize - 40);
  return `${value.slice(0, headSize)}\n\n[...truncated...]\n\n${value.slice(-tailSize)}`;
}

import type {
  AnalysisSection,
  AnalysisResult,
  ExtractedArticle,
  ExtractedSection,
  OutputLanguage,
  PdfGuideResult,
  SectionFollowUp,
  Settings
} from "./types";
import { getActiveApiKey, getActivePdfApiKey } from "./settings";
import type { PdfPageImage } from "./pdf";

const MAX_TOTAL_CHARS = 42000;
const MAX_SECTION_CHARS = 3600;
const MAX_FOLLOW_UP_SECTION_CHARS = 9000;
const INTERPRETATION_GUIDANCE =
  "For each section.interpretation, write a simple, quick-scan 'What this means' explanation. Use a real markdown bullet list by default: each item must start on its own line with '- '. Inside JSON/NDJSON strings, encode those line breaks as \\n. Keep it to 2-4 bullets. Use a compact markdown table only when comparison is clearer. Do not put bullets inline in one sentence. Avoid dense paragraphs, abstract wording, and long caveats. Put the most important takeaway in **bold**.";

// , for example '- **Why it matters:** ...\\n- **Use it for:** ...\\n- **Watch out:** ...'

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

export type AnalysisProgressEvent =
  | { type: "overall"; overall: AnalysisResult["overall"] }
  | { type: "section"; section: AnalysisSection };

export async function analyzeArticle(
  article: ExtractedArticle,
  settings: Settings
): Promise<AnalysisResult> {
  const apiKey = getActiveApiKey(settings);
  if (!apiKey) {
    throw new Error("Missing API key. Open the extension settings and add your API key.");
  }

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
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
          content: buildPrompt(article, settings.outputLanguage)
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
  onProgress: (event: AnalysisProgressEvent) => void
): Promise<AnalysisResult> {
  const apiKey = getActiveApiKey(settings);
  if (!apiKey) {
    throw new Error("Missing API key. Open the extension settings and add your API key.");
  }

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
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
          content: buildProgressivePrompt(article, settings.outputLanguage)
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

  const knownIds = new Set(article.sections.map((section) => section.id));
  const sections: AnalysisSection[] = [];
  let overall: AnalysisResult["overall"] | null = null;
  let contentBuffer = "";

  for await (const content of readOpenAIStream(response.body)) {
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

  const uniqueSections = article.sections
    .map((sourceSection) => sections.find((section) => section.id === sourceSection.id))
    .filter((section): section is AnalysisSection => Boolean(section));

  if (uniqueSections.length !== article.sections.length) {
    throw new Error(`Model stream returned ${uniqueSections.length} of ${article.sections.length} section analyses.`);
  }

  return { overall, sections: uniqueSections };
}

export async function analyzeArticleOverview(
  article: ExtractedArticle,
  settings: Settings
): Promise<AnalysisResult["overall"]> {
  const apiKey = getActiveApiKey(settings);
  if (!apiKey) {
    throw new Error("Missing API key. Open the extension settings and add your API key.");
  }

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
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
  const apiKey = getActiveApiKey(settings);
  if (!apiKey) {
    throw new Error("Missing API key. Open the extension settings and add your API key.");
  }

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
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

export async function answerSectionQuestion({
  article,
  section,
  sectionAnalysis,
  priorFollowUps,
  question,
  settings
}: {
  article: ExtractedArticle;
  section: ExtractedSection;
  sectionAnalysis: AnalysisSection | undefined;
  priorFollowUps: SectionFollowUp[];
  question: string;
  settings: Settings;
}): Promise<string> {
  const apiKey = getActiveApiKey(settings);
  if (!apiKey) {
    throw new Error("Missing API key. Open the extension settings and add your API key.");
  }

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
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
  settings
}: {
  title: string;
  url: string;
  pageImages: PdfPageImage[];
  targetPage: number | null;
  question: string;
  settings: Settings;
}): Promise<string> {
  return requestPdfVision({
    pageImages,
    prompt: buildPdfQuestionPrompt({
      title,
      url,
      pages: pageImages.map((image) => image.page),
      targetPage,
      question,
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
    maxTokens: Math.max(2600, Math.min(12000, pageImages.length * 450))
  });
  return parsePdfGuide(raw, pageImages.map((image) => image.page));
}

async function requestPdfVision({
  pageImages,
  prompt,
  settings,
  maxTokens
}: {
  pageImages: PdfPageImage[];
  prompt: string;
  settings: Settings;
  maxTokens: number;
}): Promise<string> {
  const apiKey = getActivePdfApiKey(settings);
  if (!apiKey) {
    throw new Error("Missing PDF API key. Open the extension settings and add your PDF API key.");
  }

  const pdfEndpoint = settings.pdfEndpoint.trim();
  const pdfModel = settings.pdfModel.trim();
  if (!pdfEndpoint) {
    throw new Error("Missing PDF endpoint. Open the extension settings and add your PDF endpoint.");
  }
  if (!pdfModel) {
    throw new Error("Missing PDF parsing model. Open the extension settings and add a PDF parsing model.");
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
    `{"pages":[{"page":1,"summary":"string","explanation":"string","goal":"string"}]}`,
    `The pages array must contain exactly these page numbers, in order: ${pages.join(", ")}.`,
    "For each page.summary, summarize only what this page says. Put the main point in **bold**.",
    "For each page.explanation, explain what this page means in concrete quick-scan bullets. Use real markdown bullets with '\\n- ' line breaks inside the JSON string. Put the key idea in **bold**.",
    "For each page.goal, explain this page's job in the PDF: why this page exists, what the reader should get from it, or how it moves the material forward. Be concrete and cite the page number.",
    "If a page is mostly cover, references, or blank, still return that page and state its actual purpose instead of skipping it."
  ].join("\n\n");
}

function buildPdfQuestionPrompt({
  title,
  url,
  pages,
  targetPage,
  question,
  outputLanguage
}: {
  title: string;
  url: string;
  pages: number[];
  targetPage: number | null;
  question: string;
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
    `下面是 PDF 的第 ${pages.join(", ")} 页截图。请先基于截图内容理解页面，再回答用户问题；如果是多页，请按页组织要点。`,
    focusText,
    `用户问题：${question}`
  ].join("\n\n");
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

function buildPrompt(article: ExtractedArticle, outputLanguage: OutputLanguage): string {
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
    INTERPRETATION_GUIDANCE,
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

function buildProgressivePrompt(article: ExtractedArticle, outputLanguage: OutputLanguage): string {
  const languageInstruction =
    outputLanguage === "follow-page"
      ? [
          `Use the same language as the article when possible. Detected page language: ${article.language || "unknown"}.`,
          "Every user-facing JSON string value must use that page language. Keep JSON keys type, id, summary, why_read, interpretation, and role_in_article exactly as written."
        ].join(" ")
      : outputLanguage === "zh"
        ? "Write every user-facing JSON string value in Chinese. Keep JSON keys type, id, summary, why_read, interpretation, and role_in_article exactly as written."
        : "Write every user-facing JSON string value in English. Keep JSON keys type, id, summary, why_read, interpretation, and role_in_article exactly as written.";

  return [
    languageInstruction,
    "Analyze this article for a reader who wants to learn from it, not just skim it.",
    "Return newline-delimited JSON. Each line must be one complete compact JSON object. Do not output an array. Do not pretty-print. Do not use markdown fences.",
    "First output exactly one overall line:",
    `{"type":"overall","summary":"string","why_read":"string"}`,
    "Then output one section line per input section, in the same order as the input:",
    `{"type":"section","id":"same section id from input","summary":"string","interpretation":"string","role_in_article":"string"}`,
    "Use **bold** in every user-facing analysis field to mark the key term, claim, contrast, problem, or contribution.",
    "For overall.why_read, answer the high-level learning goal: why this is worth reading, and what worldview, values, mental model, or life perspective it may offer.",
    "For each section.summary, summarize only what this section says, with the main point in **bold**.",
    INTERPRETATION_GUIDANCE,
    "For each section.role_in_article, be concise: 1-2 short sentences only. Explain how this section changes or advances the article by referencing nearby or related sections when useful.",
    "Do not invent section ids. Include one section line per input section.",
    "",
    formatArticleForPrompt(article)
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
    INTERPRETATION_GUIDANCE.replace("For each section.interpretation", "For interpretation"),
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

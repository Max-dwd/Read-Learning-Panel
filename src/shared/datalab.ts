import type { DeepPdfBlock, DeepPdfParseResult, DeepPdfSection, PdfBoundingBox, Settings } from "./types";
import type { LoadedPdfDocument } from "./pdf";

type DatalabSubmitResponse = {
  request_id?: string;
  request_check_url?: string;
  success?: boolean;
  error?: string | null;
};

type DatalabPollResponse = {
  status?: string;
  success?: boolean | null;
  error?: string | null;
  output_format?: string;
  chunks?: unknown;
  json?: unknown;
  markdown?: string | null;
  html?: string | null;
  parse_quality_score?: number | null;
  page_count?: number | null;
};

type RawDatalabBlock = {
  id?: unknown;
  block_id?: unknown;
  block_type?: unknown;
  type?: unknown;
  page?: unknown;
  page_id?: unknown;
  text?: unknown;
  markdown?: unknown;
  html?: unknown;
  bbox?: unknown;
  polygon?: unknown;
  section_hierarchy?: unknown;
  children?: unknown;
};

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 90;

export async function parsePdfWithDatalab(
  pdfDocument: LoadedPdfDocument,
  settings: Settings,
  pageRange: string,
  onStatus?: (status: string) => void
): Promise<DeepPdfParseResult> {
  const endpoint = settings.deepPdfParserEndpoint.trim();
  const apiKey = settings.deepPdfParserApiKey.trim();
  if (!endpoint) {
    throw new Error("Missing Datalab parser endpoint. Open settings and add the PDF deep analysis parser endpoint.");
  }
  if (!apiKey) {
    throw new Error("Missing Datalab API key. Open settings and add the PDF deep analysis parser API key.");
  }

  onStatus?.("Fetching PDF file...");
  const pdfResponse = await fetch(pdfDocument.sourceUrl);
  if (!pdfResponse.ok) {
    throw new Error(`Could not fetch PDF for deep parsing. HTTP ${pdfResponse.status}`);
  }
  const pdfBlob = await pdfResponse.blob();

  const formData = new FormData();
  formData.append("file", pdfBlob, safePdfFilename(pdfDocument.title));
  formData.append("mode", settings.deepPdfParserMode || "balanced");
  formData.append("output_format", "chunks,json");
  if (pageRange) {
    formData.append("page_range", pageRange);
  }
  formData.append("include_markdown_in_chunks", "true");
  formData.append("disable_image_extraction", "false");
  formData.append("disable_image_captions", "false");

  onStatus?.("Submitting PDF to Datalab...");
  const submitResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey
    },
    body: formData
  });
  const submitBody = (await submitResponse.json().catch(() => null)) as DatalabSubmitResponse | null;
  if (!submitResponse.ok || submitBody?.success === false) {
    const error = new Error(submitBody?.error || `Datalab request failed with HTTP ${submitResponse.status}`) as Error & {
      raw?: string;
    };
    error.raw = submitBody ? JSON.stringify(submitBody).slice(0, 4000) : "";
    throw error;
  }

  const checkUrl = buildCheckUrl(endpoint, submitBody);
  onStatus?.("Waiting for Datalab parse result...");
  const result = await pollDatalabResult(checkUrl, apiKey, onStatus);
  const blocks = extractBlocks(result, pdfDocument.pageCount);
  const pageBboxes = extractPageBboxes(result, blocks);
  const sections = buildSectionsFromBlocks(blocks, pdfDocument);

  return {
    sourceUrl: pdfDocument.sourceUrl,
    title: pdfDocument.title,
    pageCount: result.page_count || pdfDocument.pageCount,
    pageRange,
    parseQualityScore: typeof result.parse_quality_score === "number" ? result.parse_quality_score : undefined,
    markdown: typeof result.markdown === "string" ? result.markdown : undefined,
    pageBboxes,
    blocks,
    sections,
    createdAt: Date.now()
  };
}

async function pollDatalabResult(
  checkUrl: string,
  apiKey: string,
  onStatus?: (status: string) => void
): Promise<DatalabPollResponse> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await wait(POLL_INTERVAL_MS);
    }

    const response = await fetch(checkUrl, {
      headers: {
        "X-API-Key": apiKey
      }
    });
    const body = (await response.json().catch(() => null)) as DatalabPollResponse | null;
    if (!response.ok) {
      const error = new Error(body?.error || `Datalab result check failed with HTTP ${response.status}`) as Error & {
        raw?: string;
      };
      error.raw = body ? JSON.stringify(body).slice(0, 4000) : "";
      throw error;
    }

    const status = body?.status ?? "processing";
    onStatus?.(`Datalab status: ${status}`);
    if (status === "complete") {
      if (body?.success === false) {
        const error = new Error(body.error || "Datalab parsing failed.") as Error & { raw?: string };
        error.raw = body ? JSON.stringify(body).slice(0, 4000) : "";
        throw error;
      }
      return body ?? {};
    }
    if (status === "failed") {
      const error = new Error(body?.error || "Datalab parsing failed.") as Error & { raw?: string };
      error.raw = body ? JSON.stringify(body).slice(0, 4000) : "";
      throw error;
    }
  }

  throw new Error("Datalab parsing timed out before the result was ready.");
}

function buildCheckUrl(endpoint: string, submitBody: DatalabSubmitResponse | null): string {
  if (submitBody?.request_check_url) {
    return new URL(submitBody.request_check_url, endpoint).toString();
  }
  if (submitBody?.request_id) {
    return new URL(`/api/v1/convert/${submitBody.request_id}`, endpoint).toString();
  }
  throw new Error("Datalab response did not include a result check URL.");
}

function extractBlocks(result: DatalabPollResponse, pageCount: number): DeepPdfBlock[] {
  const rawBlocks = collectRawBlocks(result);
  return rawBlocks
    .map((block, index) => normalizeBlock(block, index, true, pageCount))
    .filter((block): block is DeepPdfBlock => Boolean(block));
}

function collectRawBlocks(result: DatalabPollResponse): RawDatalabBlock[] {
  const candidates = [result.chunks, result.json];
  for (const candidate of candidates) {
    const blocks = readBlocks(candidate);
    if (blocks.length > 0) {
      return blocks;
    }
  }
  return [];
}

function readBlocks(value: unknown): RawDatalabBlock[] {
  if (Array.isArray(value)) {
    return value.filter(isObject) as RawDatalabBlock[];
  }
  if (!isObject(value)) {
    return [];
  }

  const direct = (value as { blocks?: unknown }).blocks;
  if (Array.isArray(direct)) {
    return direct.filter(isObject) as RawDatalabBlock[];
  }

  const pages = (value as { pages?: unknown }).pages;
  if (Array.isArray(pages)) {
    return pages.flatMap((page) => {
      if (!isObject(page)) return [];
      const pageBlocks = (page as { blocks?: unknown; children?: unknown }).blocks ?? (page as { children?: unknown }).children;
      return Array.isArray(pageBlocks) ? pageBlocks.filter(isObject) as RawDatalabBlock[] : [];
    });
  }

  return [];
}

function normalizeBlock(
  block: RawDatalabBlock,
  index: number,
  hasZeroBasedPages: boolean,
  pageCount: number
): DeepPdfBlock | null {
  const rawPage = readPage(block);
  const page = normalizePage(rawPage, hasZeroBasedPages, pageCount);
  if (!page) {
    return null;
  }

  const html = readString(block.html);
  const text = readString(block.markdown) || readString(block.text) || stripHtml(html);
  if (!text.trim()) {
    return null;
  }

  return {
    id: readString(block.id) || readString(block.block_id) || `block-${index + 1}`,
    page,
    type: readString(block.block_type) || readString(block.type) || "Text",
    text: text.trim(),
    html: html || undefined,
    bbox: readBbox(block.bbox) ?? readPolygonBbox(block.polygon)
  };
}

function extractPageBboxes(result: DatalabPollResponse, _blocks: DeepPdfBlock[]): Record<number, PdfBoundingBox> {
  const bboxes: Record<number, PdfBoundingBox> = {};
  const pageObjects = readPageObjects(result.json);

  for (const pageObject of pageObjects) {
    const rawPage = readPage(pageObject);
    const page = normalizePage(rawPage, true, Number.MAX_SAFE_INTEGER);
    const bbox = readBbox(pageObject.bbox) ?? readPolygonBbox(pageObject.polygon);
    if (page && bbox) {
      bboxes[page] = bbox;
    }
  }

  return bboxes;
}

function readPageObjects(value: unknown): RawDatalabBlock[] {
  if (!isObject(value)) {
    return [];
  }
  const pages = (value as { pages?: unknown }).pages;
  return Array.isArray(pages) ? pages.filter(isObject) as RawDatalabBlock[] : [];
}

function buildSectionsFromBlocks(blocks: DeepPdfBlock[], pdfDocument: LoadedPdfDocument): DeepPdfSection[] {
  if (blocks.length === 0) {
    return [
      {
        id: "deep-pdf-section-1",
        title: pdfDocument.title,
        level: 2,
        text: "Datalab returned no text blocks for this PDF.",
        pageStart: 1,
        pageEnd: pdfDocument.pageCount,
        blocks: []
      }
    ];
  }

  const sections: DeepPdfSection[] = [];
  let current: DeepPdfSection | null = null;

  for (const block of blocks) {
    if (!current || isHeadingBlock(block)) {
      if (current) {
        current.text = buildSectionText(current.blocks);
        current.pageEnd = current.blocks.at(-1)?.page ?? current.pageStart;
        sections.push(current);
      }

      current = {
        id: `deep-pdf-section-${sections.length + 1}`,
        title: isHeadingBlock(block) ? firstLine(block.text) : `Page ${block.page}`,
        level: isHeadingBlock(block) ? inferHeadingLevel(block) : 2,
        text: "",
        pageStart: block.page,
        pageEnd: block.page,
        blocks: [block]
      };
      continue;
    }

    current.blocks.push(block);
  }

  if (current) {
    current.text = buildSectionText(current.blocks);
    current.pageEnd = current.blocks.at(-1)?.page ?? current.pageStart;
    sections.push(current);
  }

  return mergeTinySections(sections);
}

function mergeTinySections(sections: DeepPdfSection[]): DeepPdfSection[] {
  const merged: DeepPdfSection[] = [];
  for (const section of sections) {
    const previous = merged.at(-1);
    if (previous && section.text.length < 240) {
      previous.blocks.push(...section.blocks);
      previous.text = buildSectionText(previous.blocks);
      previous.pageEnd = Math.max(previous.pageEnd, section.pageEnd);
      continue;
    }
    merged.push({ ...section });
  }

  return merged.map((section, index) => ({
    ...section,
    id: `deep-pdf-section-${index + 1}`
  }));
}

function buildSectionText(blocks: DeepPdfBlock[]): string {
  return blocks
    .map((block) => [`[Page ${block.page} | ${block.type}]`, block.text].join("\n"))
    .join("\n\n")
    .slice(0, 12000);
}

function isHeadingBlock(block: DeepPdfBlock): boolean {
  return /heading|title|section/i.test(block.type) && block.text.trim().length < 220;
}

function inferHeadingLevel(block: DeepPdfBlock): 2 | 3 {
  return /sub|h3|third/i.test(block.type) ? 3 : 2;
}

function readPage(block: RawDatalabBlock): number | null {
  const rawPage = block.page ?? block.page_id;
  const page = typeof rawPage === "number" ? rawPage : typeof rawPage === "string" ? Number(rawPage) : null;
  return Number.isInteger(page) ? page : null;
}

function normalizePage(page: number | null, hasZeroBasedPages: boolean, pageCount: number): number | null {
  if (page === null) {
    return null;
  }
  const normalized = hasZeroBasedPages ? page + 1 : page;
  return normalized >= 1 && normalized <= pageCount ? normalized : null;
}

function readBbox(value: unknown): PdfBoundingBox | undefined {
  if (!Array.isArray(value) || value.length < 4) {
    return undefined;
  }
  const numbers = value.slice(0, 4).map((item) => (typeof item === "number" ? item : Number(item)));
  return numbers.every((item) => Number.isFinite(item)) ? numbers as PdfBoundingBox : undefined;
}

function readPolygonBbox(value: unknown): PdfBoundingBox | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const points = value
    .map((point) => Array.isArray(point) && point.length >= 2 ? [Number(point[0]), Number(point[1])] : null)
    .filter((point): point is [number, number] =>
      Array.isArray(point) && point.every((coordinate) => Number.isFinite(coordinate))
    );
  if (points.length === 0) {
    return undefined;
  }

  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 120) || "Untitled section";
}

function safePdfFilename(title: string): string {
  const basename = title.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "document";
  return /\.pdf$/i.test(basename) ? basename : `${basename}.pdf`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

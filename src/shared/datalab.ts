import { DEEP_PDF_GEOMETRY_VERSION } from "./types";
import type { DeepPdfBlock, DeepPdfParseResult, DeepPdfSection, PdfBoundingBox, PdfPolygon, Settings } from "./types";
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

type RawDatalabBlockWithPage = {
  block: RawDatalabBlock;
  page: number | null;
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
  formData.append("output_format", "json");
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
    geometryVersion: DEEP_PDF_GEOMETRY_VERSION,
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
    return new URL(`/api/v1/marker/${submitBody.request_id}`, endpoint).toString();
  }
  throw new Error("Datalab response did not include a result check URL.");
}

function extractBlocks(result: DatalabPollResponse, pageCount: number): DeepPdfBlock[] {
  const rawBlocks = collectRawBlocks(result);
  const blocks = rawBlocks
    .map(({ block, page }, index) => normalizeBlock(block, index, page, pageCount))
    .filter((block): block is DeepPdfBlock => Boolean(block));
  return attachNearbyCaptions(blocks);
}

function collectRawBlocks(result: DatalabPollResponse): RawDatalabBlockWithPage[] {
  const jsonBlocks = collectJsonBlocks(result.json);
  if (jsonBlocks.length > 0) {
    return jsonBlocks;
  }

  return collectFlatBlocks(result.chunks).concat(collectFlatBlocks(result.json));
}

function normalizeBlock(
  block: RawDatalabBlock,
  index: number,
  pageContext: number | null,
  pageCount: number
): DeepPdfBlock | null {
  const rawPage = readPage(block);
  const page = normalizePage(rawPage, true, pageCount) ?? pageContext;
  if (!page) {
    return null;
  }

  const html = readString(block.html);
  const polygon = readPolygon(block.polygon);
  const bbox = readBbox(block.bbox) ?? polygonToBbox(polygon);
  const type = readString(block.block_type) || readString(block.type) || "Text";
  const caption = readCaptionText(block);
  const text = readString(block.markdown) || readString(block.text) || stripHtml(html) || caption;
  if (!text.trim() && !bbox) {
    return null;
  }

  return {
    id: readString(block.id) || readString(block.block_id) || `block-${index + 1}`,
    page,
    type,
    text: text.trim() || type,
    caption: caption || undefined,
    html: html || undefined,
    bbox,
    polygon
  };
}

function attachNearbyCaptions(blocks: DeepPdfBlock[]): DeepPdfBlock[] {
  const captions = blocks.filter((block) => isCaptionBlock(block) && block.bbox && block.text.trim());
  if (captions.length === 0) {
    return blocks;
  }

  return blocks.map((block) => {
    if (block.caption || !isCaptionableBlock(block) || !block.bbox) {
      return block;
    }

    const caption = findNearestCaption(block, captions);
    return caption ? { ...block, caption: caption.text } : block;
  });
}

function findNearestCaption(block: DeepPdfBlock, captions: DeepPdfBlock[]): DeepPdfBlock | null {
  if (!block.bbox) {
    return null;
  }

  const [x1, y1, x2, y2] = block.bbox;
  const blockCenterX = (x1 + x2) / 2;
  const blockHeight = Math.max(1, y2 - y1);
  let best: { block: DeepPdfBlock; score: number } | null = null;

  for (const caption of captions) {
    if (caption.page !== block.page || !caption.bbox) {
      continue;
    }

    const [cx1, cy1, cx2, cy2] = caption.bbox;
    const captionCenterX = (cx1 + cx2) / 2;
    const verticalGap = cy1 >= y2 ? cy1 - y2 : y1 >= cy2 ? y1 - cy2 : 0;
    const horizontalGap = Math.max(0, Math.max(x1, cx1) - Math.min(x2, cx2));
    const centerDistance = Math.abs(captionCenterX - blockCenterX);
    const maxNearbyDistance = Math.max(40, blockHeight * 0.8);

    if (verticalGap > maxNearbyDistance || horizontalGap > Math.max(80, (x2 - x1) * 0.4)) {
      continue;
    }

    const score = verticalGap + centerDistance * 0.15 + horizontalGap;
    if (!best || score < best.score) {
      best = { block: caption, score };
    }
  }

  return best?.block ?? null;
}

function isCaptionableBlock(block: DeepPdfBlock): boolean {
  return /figure|picture|image|table/i.test(block.type);
}

function isCaptionBlock(block: DeepPdfBlock): boolean {
  return /caption/i.test(block.type);
}

function extractPageBboxes(result: DatalabPollResponse, _blocks: DeepPdfBlock[]): Record<number, PdfBoundingBox> {
  const bboxes: Record<number, PdfBoundingBox> = {};
  const pageObjects = readPageObjects(result.json);

  for (const pageObject of pageObjects) {
    const page = pageObject.page;
    const bbox = readBbox(pageObject.block.bbox) ?? polygonToBbox(readPolygon(pageObject.block.polygon));
    if (page && bbox) {
      bboxes[page] = bbox;
    }
  }

  return bboxes;
}

function collectJsonBlocks(value: unknown): RawDatalabBlockWithPage[] {
  return readPageObjects(value).flatMap(({ block, page }) =>
    readChildren(block).flatMap((child) => flattenJsonBlock(child, page))
  );
}

function flattenJsonBlock(block: RawDatalabBlock, inheritedPage: number | null): RawDatalabBlockWithPage[] {
  const page = normalizePage(readPage(block), true, Number.MAX_SAFE_INTEGER) ?? inheritedPage;
  const children = readChildren(block);
  const self = isPageBlock(block) ? [] : [{ block, page }];
  return self.concat(children.flatMap((child) => flattenJsonBlock(child, page)));
}

function collectFlatBlocks(value: unknown): RawDatalabBlockWithPage[] {
  return readFlatBlocks(value).map((block) => ({
    block,
    page: normalizePage(readPage(block), true, Number.MAX_SAFE_INTEGER)
  }));
}

function readFlatBlocks(value: unknown): RawDatalabBlock[] {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) {
    return parsed.filter(isObject) as RawDatalabBlock[];
  }
  if (!isObject(parsed)) {
    return [];
  }

  const direct = (parsed as { blocks?: unknown }).blocks;
  if (Array.isArray(direct)) {
    return direct.filter(isObject) as RawDatalabBlock[];
  }

  const chunks = (parsed as { chunks?: unknown }).chunks;
  if (Array.isArray(chunks)) {
    return chunks.filter(isObject) as RawDatalabBlock[];
  }

  return [];
}

function readPageObjects(value: unknown): RawDatalabBlockWithPage[] {
  const parsed = parseMaybeJson(value);
  const candidates = collectPageCandidates(parsed);

  return candidates.map((block, index) => ({
    block,
    page: normalizePage(readPage(block), true, Number.MAX_SAFE_INTEGER) ?? index + 1
  }));
}

function collectPageCandidates(value: unknown): RawDatalabBlock[] {
  if (Array.isArray(value)) {
    return value.filter(isObject) as RawDatalabBlock[];
  }
  if (!isObject(value)) {
    return [];
  }

  if (isPageBlock(value as RawDatalabBlock)) {
    return [value as RawDatalabBlock];
  }

  const pages = (value as { pages?: unknown }).pages;
  if (Array.isArray(pages)) {
    return pages.filter(isObject) as RawDatalabBlock[];
  }

  const children = (value as { children?: unknown }).children;
  if (Array.isArray(children)) {
    const childPages = children.filter((child): child is RawDatalabBlock => isObject(child) && isPageBlock(child as RawDatalabBlock));
    if (childPages.length > 0) {
      return childPages;
    }
  }

  return [];
}

function readChildren(block: RawDatalabBlock): RawDatalabBlock[] {
  const children = block.children;
  return Array.isArray(children) ? children.filter(isObject) as RawDatalabBlock[] : [];
}

function readCaptionText(block: RawDatalabBlock): string {
  const captions = collectCaptionBlocks(block)
    .map((captionBlock) => {
      const html = readString(captionBlock.html);
      return readString(captionBlock.markdown) || readString(captionBlock.text) || stripHtml(html);
    })
    .map((text) => text.trim())
    .filter(Boolean);
  return uniqueStrings(captions).join("\n");
}

function collectCaptionBlocks(block: RawDatalabBlock): RawDatalabBlock[] {
  return readChildren(block).flatMap((child) => {
    const type = readString(child.block_type) || readString(child.type);
    const nested = collectCaptionBlocks(child);
    return /caption/i.test(type) ? [child, ...nested] : nested;
  });
}

function isPageBlock(block: RawDatalabBlock): boolean {
  const type = readString(block.block_type) || readString(block.type);
  const id = readString(block.id) || readString(block.block_id);
  return /^page$/i.test(type) || /\/page\/\d+\/page\//i.test(id);
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
  if (Number.isInteger(page)) {
    return page;
  }

  const id = readString(block.id) || readString(block.block_id);
  const match = id.match(/\/page\/(\d+)(?:\/|$)/i);
  return match ? Number(match[1]) : null;
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

function readPolygon(value: unknown): PdfPolygon | undefined {
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

  return points;
}

function polygonToBbox(polygon: PdfPolygon | undefined): PdfBoundingBox | undefined {
  if (!polygon || polygon.length === 0) {
    return undefined;
  }

  const xs = polygon.map((point) => point[0]);
  const ys = polygon.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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

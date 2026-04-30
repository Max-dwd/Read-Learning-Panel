import type { DeepPdfBlock, DeepPdfParseResult } from "./types";

const DEEP_PDF_PARSE_STORAGE_PREFIX = "learnPanelDeepPdfParse_";
const DEEP_PDF_BBOX_VISIBILITY_STORAGE_PREFIX = "learnPanelDeepPdfBboxVisible_";

export async function saveDeepPdfParse(sourceUrl: string, pageRange: string, result: DeepPdfParseResult): Promise<void> {
  const key = getDeepPdfParseStorageKey(sourceUrl, pageRange);
  await chrome.storage.local.set({ [key]: result });
}

export async function loadSavedDeepPdfParse(sourceUrl: string, pageRange: string): Promise<DeepPdfParseResult | null> {
  const key = getDeepPdfParseStorageKey(sourceUrl, pageRange);
  const stored = await chrome.storage.local.get(key);
  const result = stored[key] as DeepPdfParseResult | undefined;
  return result && Array.isArray(result.sections) && Array.isArray(result.blocks) ? result : null;
}

export async function saveDeepPdfBoundingBoxesVisible(sourceUrl: string, pageRange: string, visible: boolean): Promise<void> {
  const key = getDeepPdfBoundingBoxesStorageKey(sourceUrl, pageRange);
  await chrome.storage.local.set({ [key]: visible });
}

export async function loadSavedDeepPdfBoundingBoxesVisible(sourceUrl: string, pageRange: string): Promise<boolean> {
  const key = getDeepPdfBoundingBoxesStorageKey(sourceUrl, pageRange);
  const stored = await chrome.storage.local.get(key);
  return stored[key] === true;
}

export function getDeepPdfBlocksForViewer(result: DeepPdfParseResult): DeepPdfBlock[] {
  return result.sections.flatMap((section) =>
    section.blocks.map((block) => ({
      ...block,
      sectionId: section.id
    }))
  );
}

function getDeepPdfParseStorageKey(sourceUrl: string, pageRange: string): string {
  return `${DEEP_PDF_PARSE_STORAGE_PREFIX}${sourceUrl}::${pageRange || "all"}`;
}

function getDeepPdfBoundingBoxesStorageKey(sourceUrl: string, pageRange: string): string {
  return `${DEEP_PDF_BBOX_VISIBILITY_STORAGE_PREFIX}${sourceUrl}::${pageRange || "all"}`;
}

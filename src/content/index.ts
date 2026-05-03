import type {
  ContentRequest,
  ContentResponse,
  ExtractedArticle,
  ExtractedSection,
  ExtractedSectionVisual
} from "../shared/types";

const SECTION_ATTR = "data-learn-panel-section-id";
const HIGHLIGHT_CLASS = "learn-panel-section-highlight";
const VISUAL_ELEMENT_SELECTOR = [
  "figure",
  "picture",
  "img",
  "video",
  "canvas",
  "svg[role='img']",
  "[role='img']",
  "[data-chronicle-mini]",
  "[data-cli-terminal-preview]",
  "[style*='background-image']",
  "[class*='illustration' i]",
  "[class*='chart' i]",
  "[class*='diagram' i]",
  "[class*='graph' i]",
  "[class*='media' i]",
  "[class*='visual' i]"
].join(",");
let extractedSectionIds: string[] = [];

chrome.runtime.onMessage.addListener(
  (request: ContentRequest, _sender, sendResponse: (response: ContentResponse) => void) => {
    try {
      if (request.type === "LEARN_PANEL_GET_ARTICLE") {
        sendResponse({ ok: true, article: extractArticle() });
        return false;
      }

      if (request.type === "LEARN_PANEL_SCROLL_TO_SECTION") {
        scrollToSection(request.sectionId);
        sendResponse({ ok: true });
        return false;
      }

      if (request.type === "LEARN_PANEL_GET_SELECTION") {
        const selection = window.getSelection()?.toString().trim() ?? "";
        sendResponse({ ok: true, selection });
        return false;
      }

      if (request.type === "LEARN_PANEL_GET_ACTIVE_SECTION") {
        sendResponse({ ok: true, activeSectionId: getActiveSectionId() });
        return false;
      }

      sendResponse({ ok: false, error: "Unknown content request." });
      return false;
    } catch (error) {
      sendResponse({ ok: false, error: (error as Error).message });
      return false;
    }
  }
);

function extractArticle(): ExtractedArticle {
  ensureHighlightStyle();

  const root = findArticleRoot();
  const title = getTitle(root);
  const text = normalizeText(root.innerText);
  const sections = extractSections(root);
  extractedSectionIds = sections.map((section) => section.id);

  return {
    title,
    url: location.href,
    siteName: location.hostname,
    language: document.documentElement.lang || navigator.language || "",
    excerpt: buildExcerpt(text),
    text,
    sections
  };
}

function findArticleRoot(): HTMLElement {
  const explicit = document.querySelector<HTMLElement>(
    [
      "article",
      "main article",
      "main",
      "[role='main']",
      ".post-content",
      ".entry-content",
      ".article-content",
      ".article-body",
      ".content",
      "#content"
    ].join(",")
  );

  if (explicit && normalizeText(explicit.innerText).length > 500) {
    return explicit;
  }

  const candidates = Array.from(document.body.querySelectorAll<HTMLElement>("article, main, section, div"))
    .filter(isVisible)
    .map((element) => ({ element, score: scoreTextDensity(element) }))
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.element ?? document.body;
}

function extractSections(root: HTMLElement): ExtractedSection[] {
  const headings = Array.from(root.querySelectorAll<HTMLHeadingElement>("h2, h3")).filter(
    (heading) => isVisible(heading) && normalizeText(heading.innerText).length > 0
  );

  if (headings.length === 0) {
    const id = "learn-section-overview";
    root.setAttribute(SECTION_ATTR, id);
    return [
      {
        id,
        title: getTitle(root),
        level: 2,
        text: normalizeText(root.innerText),
        visuals: collectElementVisuals(root, normalizeText(root.innerText))
      }
    ];
  }

  const leadVisuals = collectLeadVisuals(root, headings[0]);
  const rawSections = headings.map((heading, index) => {
    const id = `learn-section-${index + 1}`;
    heading.setAttribute(SECTION_ATTR, id);
    const sectionVisuals = collectSectionVisuals(root, heading, headings[index + 1]);
    return {
      id,
      title: normalizeText(heading.innerText),
      level: Number(heading.tagName.slice(1)) as 2 | 3,
      text: collectSectionText(root, heading, headings[index + 1]),
      visuals: index === 0 ? mergeVisuals(leadVisuals, sectionVisuals) : sectionVisuals
    };
  });

  return mergeShortSections(rawSections);
}

function collectSectionText(root: HTMLElement, start: HTMLElement, next: HTMLElement | undefined): string {
  const range = document.createRange();
  range.setStartBefore(start);
  if (next) {
    range.setEndBefore(next);
  } else {
    range.setEndAfter(root.lastChild ?? start);
  }

  const fragment = range.cloneContents();
  const container = document.createElement("div");
  container.append(fragment);
  return normalizeText(container.innerText || container.textContent || "");
}

function mergeShortSections(sections: ExtractedSection[]): ExtractedSection[] {
  const merged: ExtractedSection[] = [];

  for (const section of sections) {
    if (section.text.length < 280 && merged.length > 0) {
      const previous = merged[merged.length - 1];
      previous.text = normalizeText(`${previous.text}\n\n${section.title}\n${section.text}`);
      previous.visuals = mergeVisuals(previous.visuals, section.visuals);
      continue;
    }
    merged.push({ ...section });
  }

  return merged;
}

function collectSectionVisuals(root: HTMLElement, start: HTMLElement, next: HTMLElement | undefined): ExtractedSectionVisual[] {
  const range = document.createRange();
  range.setStartBefore(start);
  if (next) {
    range.setEndBefore(next);
  } else {
    range.setEndAfter(root.lastChild ?? start);
  }

  const sectionText = collectSectionText(root, start, next);
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(VISUAL_ELEMENT_SELECTOR))
    .filter((element) => isVisible(element) && safeIntersectsNode(range, element));
  return collectVisualsFromElements(candidates, sectionText);
}

function collectElementVisuals(root: HTMLElement, text: string): ExtractedSectionVisual[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(VISUAL_ELEMENT_SELECTOR))
    .filter(isVisible);
  return collectVisualsFromElements(candidates, text);
}

function collectLeadVisuals(root: HTMLElement, firstHeading: HTMLElement): ExtractedSectionVisual[] {
  const range = document.createRange();
  range.setStartBefore(root.firstChild ?? firstHeading);
  range.setEndBefore(firstHeading);

  const candidates = Array.from(root.querySelectorAll<HTMLElement>(VISUAL_ELEMENT_SELECTOR))
    .filter((element) => isVisible(element) && safeIntersectsNode(range, element));
  return collectVisualsFromElements(candidates, normalizeText(root.innerText));
}

function collectVisualsFromElements(elements: HTMLElement[], sectionText: string): ExtractedSectionVisual[] {
  const visuals: ExtractedSectionVisual[] = [];
  const seen = new Set<string>();

  for (const element of elements) {
    const visual = elementToVisual(element, sectionText);
    if (!visual) {
      continue;
    }
    const key = visual.imageDataUrl || visual.src || `${visual.kind}:${visual.caption || visual.alt || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    visuals.push({
      ...visual,
      id: `visual-${visuals.length + 1}`
    });
    if (visuals.length >= 3) {
      break;
    }
  }

  return visuals;
}

function elementToVisual(element: HTMLElement, sectionText: string): Omit<ExtractedSectionVisual, "id"> | null {
  const markerKind = getMarkerVisualKind(sectionText);
  const image = element instanceof HTMLImageElement ? element : element.querySelector<HTMLImageElement>("img");
  const video = element instanceof HTMLVideoElement ? element : element.querySelector<HTMLVideoElement>("video");
  const canvas = element instanceof HTMLCanvasElement ? element : element.querySelector<HTMLCanvasElement>("canvas");
  const svg = element instanceof SVGSVGElement ? element : element.querySelector<SVGSVGElement>("svg");

  if (image) {
    const src = absolutizeUrl(image.currentSrc || image.src);
    if (!src && !image.alt.trim()) {
      return null;
    }
    const isGif = /\.gif(?:[?#].*)?$/i.test(src) || src.startsWith("data:image/gif");
    return {
      kind: isGif ? "gif" : markerKind ?? "image",
      src,
      imageDataUrl: isGif ? undefined : rasterizeImage(image),
      alt: normalizeText(image.alt || element.getAttribute("aria-label") || ""),
      caption: getFigureCaption(element)
    };
  }

  if (video) {
    const poster = absolutizeUrl(video.poster);
    return poster
      ? {
        kind: markerKind ?? "component_screenshot",
        src: poster,
        alt: normalizeText(video.getAttribute("aria-label") || ""),
        caption: getFigureCaption(element)
      }
      : null;
  }

  if (canvas) {
    const imageDataUrl = rasterizeCanvas(canvas);
    return imageDataUrl
      ? {
        kind: markerKind ?? "component_screenshot",
        imageDataUrl,
        alt: normalizeText(canvas.getAttribute("aria-label") || ""),
        caption: getFigureCaption(element)
      }
      : null;
  }

  if (svg) {
    const imageDataUrl = serializeSvg(svg);
    if (imageDataUrl) {
      return {
        kind: markerKind ?? "component_screenshot",
        imageDataUrl,
        alt: getVisualLabel(element),
        caption: getFigureCaption(element)
      };
    }
  }

  const backgroundImage = getBackgroundImageUrl(element);
  const visualLabel = getVisualLabel(element);
  if (backgroundImage || isRichVisualContainer(element, visualLabel)) {
    return {
      kind: markerKind ?? "component_screenshot",
      src: backgroundImage || undefined,
      imageDataUrl: rasterizeElementSummary(element),
      alt: visualLabel,
      caption: getFigureCaption(element)
    };
  }

  const roleLabel = normalizeText(element.getAttribute("aria-label") || element.innerText || "");
  if (roleLabel && markerKind) {
    return {
      kind: markerKind,
      alt: roleLabel,
      caption: getFigureCaption(element)
    };
  }

  return null;
}

function getMarkerVisualKind(text: string): ExtractedSectionVisual["kind"] | null {
  if (text.includes("(动图)") || text.includes("（动图）")) {
    return "gif";
  }
  if (text.includes("(视觉交互组件截图)") || text.includes("（视觉交互组件截图）")) {
    return "component_screenshot";
  }
  if (text.includes("(图片)") || text.includes("（图片）")) {
    return "image";
  }
  return null;
}

function getFigureCaption(element: HTMLElement): string {
  const figure = element.closest("figure");
  const caption = figure?.querySelector<HTMLElement>("figcaption");
  return normalizeText(caption?.innerText || "");
}

function getVisualLabel(element: HTMLElement): string {
  return truncateText(
    normalizeText(
      element.getAttribute("aria-label") ||
        element.getAttribute("alt") ||
        element.getAttribute("title") ||
        element.querySelector<HTMLElement>("figcaption")?.innerText ||
        element.innerText ||
        ""
    ),
    420
  );
}

function isRichVisualContainer(element: HTMLElement, label: string): boolean {
  if (element.matches("[data-chronicle-mini], [data-cli-terminal-preview]")) {
    return true;
  }
  const className = String(element.getAttribute("class") || "");
  if (/(illustration|chart|diagram|graph|media|visual)/i.test(className)) {
    return true;
  }
  const rect = element.getBoundingClientRect();
  return rect.width >= 180 && rect.height >= 140 && label.length >= 20 && element.querySelectorAll("button, [role], svg").length >= 2;
}

function getBackgroundImageUrl(element: HTMLElement): string {
  const backgroundImage = window.getComputedStyle(element).backgroundImage;
  const match = /url\((['"]?)(.*?)\1\)/.exec(backgroundImage);
  return match?.[2] ? absolutizeUrl(match[2]) : "";
}

function rasterizeImage(image: HTMLImageElement): string | undefined {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return undefined;
  }

  const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return undefined;
  }
}

function serializeSvg(svg: SVGSVGElement): string | undefined {
  const rect = svg.getBoundingClientRect();
  if (rect.width < 24 || rect.height < 24) {
    return undefined;
  }
  try {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if (!clone.getAttribute("width")) {
      clone.setAttribute("width", String(Math.round(rect.width)));
    }
    if (!clone.getAttribute("height")) {
      clone.setAttribute("height", String(Math.round(rect.height)));
    }
    const serialized = new XMLSerializer().serializeToString(clone);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
  } catch {
    return undefined;
  }
}

function rasterizeElementSummary(element: HTMLElement): string | undefined {
  const rect = element.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 80) {
    return undefined;
  }

  try {
    const width = Math.min(900, Math.max(1, Math.round(rect.width)));
    const height = Math.min(700, Math.max(1, Math.round(rect.height)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }
    context.fillStyle = "#f7f7f4";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "#d8d4ca";
    context.lineWidth = 2;
    context.strokeRect(1, 1, width - 2, height - 2);
    context.fillStyle = "#111827";
    context.font = "18px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    drawWrappedText(context, getVisualLabel(element) || "Visual component", 24, 34, width - 48, 26, height - 48);
    return canvas.toDataURL("image/png");
  } catch {
    return undefined;
  }
}

function rasterizeCanvas(source: HTMLCanvasElement): string | undefined {
  if (source.width <= 0 || source.height <= 0) {
    return undefined;
  }

  const scale = Math.min(1, 900 / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }
    context.drawImage(source, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return undefined;
  }
}

function safeIntersectsNode(range: Range, element: HTMLElement): boolean {
  try {
    return range.intersectsNode(element);
  } catch {
    return false;
  }
}

function mergeVisuals(
  left: ExtractedSectionVisual[] | undefined,
  right: ExtractedSectionVisual[] | undefined
): ExtractedSectionVisual[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  if (merged.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  return merged.filter((visual) => {
    const key = visual.imageDataUrl || visual.src || `${visual.kind}:${visual.caption || visual.alt || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, 3);
}

function absolutizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed, document.baseURI).href;
  } catch {
    return trimmed;
  }
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxHeight: number
): void {
  const words = text.split(/\s+/).filter(Boolean);
  let line = "";
  let currentY = y;

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width > maxWidth && line) {
      context.fillText(line, x, currentY);
      currentY += lineHeight;
      line = word;
      if (currentY > maxHeight) {
        context.fillText("...", x, currentY);
        return;
      }
    } else {
      line = next;
    }
  }

  if (line && currentY <= maxHeight) {
    context.fillText(line, x, currentY);
  }
}

function scrollToSection(sectionId: string): void {
  ensureHighlightStyle();

  const target = document.querySelector<HTMLElement>(`[${SECTION_ATTR}="${CSS.escape(sectionId)}"]`);
  if (!target) {
    throw new Error(`Could not find section ${sectionId} on this page.`);
  }

  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.add(HIGHLIGHT_CLASS);
  window.setTimeout(() => target.classList.remove(HIGHLIGHT_CLASS), 1800);
}

function getActiveSectionId(): string | null {
  if (extractedSectionIds.length === 0) {
    extractedSectionIds = extractSections(findArticleRoot()).map((section) => section.id);
  }

  const targets = extractedSectionIds
    .map((id) => ({
      id,
      element: document.querySelector<HTMLElement>(`[${SECTION_ATTR}="${CSS.escape(id)}"]`)
    }))
    .filter((target): target is { id: string; element: HTMLElement } => target.element !== null && isTrackable(target.element));

  if (targets.length === 0) {
    return null;
  }

  const anchorY = Math.min(220, Math.max(80, window.innerHeight * 0.28));
  let lastAbove: string | null = null;
  let firstBelow: string | null = null;

  for (const target of targets) {
    const rect = target.element.getBoundingClientRect();
    if (rect.top <= anchorY) {
      lastAbove = target.id;
    } else if (!firstBelow) {
      firstBelow = target.id;
    }
  }

  return lastAbove ?? firstBelow ?? targets[0].id;
}

function ensureHighlightStyle(): void {
  if (document.getElementById("learn-panel-highlight-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "learn-panel-highlight-style";
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 3px solid #2f6df6 !important;
      outline-offset: 6px !important;
      border-radius: 6px !important;
      transition: outline-color 300ms ease;
      scroll-margin-top: 88px !important;
    }
  `;
  document.documentElement.append(style);
}

function getTitle(root: HTMLElement): string {
  const heading = root.querySelector<HTMLHeadingElement>("h1");
  return normalizeText(heading?.innerText || document.title || location.hostname);
}

function buildExcerpt(text: string): string {
  return text.slice(0, 1800);
}

function scoreTextDensity(element: HTMLElement): number {
  const text = normalizeText(element.innerText);
  if (text.length < 400) {
    return 0;
  }

  const linkText = Array.from(element.querySelectorAll("a"))
    .map((link) => normalizeText((link as HTMLElement).innerText))
    .join(" ");
  const headingBonus = element.querySelectorAll("h1, h2, h3").length * 140;
  const paragraphBonus = element.querySelectorAll("p").length * 60;
  const linkPenalty = linkText.length * 0.7;
  return text.length + headingBonus + paragraphBonus - linkPenalty;
}

function isVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.offsetParent !== null;
}

function isTrackable(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

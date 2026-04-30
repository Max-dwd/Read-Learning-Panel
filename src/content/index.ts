import type { ContentRequest, ContentResponse, ExtractedArticle, ExtractedSection } from "../shared/types";

const SECTION_ATTR = "data-learn-panel-section-id";
const HIGHLIGHT_CLASS = "learn-panel-section-highlight";
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
        text: normalizeText(root.innerText)
      }
    ];
  }

  const rawSections = headings.map((heading, index) => {
    const id = `learn-section-${index + 1}`;
    heading.setAttribute(SECTION_ATTR, id);
    return {
      id,
      title: normalizeText(heading.innerText),
      level: Number(heading.tagName.slice(1)) as 2 | 3,
      text: collectSectionText(root, heading, headings[index + 1])
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
      continue;
    }
    merged.push({ ...section });
  }

  return merged;
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

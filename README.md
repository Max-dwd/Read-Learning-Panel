# Reading Learning Panel

Chrome MV3 extension for article-oriented reading and learning. It extracts H2/H3 sections from the current page, opens a Chrome Side Panel, and uses an OpenAI-compatible chat completion endpoint to generate:

- overall article summary
- why the article is worth reading
- per-section summary
- each section's role in the article and relationship to the reading goal

## Why Modulized Reading

Long articles and PDFs are hard to learn from when they are treated as one continuous block. Reading Learning Panel turns a document into smaller reading modules, so each section can be understood, questioned, and revisited on its own.

This is useful because it helps you:

- see the document structure before spending attention on details
- separate the author's main claim, evidence, examples, methods, and caveats
- understand why a section exists instead of only what it says
- ask follow-up questions about one section without losing the full-document context
- review later by returning to the exact module, page, quote, or visual region

The goal is not just summarization. The panel is designed to make reading feel closer to guided self-study: first map the text, then inspect important modules, then ask targeted questions.

## Example

Suppose you open a dense article about AI agents or a textbook PDF chapter.

Instead of reading it as one long page, the extension can split it into modules like:

| Module | What the panel helps with |
| --- | --- |
| Introduction | Identifies the main problem and why the topic matters |
| Background | Explains prerequisites and terms that later sections depend on |
| Method / Argument | Shows the core mechanism, reasoning chain, or proposed approach |
| Evidence / Examples | Separates proof, examples, charts, and case studies from the main claim |
| Limitations | Calls out assumptions, tradeoffs, and where the argument may fail |
| Conclusion | Connects the section back to the overall reading goal |

For each module, the side panel can show a short summary, the module's role in the whole article, and a focused Q&A area. In PDF mode, page-level cards and visual selection let you ask about a specific page, figure, table, or selected region instead of asking the model to reinterpret the entire file every time.

## Setup

```bash
npm install
npm run build
```

Then open Chrome:

1. Go to `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select `/Users/h/ai/ext/learn/dist`.

If you accidentally select `/Users/h/ai/ext/learn`, that also works after `npm run build`; the root `manifest.json` points Chrome at the built files in `dist/`.

## Settings

Open the extension settings page and configure:

- one or more model entries using the OpenCode Go, DeepSeek, Gemini, or Custom preset
- API key for each model entry
- endpoint for each model entry
- model name for each model entry, default `mimo-v2.5` for OpenCode Go
- whether the model is multimodal, required for PDF visual analysis
- output language: follow page, Chinese, or English

For DeepSeek, choose the DeepSeek preset. It fills:

- endpoint `https://api.deepseek.com/chat/completions`
- model `deepseek-v4-flash`

For Gemini, choose the Gemini preset. It uses Google's OpenAI-compatible endpoint:

- endpoint `https://generativelanguage.googleapis.com/v1beta/openai`
- model `gemini-2.5-flash`

## Development

```bash
npm run build
```

Reload the unpacked extension after each build.

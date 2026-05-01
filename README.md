# Reading Learning Panel

Chrome MV3 extension for article-oriented reading and learning. It extracts H2/H3 sections from the current page, opens a Chrome Side Panel, and uses an OpenAI-compatible chat completion endpoint to generate:

- overall article summary
- why the article is worth reading
- per-section summary
- each section's role in the article and relationship to the reading goal

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

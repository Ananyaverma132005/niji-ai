# Niji AI

Chat with your documents privately. The language model runs inside your browser, so your files and questions never leave your device.

![Niji AI](docs/screenshot.png)

## Features

- Add PDF, TXT or Markdown files and ask questions about them
- Answers point to the exact passages they came from
- Runs on your GPU in the browser, with no server or API key
- Shows how many network requests were made while answering (zero)
- Works offline once the model has loaded

## Tech stack

JavaScript, WebGPU, WebLLM, transformers.js, pdf.js, IndexedDB

## Run locally

```bash
git clone https://github.com/Ananyaverma132005/niji-ai.git
cd niji-ai
python -m http.server 8000
```

Open http://localhost:8000 in Chrome or Edge.

## Live demo

https://ananyaverma132005.github.io/niji-ai/

// Reads PDF, TXT and MD files in the browser and splits them into chunks.

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs';

const CHUNK_SIZE = 700;   // characters
const CHUNK_OVERLAP = 120;

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return lib;
    });
  }
  return pdfjsPromise;
}

export async function readFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) {
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      pages.push({ page: i, text: clean(text) });
    }
    return pages;
  }
  if (name.endsWith('.txt') || name.endsWith('.md')) {
    return [{ page: null, text: clean(await file.text()) }];
  }
  throw new Error(`Unsupported file type: ${file.name}`);
}

function clean(text) {
  return text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function chunkPages(pages, docName) {
  const chunks = [];
  for (const { page, text } of pages) {
    const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let current = '';
    const flush = () => {
      if (current.trim().length > 40) chunks.push({ doc: docName, page, text: current.trim() });
      // Carry some overlap into the next chunk, starting at a word boundary.
      const tail = current.slice(-CHUNK_OVERLAP);
      current = tail.slice(tail.search(/\s/) + 1);
    };
    for (const para of paragraphs) {
      if (para.length > CHUNK_SIZE) {
        // Long paragraph: split on sentences.
        for (const sentence of para.split(/(?<=[.!?])\s+/)) {
          if (current.length + sentence.length > CHUNK_SIZE) flush();
          current += (current ? ' ' : '') + sentence;
        }
      } else {
        if (current.length + para.length > CHUNK_SIZE) flush();
        current += (current ? '\n\n' : '') + para;
      }
    }
    if (current.trim().length > 40 && !chunks.some((c) => c.text === current.trim())) {
      chunks.push({ doc: docName, page, text: current.trim() });
    }
  }
  return chunks;
}

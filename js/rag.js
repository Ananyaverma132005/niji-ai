// On-device embeddings and semantic search (transformers.js, all-MiniLM-L6-v2).

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.web.min.js';
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import(TRANSFORMERS_URL).then(({ pipeline }) =>
      pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' }));
  }
  return extractorPromise;
}

/** Embeds a list of texts; returns arrays of 384 numbers (already normalised). */
export async function embed(texts, onProgress) {
  const extractor = await getExtractor();
  const vectors = [];
  const batch = 8;
  for (let i = 0; i < texts.length; i += batch) {
    const out = await extractor(texts.slice(i, i + batch), { pooling: 'mean', normalize: true });
    vectors.push(...out.tolist());
    onProgress?.(Math.min(i + batch, texts.length), texts.length);
  }
  return vectors;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const STOP = new Set('a an the of to in on for and or is are be by with as at from that this it can i my me what how when who which do does will would should may there their they we you your about any if not'.split(' '));
function keywords(text) {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) ?? []);
}

/**
 * Hybrid search: cosine similarity of embeddings plus a small keyword-overlap boost,
 * which helps with exact terms like amounts, dates and clause names.
 */
export async function search(query, chunks, k = 4) {
  if (!chunks.length) return [];
  const [q] = await embed([query]);
  const qWords = keywords(query);
  return chunks
    .map((c) => {
      const words = keywords(c.text);
      let overlap = 0;
      qWords.forEach((w) => { if (words.has(w)) overlap++; });
      const lexical = qWords.size ? overlap / qWords.size : 0;
      return { chunk: c, score: dot(q, c.vector) + 0.15 * lexical, similarity: dot(q, c.vector) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

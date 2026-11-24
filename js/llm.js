// Runs a small language model on the user's GPU with WebLLM (WebGPU).

const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/+esm';

export const MODELS = [
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 · 1.5B (best answers)', size: '≈1.6 GB' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 · 1B (faster)', size: '≈0.9 GB' },
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', label: 'SmolLM2 · 360M (phones, basic)', size: '≈0.4 GB' },
];

let webllm = null;
let engine = null;
let loadedModel = null;
let supportsF16 = true;

/** Checks for WebGPU. Returns { ok, reason }. */
export async function checkWebGPU() {
  if (!('gpu' in navigator)) return { ok: false, reason: 'This browser does not support WebGPU.' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'No compatible GPU was found.' };
    supportsF16 = adapter.features.has('shader-f16');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function lib() {
  if (!webllm) webllm = await import(WEBLLM_URL);
  return webllm;
}

/** GPUs without 16-bit float support need the q4f32 build of the same model. */
async function resolveModelId(id) {
  if (supportsF16) return id;
  const { prebuiltAppConfig } = await lib();
  const alt = id.replace('q4f16_1', 'q4f32_1');
  return prebuiltAppConfig.model_list.some((m) => m.model_id === alt) ? alt : id;
}

export async function isCached(id) {
  try {
    const { hasModelInCache } = await lib();
    return await hasModelInCache(await resolveModelId(id));
  } catch {
    return false;
  }
}

export async function loadModel(id, onProgress) {
  const { CreateMLCEngine } = await lib();
  const modelId = await resolveModelId(id);
  if (engine && loadedModel === modelId) return modelId;
  if (engine) await engine.unload();
  engine = await CreateMLCEngine(modelId, {
    initProgressCallback: (r) => onProgress?.(r.progress ?? 0, r.text ?? ''),
  });
  loadedModel = modelId;
  return modelId;
}

export function isReady() {
  return engine !== null;
}

/** Streams a reply. onToken(textSoFar) is called as tokens arrive. Returns { text, stats }. */
export async function generate(messages, onToken) {
  if (!engine) throw new Error('Model not loaded');
  const stream = await engine.chat.completions.create({
    messages,
    stream: true,
    temperature: 0.2,
    max_tokens: 600,
  });
  let text = '';
  for await (const part of stream) {
    const delta = part.choices?.[0]?.delta?.content;
    if (delta) {
      text += delta;
      onToken(text);
    }
  }
  let stats = '';
  try { stats = await engine.runtimeStatsText(); } catch { /* optional */ }
  return { text, stats };
}

export function stop() {
  engine?.interruptGenerate();
}

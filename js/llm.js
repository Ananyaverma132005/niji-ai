// Runs a small language model on the user's GPU with WebLLM (WebGPU).

const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/+esm';

export const MODELS = [
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 · 1.5B (best answers)', size: '≈0.9 GB' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 · 1B (faster)', size: '≈0.7 GB' },
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', label: 'SmolLM2 · 360M (phones, basic)', size: '≈0.3 GB' },
];

let webllm = null;
let engine = null;
let loadedModel = null;
let supportsF16 = true;

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
  const { CreateMLCEngine, deleteModelAllInfoInCache } = await lib();
  const modelId = await resolveModelId(id);
  if (engine && loadedModel === modelId) return modelId;
  if (engine) { await engine.unload(); engine = null; }

  // Ask the browser not to clear the model files when storage gets tight.
  try { await navigator.storage?.persist?.(); } catch { /* optional */ }

  // Keep only one model on disk: remove the files of the other models.
  for (const m of MODELS) {
    for (const other of [m.id, m.id.replace('q4f16_1', 'q4f32_1')]) {
      if (other === modelId) continue;
      try { await deleteModelAllInfoInCache(other); } catch { /* not cached */ }
    }
  }

  const options = { initProgressCallback: (r) => onProgress?.(r.progress ?? 0, r.text ?? '') };
  try {
    engine = await CreateMLCEngine(modelId, options);
  } catch (e) {
    if (!/cache|quota|storage/i.test(String(e?.message))) throw e;
    // A partial or evicted download can break the cache: clear it and try once more.
    onProgress?.(0, 'Storage problem, clearing the partial download and retrying…');
    try { await deleteModelAllInfoInCache(modelId); } catch { /* ignore */ }
    try {
      engine = await CreateMLCEngine(modelId, options);
    } catch (e2) {
      if (/cache|quota|storage/i.test(String(e2?.message))) {
        throw new Error('your browser doesn\'t have enough free storage for this model. ' +
          'Try a smaller model, free up disk space, or use a normal (not private) window.');
      }
      throw e2;
    }
  }
  loadedModel = modelId;
  return modelId;
}

export function isReady() {
  return engine !== null;
}

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

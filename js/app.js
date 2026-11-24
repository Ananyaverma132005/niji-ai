import { readFile, chunkPages } from './files.js';
import { embed, search } from './rag.js';
import { MODELS, checkWebGPU, isCached, loadModel, isReady, generate, stop } from './llm.js';
import { startMonitor, beginChat, snapshot, formatBytes } from './privacy.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const state = { docs: [], history: [], busy: false, gpu: false };

const SUGGESTIONS = [
  'How much is the security deposit, and when is it returned?',
  'What happens if I leave before the lock-in period ends?',
  'Who pays for repairs and maintenance?',
  'Can I keep pets in the flat?',
];

const SYSTEM_PROMPT = `You are Niji, a private assistant that runs entirely on the user's device.
Answer the question using only the numbered context passages from the user's documents.
After each fact, add the number of the passage it came from in square brackets.
Example: "The monthly rent is ₹18,000 [2], due by the 5th of each month [2]."
Be concise and specific: quote amounts, dates and conditions exactly.
If the passages do not contain the answer, say you couldn't find it in the documents.`;

async function init() {
  try { performance.setResourceTimingBufferSize(2000); } catch { /* ignore */ }
  startMonitor(renderPrivacy);

  MODELS.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.label} · ${m.size}`;
    $('modelSelect').appendChild(opt);
  });

  SUGGESTIONS.forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = q;
    b.onclick = () => ask(q);
    $('suggestions').appendChild(b);
  });

  bindEvents();

  state.docs = await store.loadDocs();
  renderDocs();

  // Load the search model now, so asking a question never needs the network.
  embed(['warm up']).catch((e) => console.warn('Search model not loaded yet:', e));

  const gpu = await checkWebGPU();
  state.gpu = gpu.ok;
  if (gpu.ok) {
    setChip('gpuChip', 'WebGPU ready', 'ok');
    updateCacheHint();
  } else {
    setChip('gpuChip', 'No WebGPU', 'bad');
    $('loadModelBtn').disabled = true;
    showBanner(`${gpu.reason} The AI model needs WebGPU (Chrome or Edge on desktop, or recent Chrome on Android). ` +
      'You can still add documents: Niji will show the most relevant passages for your questions.');
  }
}

function bindEvents() {
  $('loadModelBtn').onclick = onLoadModel;
  $('modelSelect').onchange = updateCacheHint;
  $('fileInput').onchange = (e) => addFiles([...e.target.files]);
  $('sampleBtn').onclick = addSample;
  $('clearDocsBtn').onclick = async () => {
    await store.clearDocs();
    state.docs = [];
    renderDocs();
  };
  $('menuBtn').onclick = () => $('sidebar').classList.toggle('open');
  $('stopBtn').onclick = () => stop();

  const dz = $('dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    addFiles([...e.dataTransfer.files]);
  });

  const input = $('input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').onsubmit = (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    input.style.height = 'auto';
    ask(q);
  };
}

async function updateCacheHint() {
  if (!state.gpu) return;
  const cached = await isCached($('modelSelect').value);
  $('modelHint').textContent = cached
    ? 'Already downloaded: loads from this device in a few seconds.'
    : 'Downloads once, then loads from your browser\'s cache.';
}

async function onLoadModel() {
  const id = $('modelSelect').value;
  const btn = $('loadModelBtn');
  btn.disabled = true;
  $('modelSelect').disabled = true;
  $('modelProgress').hidden = false;
  setChip('modelChip', 'Loading model…', 'warn');
  try {
    const loadedId = await loadModel(id, (p, text) => {
      $('modelProgressBar').style.width = `${Math.round(p * 100)}%`;
      $('modelProgressText').textContent = text;
    });
    const label = MODELS.find((m) => m.id === id)?.label.split(' (')[0] ?? loadedId;
    setChip('modelChip', `${label} running on your GPU`, 'ok');
    $('modelProgressText').textContent = 'Ready. Everything now runs offline.';
    btn.textContent = 'Model loaded';
  } catch (e) {
    console.error(e);
    setChip('modelChip', 'Model failed to load', 'bad');
    $('modelProgressText').textContent = `Could not load the model: ${e.message}`;
    btn.disabled = false;
  } finally {
    $('modelSelect').disabled = false;
  }
}

async function addFiles(files) {
  for (const file of files) {
    try {
      showIndexProgress(0, `Reading ${file.name}…`);
      const pages = await readFile(file);
      await indexDocument(file.name, pages);
    } catch (e) {
      console.error(e);
      showIndexProgress(0, `Couldn't read ${file.name}: ${e.message}`);
      return;
    }
  }
  $('fileInput').value = '';
}

async function addSample() {
  if (state.docs.some((d) => d.name === 'sample-rental-agreement.md')) return;
  try {
    const text = await (await fetch('samples/sample-rental-agreement.md')).text();
    await indexDocument('sample-rental-agreement.md', [{ page: null, text }]);
  } catch (e) {
    console.error(e);
    showIndexProgress(0, `Couldn't add the sample: ${e.message}`);
  }
}

async function indexDocument(name, pages) {
  const chunks = chunkPages(pages, name);
  if (!chunks.length) throw new Error('no readable text found');
  showIndexProgress(0, `Loading the on-device search model…`);
  const vectors = await embed(chunks.map((c) => c.text), (done, total) =>
    showIndexProgress(done / total, `Indexing ${name}: ${done}/${total} passages`));
  const doc = {
    id: `${name}-${Date.now()}`,
    name,
    pages: pages.length,
    chunks: chunks.map((c, i) => ({ ...c, vector: vectors[i] })),
  };
  state.docs.push(doc);
  await store.saveDoc(doc);
  renderDocs();
  showIndexProgress(1, `Added ${name} (${chunks.length} passages)`);
  setTimeout(() => { $('indexProgress').hidden = true; }, 2500);
}

function showIndexProgress(p, text) {
  $('indexProgress').hidden = false;
  $('indexProgressBar').style.width = `${Math.round(p * 100)}%`;
  $('indexProgressText').textContent = text;
}

function renderDocs() {
  const list = $('docList');
  list.innerHTML = '';
  state.docs.forEach((d) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>📄</span><span class="name"></span><span class="meta">${d.chunks.length} passages</span>
      <button aria-label="Remove">✕</button>`;
    li.querySelector('.name').textContent = d.name;
    li.querySelector('button').onclick = async () => {
      state.docs = state.docs.filter((x) => x.id !== d.id);
      await store.deleteDoc(d.id);
      renderDocs();
    };
    list.appendChild(li);
  });
  $('clearDocsBtn').hidden = state.docs.length === 0;
  $('input').placeholder = state.docs.length ? 'Ask about your documents…' : 'Add a document first, or try the sample…';
}

async function ask(question) {
  if (state.busy) return;
  $('welcome')?.remove();
  addMessage('user', escapeHtml(question));

  if (!state.docs.length) {
    addMessage('bot', '<p>Add a document first (or click <b>Try a sample</b> in the sidebar), then ask your question.</p>');
    return;
  }

  state.busy = true;
  setBusy(true);
  const endChat = beginChat();
  const bubble = addMessage('bot', '<p class="cursor"></p>');

  try {
    const allChunks = state.docs.flatMap((d) => d.chunks);
    const hits = await search(question, allChunks, 4);

    if (!isReady()) {
      bubble.innerHTML = `<p>${state.gpu
        ? 'Load a model in the sidebar to get a written answer. Meanwhile, here are the most relevant passages:'
        : 'Here are the most relevant passages from your documents:'}</p>`;
      bubble.appendChild(renderSources(hits, true));
      return;
    }

    const context = hits.map((h, i) => `[${i + 1}] (${label(h.chunk)})\n${h.chunk.text}`).join('\n\n');
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...state.history.slice(-4),
      { role: 'user', content: `Context passages:\n\n${context}\n\nQuestion: ${question}` },
    ];
    const started = performance.now();
    const { text, stats } = await generate(messages, (soFar) => {
      bubble.innerHTML = renderMarkdown(soFar, hits.length) + '<span class="cursor"></span>';
      scrollDown();
    });
    const answer = /\[\d+\]/.test(text) ? text : addCitations(text, hits);
    bubble.innerHTML = renderMarkdown(answer || '(no answer)', hits.length);
    bubble.appendChild(renderSources(hits, false));
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const speed = stats.match(/decod\w*:\s*([\d.]+)/i);
    const tps = speed ? Math.round(+speed[1]) : null;
    const meta = document.createElement('div');
    meta.className = 'meta-line';
    meta.textContent = `Answered on your device in ${seconds}s${tps ? ` · ${tps} tokens/s` : ''} · 0 bytes sent`;
    bubble.appendChild(meta);
    if (tps) setChip('speedChip', `⚡ ${tps} tokens/s on your GPU`, 'ok');
    wireCitations(bubble);

    state.history.push({ role: 'user', content: question }, { role: 'assistant', content: text });
  } catch (e) {
    console.error(e);
    bubble.innerHTML = `<p>Something went wrong: ${escapeHtml(e.message)}</p>`;
  } finally {
    endChat();
    state.busy = false;
    setBusy(false);
    scrollDown();
  }
}

function addCitations(text, hits) {
  const words = (s) => new Set(s.toLowerCase().match(/[a-z0-9₹,]+/g)?.filter((w) => w.length > 3) ?? []);
  const passages = hits.map((h) => words(h.chunk.text));
  return text.replace(/[^.!?\n]+[.!?]?/g, (sentence) => {
    const sw = words(sentence);
    if (sw.size < 3) return sentence;
    let best = -1, bestScore = 0;
    passages.forEach((pw, i) => {
      let overlap = 0;
      sw.forEach((w) => { if (pw.has(w)) overlap++; });
      const score = overlap / sw.size;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best < 0 || bestScore < 0.5) return sentence;
    const trimmed = sentence.replace(/\s+$/, '');
    const end = trimmed.match(/[.!?]$/) ? trimmed.slice(-1) : '';
    const body = end ? trimmed.slice(0, -1) : trimmed;
    return `${body} [${best + 1}]${end}${sentence.slice(trimmed.length)}`;
  });
}

function label(chunk) {
  return chunk.page ? `${chunk.doc}, page ${chunk.page}` : chunk.doc;
}

function renderSources(hits, open) {
  const box = document.createElement('details');
  box.className = 'sources';
  box.open = open;
  box.innerHTML = `<summary>Sources (${hits.length})</summary>`;
  hits.forEach((h, i) => {
    const div = document.createElement('div');
    div.className = 'source';
    div.dataset.n = String(i + 1);
    div.innerHTML = `<b>[${i + 1}] ${escapeHtml(label(h.chunk))} · match ${(h.similarity * 100).toFixed(0)}%</b>`;
    div.appendChild(document.createTextNode(h.chunk.text));
    box.appendChild(div);
  });
  return box;
}

function wireCitations(bubble) {
  bubble.querySelectorAll('.cite').forEach((c) => {
    c.onclick = () => {
      const details = bubble.querySelector('.sources');
      details.open = true;
      const target = details.querySelector(`.source[data-n="${c.dataset.n}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('flash');
        void target.offsetWidth;
        target.classList.add('flash');
      }
    };
  });
}

function addMessage(role, html) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="avatar">${role === 'user' ? 'You' : 'N'}</div><div class="bubble">${html}</div>`;
  if (role === 'user') wrap.querySelector('.avatar').textContent = '🙂';
  $('messages').appendChild(wrap);
  scrollDown();
  return wrap.querySelector('.bubble');
}

function setBusy(busy) {
  $('sendBtn').disabled = busy;
  $('stopBtn').hidden = !busy || !isReady();
}

function scrollDown() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

function setChip(id, text, cls) {
  const chip = $(id);
  chip.hidden = false;
  chip.textContent = text;
  chip.className = `chip ${cls || ''}`;
}

function showBanner(text) {
  $('gpuBanner').hidden = false;
  $('gpuBanner').textContent = text;
}

function renderPrivacy() {
  const snap = snapshot();
  $('chatRequests').textContent = snap.chatRequests;
  $('netLog').innerHTML = snap.hosts.map((h) =>
    `<li><span class="host">${escapeHtml(h.host)}</span><span class="what">${h.kind} · ${h.count} · ${formatBytes(h.bytes)}</span></li>`,
  ).join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMarkdown(md, maxCite) {
  const inline = (s) => escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(\d+)\]/g, (m, n) => (+n >= 1 && +n <= maxCite
      ? `<button type="button" class="cite" data-n="${n}">${n}</button>` : m));
  const out = [];
  let list = null;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)/);
    const num = line.match(/^\d+[.)]\s+(.*)/);
    if (bullet || num) {
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { if (list) out.push(`</${list.tag}>`); list = { tag }; out.push(`<${tag}>`); }
      out.push(`<li>${inline((bullet || num)[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list.tag}>`); list = null; }
    if (line) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list.tag}>`);
  return out.join('');
}

init();

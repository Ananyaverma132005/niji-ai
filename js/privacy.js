// Lists every network request the page makes, using the browser's Performance API.

const KINDS = [
  [/huggingface\.co|hf\.co|cdn-lfs/, 'model files'],
  [/raw\.githubusercontent\.com/, 'GPU runtime'],
  [/cdn\.jsdelivr\.net/, 'app libraries'],
  [/fonts\.(googleapis|gstatic)\.com/, 'fonts'],
];

const hosts = new Map();      // host -> { count, bytes, kind }
let chatWindows = [];         // [start, end] times while answering questions
let chatRequests = 0;
let onChange = () => {};

function kindOf(url) {
  if (url.startsWith(location.origin)) return 'this app';
  for (const [re, kind] of KINDS) if (re.test(url)) return kind;
  return 'other';
}

function record(entry) {
  if (!entry.name.startsWith('http')) return;
  const url = new URL(entry.name);
  const key = url.host;
  const item = hosts.get(key) || { count: 0, bytes: 0, kind: kindOf(entry.name) };
  item.count++;
  item.bytes += entry.transferSize || entry.encodedBodySize || 0;
  hosts.set(key, item);
  if (chatWindows.some(([s, e]) => entry.startTime >= s && entry.startTime <= (e ?? Infinity))) chatRequests++;
  onChange();
}

export function startMonitor(callback) {
  onChange = callback;
  performance.getEntriesByType('resource').forEach(record);
  try {
    new PerformanceObserver((list) => list.getEntries().forEach(record))
      .observe({ type: 'resource', buffered: false });
  } catch { /* older browsers */ }
}

/** Marks the start of answering a question; call the returned function when done. */
export function beginChat() {
  const win = [performance.now(), null];
  chatWindows.push(win);
  return () => { win[1] = performance.now(); onChange(); };
}

export function snapshot() {
  return {
    chatRequests,
    hosts: [...hosts.entries()]
      .map(([host, v]) => ({ host, ...v }))
      .sort((a, b) => b.bytes - a.bytes),
  };
}

export function formatBytes(n) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${units[i]}`;
}

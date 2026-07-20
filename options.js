const STORAGE_KEY_API_KEY = 'opencode_go_api_key';
const STORAGE_KEY_CHATS = 'opencode_go_chats';
const STORAGE_KEY_MODEL = 'opencode_go_model';
const STORAGE_KEY_MODELS_CACHE = 'opencode_go_models_cache_v2';
const STORAGE_KEY_THEME = 'opencode_go_theme';
const STORAGE_KEY_SHOW_THINKING = 'opencode_go_show_thinking';
const STORAGE_KEY_CLICK_AWAY = 'opencode_go_click_away';
const STORAGE_KEY_USAGE_DAILY = 'opencode_go_usage_daily';
// Mirrored into localStorage so theme-init.js can read it synchronously and
// avoid a flash of the wrong theme on the next load.
const LS_KEY_THEME = 'oc_theme';
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);

const dom = {
  apiKey: $('#api-key'),
  apiStatus: $('#api-status'),
  saveKey: $('#save-key'),
  defaultModel: $('#default-model'),
  saveModel: $('#save-model'),
  chatsContainer: $('#chats-container'),
  chatCount: $('#chat-count'),
  clearAll: $('#clear-all'),
  themeSelect: $('#theme-select'),
  showThinking: $('#show-thinking'),
  clickAway: $('#click-away'),
  tabDaily: $('#tab-daily'),
  tabCumulative: $('#tab-cumulative'),
  usageTotals: $('#usage-totals'),
  usageChart: $('#usage-chart'),
  chartLabels: $('#chart-labels'),
  usageModels: $('#usage-models'),
  usageNote: $('#usage-note'),
};

// ── Usage ──
const USAGE_DAYS = 30;
let usageDaily = {};
let usageMode = 'daily'; // 'daily' | 'cumulative'

function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

// A continuous run of days, so gaps read as zero instead of being skipped and
// silently compressing the time axis.
function usageSeries() {
  const out = [];
  const today = new Date();
  for (let i = USAGE_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = dayKey(d);
    const models = usageDaily[key] || {};
    let tokens = 0;
    let cost = 0;
    let requests = 0;
    for (const m of Object.values(models)) {
      tokens += m.tokens || 0;
      cost += m.cost || 0;
      requests += m.requests || 0;
    }
    out.push({ key, date: d, tokens, cost, requests });
  }
  return out;
}

function renderUsage() {
  const series = usageSeries();
  const totals = series.reduce(
    (a, d) => ({ tokens: a.tokens + d.tokens, cost: a.cost + d.cost, requests: a.requests + d.requests }),
    { tokens: 0, cost: 0, requests: 0 }
  );

  // Totals
  const stats = [
    ['Tokens', formatTokens(totals.tokens)],
    ['Messages', String(totals.requests)],
    ['Active days', String(series.filter(d => d.tokens > 0).length)],
  ];
  // Only shown when the API actually reports a charge; on flat-rate Go plans
  // it reports "0", and a "$0.00" box would imply metered billing.
  if (totals.cost > 0) stats.push(['Cost', '$' + totals.cost.toFixed(2)]);

  dom.usageTotals.innerHTML = stats.map(([label, value]) => `
    <div>
      <div class="usage-stat-label">${label}</div>
      <div class="usage-stat-value">${value}</div>
    </div>`).join('');

  renderChart(series);
  renderModels();

  dom.usageNote.textContent = totals.tokens === 0
    ? `No usage recorded yet. Sends are tracked from now on, and kept for ${USAGE_DAYS === 30 ? '90' : '90'} days.`
    : `Last ${USAGE_DAYS} days. History is stored on this device only.`;
}

function renderChart(series) {
  const W = 600;
  const H = 150;
  const values = usageMode === 'cumulative'
    ? series.reduce((acc, d) => { acc.push((acc.length ? acc[acc.length - 1] : 0) + d.tokens); return acc; }, [])
    : series.map(d => d.tokens);

  const max = Math.max(...values, 1);
  const svg = dom.usageChart;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  if (usageMode === 'daily') {
    const slot = W / series.length;
    const bw = Math.max(2, slot * 0.62);
    svg.innerHTML =
      values.map((v, i) => {
        const h = v === 0 ? 0 : Math.max(2, (v / max) * (H - 8));
        const x = i * slot + (slot - bw) / 2;
        return `<rect class="chart-bar" x="${x.toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${series[i].key}: ${series[i].tokens.toLocaleString()} tokens</title></rect>`;
      }).join('') +
      `<line class="chart-axis" x1="0" y1="${H}" x2="${W}" y2="${H}"/>`;
  } else {
    const step = series.length > 1 ? W / (series.length - 1) : W;
    const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 8)).toFixed(1)}`);
    svg.innerHTML =
      `<polygon class="chart-area" points="0,${H} ${pts.join(' ')} ${W},${H}"/>` +
      `<polyline class="chart-line" points="${pts.join(' ')}"/>` +
      `<line class="chart-axis" x1="0" y1="${H}" x2="${W}" y2="${H}"/>`;
  }

  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  dom.chartLabels.innerHTML =
    `<span>${fmt(series[0].date)}</span><span>${fmt(series[series.length - 1].date)}</span>`;
}

function renderModels() {
  // Aggregated across the whole retained window, not just the charted days.
  const byModel = {};
  for (const models of Object.values(usageDaily)) {
    for (const [id, m] of Object.entries(models)) {
      const b = byModel[id] || (byModel[id] = { tokens: 0, cost: 0, requests: 0 });
      b.tokens += m.tokens || 0;
      b.cost += m.cost || 0;
      b.requests += m.requests || 0;
    }
  }

  const rows = Object.entries(byModel).sort((a, b) => b[1].tokens - a[1].tokens);
  if (!rows.length) {
    dom.usageModels.innerHTML = '';
    return;
  }

  const max = rows[0][1].tokens || 1;
  const anyCost = rows.some(([, m]) => m.cost > 0);

  dom.usageModels.innerHTML =
    '<div class="usage-stat-label" style="margin-bottom:6px;">By model</div>' +
    rows.map(([id, m]) => `
      <div class="model-row">
        <span class="model-name">${escapeHtml(modelIdToDisplayName(id))}</span>
        <span class="model-bar"><span style="width:${((m.tokens / max) * 100).toFixed(1)}%"></span></span>
        <span class="model-tokens">${formatTokens(m.tokens)} tokens${anyCost ? ' · $' + m.cost.toFixed(2) : ''}</span>
      </div>`).join('');
}

// Derived, not persisted: a chat only records its last-updated day, so this
// attributes all of its tokens to that day. Approximate by nature, and it is
// replaced as real per-request history accumulates.
function backfillFromChats(chats) {
  const daily = {};
  for (const chat of chats) {
    if (!chat.tokens || !chat.updatedAt) continue;
    const key = dayKey(chat.updatedAt);
    const model = chat.model || 'unknown';
    const day = daily[key] || (daily[key] = {});
    const b = day[model] || (day[model] = { tokens: 0, reasoning: 0, cost: 0, requests: 0 });
    b.tokens += chat.tokens || 0;
    b.cost += chat.cost || 0;
    b.requests += 1;
  }
  return daily;
}

function selectUsageTab(mode) {
  usageMode = mode;
  dom.tabDaily.setAttribute('aria-selected', String(mode === 'daily'));
  dom.tabCumulative.setAttribute('aria-selected', String(mode === 'cumulative'));
  renderUsage();
}

// ── Appearance ──
function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function applyTheme(pref) {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
  try {
    localStorage.setItem(LS_KEY_THEME, pref);
  } catch (e) {
    // Non-fatal: only costs us the no-flash fast path next load.
  }
}

dom.themeSelect.addEventListener('change', async () => {
  const pref = dom.themeSelect.value;
  applyTheme(pref);
  // popup.js watches chrome.storage, so any open chat window retheme itself.
  await chrome.storage.local.set({ [STORAGE_KEY_THEME]: pref });
  toast('Theme updated');
});

// Only follow the OS while the preference is "system".
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (dom.themeSelect.value === 'system') applyTheme('system');
  });
}

dom.showThinking.addEventListener('change', async () => {
  const on = dom.showThinking.checked;
  await chrome.storage.local.set({ [STORAGE_KEY_SHOW_THINKING]: on });
  toast(on ? 'Reasoning will be shown' : 'Reasoning hidden');
});

dom.clickAway.addEventListener('change', async () => {
  const on = dom.clickAway.checked;
  // float.js watches chrome.storage, so open windows pick this up immediately.
  await chrome.storage.local.set({ [STORAGE_KEY_CLICK_AWAY]: on });
  toast(on ? 'Clicking away will minimize' : 'Clicking away leaves the window open');
});

// ── ID-to-name helper ──
function modelIdToDisplayName(id) {
  return id
    .replace(/^glm-/, 'GLM-')
    .replace(/^deepseek-/, 'DeepSeek ')
    .replace(/^qwen/, 'Qwen')
    .replace(/^kimi-/, 'Kimi ')
    .replace(/^grok-/, 'Grok ')
    .replace(/^minimax-/, 'MiniMax ')
    .replace(/^mimo-/, 'MiMo ')
    .replace(/^hy3-/, 'HY3 ')
    .replace(/^hunyuan-?/, 'Hunyuan ')
    .replace(/^tencent-?/, 'Tencent ')
    .replace(/v4-pro/i, 'V4 Pro').replace(/v4-flash/i, 'V4 Flash')
    .replace(/v2.5-pro/i, 'V2.5 Pro').replace(/v2.5/i, 'V2.5')
    .replace(/v2-pro/i, 'V2 Pro').replace(/v2-omni/i, 'V2 Omni')
    .replace(/3.7-max/, '3.7 Max').replace(/3.7-plus/, '3.7 Plus')
    .replace(/3.6-plus/, '3.6 Plus').replace(/3.5-plus/, '3.5 Plus')
    .replace(/k2.7-code/, 'K2.7 Code').replace(/k2.6/, 'K2.6').replace(/k2.5/, 'K2.5')
    .replace(/m2.7/, 'M2.7').replace(/m2.5/, 'M2.5').replace(/m3$/, 'M3')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function fetchModels(apiKey) {
  try {
    const res = await fetch('https://opencode.ai/zen/go/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return (body.data || []).map(m => ({ id: m.id, name: modelIdToDisplayName(m.id) }));
  } catch {
    return [];
  }
}

async function loadModelOptions(apiKey) {
  const cached = await chrome.storage.local.get([STORAGE_KEY_MODELS_CACHE]);
  const cache = cached[STORAGE_KEY_MODELS_CACHE];
  let models = [];

  if (cache && cache.models && (Date.now() - cache.ts) < MODEL_CACHE_TTL) {
    models = cache.models;
  } else if (apiKey) {
    models = await fetchModels(apiKey);
    if (models.length > 0) {
      await chrome.storage.local.set({ [STORAGE_KEY_MODELS_CACHE]: { models, ts: Date.now() } });
    }
  }

  populateModelSelect(models);
}

function populateModelSelect(models) {
  const currentValue = dom.defaultModel.value;
  dom.defaultModel.innerHTML = '';

  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = 'glm-5.2';
    opt.textContent = 'GLM-5.2';
    dom.defaultModel.appendChild(opt);
    return;
  }

  models.sort((a, b) => a.name.localeCompare(b.name));

  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    if (m.id === currentValue) opt.selected = true;
    dom.defaultModel.appendChild(opt);
  }
}

// ── Init ──
async function init() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEY_API_KEY,
    STORAGE_KEY_CHATS,
    STORAGE_KEY_MODEL,
    STORAGE_KEY_THEME,
    STORAGE_KEY_SHOW_THINKING,
    STORAGE_KEY_CLICK_AWAY,
    STORAGE_KEY_USAGE_DAILY,
  ]);

  usageDaily = stored[STORAGE_KEY_USAGE_DAILY] || {};
  // Nothing recorded yet, but past chats carry a timestamp, a model and a
  // token count — enough to seed the history rather than starting blank.
  if (!Object.keys(usageDaily).length) {
    usageDaily = backfillFromChats(stored[STORAGE_KEY_CHATS] || []);
  }
  dom.tabDaily.addEventListener('click', () => selectUsageTab('daily'));
  dom.tabCumulative.addEventListener('click', () => selectUsageTab('cumulative'));
  renderUsage();

  const themePref = stored[STORAGE_KEY_THEME] || 'system';
  dom.themeSelect.value = themePref;
  applyTheme(themePref);
  dom.showThinking.checked = stored[STORAGE_KEY_SHOW_THINKING] === true;
  // Defaults on: an absent value means never chosen, not "off".
  dom.clickAway.checked = stored[STORAGE_KEY_CLICK_AWAY] !== false;

  const apiKey = stored[STORAGE_KEY_API_KEY] || '';

  if (apiKey) {
    dom.apiKey.value = apiKey;
    setStatus('connected');
  } else {
    setStatus('disconnected');
  }

  await loadModelOptions(apiKey);

  if (stored[STORAGE_KEY_MODEL]) {
    dom.defaultModel.value = stored[STORAGE_KEY_MODEL];
  }

  renderChats(stored[STORAGE_KEY_CHATS] || []);
}

function setStatus(status) {
  if (status === 'connected') {
    dom.apiStatus.className = 'status connected';
    dom.apiStatus.innerHTML = '<span class="status-dot"></span> Connected';
  } else {
    dom.apiStatus.className = 'status disconnected';
    dom.apiStatus.innerHTML = '<span class="status-dot"></span> Not connected';
  }
}

// ── Save API Key ──
dom.saveKey.addEventListener('click', async () => {
  const key = dom.apiKey.value.trim();
  if (!key) {
    toast('Please enter an API key', true);
    return;
  }

  dom.saveKey.disabled = true;
  dom.saveKey.textContent = 'Verifying...';

  try {
    const models = await fetchModels(key);

    if (!models || models.length === 0) throw new Error('Invalid API key');

    await chrome.storage.local.set({ [STORAGE_KEY_API_KEY]: key });
    await chrome.storage.local.set({
      [STORAGE_KEY_MODELS_CACHE]: { models, ts: Date.now() },
    });
    setStatus('connected');
    populateModelSelect(models);
    toast('API key saved and verified');
  } catch (err) {
    toast('Invalid API key \u2014 please check and try again', true);
  } finally {
    dom.saveKey.disabled = false;
    dom.saveKey.textContent = 'Save';
  }
});

// ── Save Model ──
dom.saveModel.addEventListener('click', async () => {
  const model = dom.defaultModel.value;
  await chrome.storage.local.set({ [STORAGE_KEY_MODEL]: model });
  toast('Default model saved');
});

// ── Chat History ──
function renderChats(chats) {
  dom.chatCount.textContent = chats.length;

  if (chats.length === 0) {
    dom.chatsContainer.innerHTML = '<div class="empty-state">No chat history yet</div>';
    dom.clearAll.disabled = true;
    return;
  }

  dom.clearAll.disabled = false;
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);

  dom.chatsContainer.innerHTML = sorted.map(chat => `
    <div class="chat-item">
      <div class="chat-item-info">
        <div class="chat-item-title">${escapeHtml(chat.title || 'Untitled')}</div>
        <div class="chat-item-meta">
          ${chat.model || 'Unknown'} &middot; ${formatDate(chat.updatedAt)}
        </div>
      </div>
      <button class="chat-item-delete" data-id="${chat.id}" title="Delete chat">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
    </div>
  `).join('');

  // Delete handlers
  dom.chatsContainer.querySelectorAll('.chat-item-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const stored = await chrome.storage.local.get([STORAGE_KEY_CHATS]);
      const chats = (stored[STORAGE_KEY_CHATS] || []).filter(c => c.id !== id);
      await chrome.storage.local.set({ [STORAGE_KEY_CHATS]: chats });
      renderChats(chats);
      toast('Chat deleted');
    });
  });
}

// ── Clear All ──
dom.clearAll.addEventListener('click', async () => {
  if (!confirm('Delete all chat history? This cannot be undone.')) return;
  await chrome.storage.local.set({ [STORAGE_KEY_CHATS]: [] });
  renderChats([]);
  toast('All chat history cleared');
});

// ── Helpers ──
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

function toast(message, isError = false) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const el = document.createElement('div');
  // Themed via CSS rather than inline styles, so the error variant follows
  // light mode instead of staying pinned to the dark palette.
  el.className = isError ? 'toast error' : 'toast';
  el.textContent = message;
  document.body.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.2s ease';
    setTimeout(() => el.remove(), 200);
  }, 2500);
}

init();

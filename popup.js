const API_BASE = 'https://opencode.ai/zen/go/v1';
const STORAGE_KEY_API_KEY = 'opencode_go_api_key';
const STORAGE_KEY_CHATS = 'opencode_go_chats';
const STORAGE_KEY_MODEL = 'opencode_go_model';
const STORAGE_KEY_MODELS_CACHE = 'opencode_go_models_cache_v2';
const STORAGE_KEY_USAGE = 'opencode_go_usage';
// Per-day, per-model usage: { 'YYYY-MM-DD': { modelId: {tokens, reasoning, cost, requests} } }
const STORAGE_KEY_USAGE_DAILY = 'opencode_go_usage_daily';
const USAGE_RETENTION_DAYS = 90;
const STORAGE_KEY_REVIEW = 'opencode_go_review';
// Shown only once the extension has clearly been useful, never again after any
// interaction with it — including "not now".
const REVIEW_MIN_CHATS = 3;
const REVIEW_MIN_MESSAGES = 10;
// The published listing. Hardcoded rather than built from chrome.runtime.id so
// an unpacked dev build still points at the real review page.
const REVIEW_URL =
  'https://chromewebstore.google.com/detail/go-chat-ui-%E2%80%94-ai-chat-for/edeahmicmaaphonflnfmjfoingkkmgnb/reviews';
// The "not really" path. Asking an unhappy user for a public review wastes the
// one prompt we get; this routes them somewhere the problem can be fixed.
const FEEDBACK_URL = 'https://www.bambamhq.com/contact.html?app=gochatui';
const STORAGE_KEY_THEME = 'opencode_go_theme';
const STORAGE_KEY_SHOW_THINKING = 'opencode_go_show_thinking';
// Mirrored into localStorage under this key so theme-init.js can read the
// preference synchronously in <head>. chrome.storage alone would flash.
const LS_KEY_THEME = 'oc_theme';
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const STALE_CHAT_MS = 60 * 60 * 1000; // reopen the last chat only if used within the hour

// Brand domain mapping for favicons (static infrastructure, not model data)
const BRAND_DOMAINS = {
  grok: 'x.ai',
  glm: 'z.ai',
  kimi: 'moonshot.ai',
  deepseek: 'deepseek.com',
  qwen: 'qwen.ai',
  minimax: 'minimaxi.com',
  mimo: 'minimaxi.com',
  hy3: 'tencent.com',
  hunyuan: 'tencent.com',
  tencent: 'tencent.com',
};

function brandDomain(modelId) {
  for (const [prefix, domain] of Object.entries(BRAND_DOMAINS)) {
    if (modelId.startsWith(prefix) && domain) return domain;
  }
  return null;
}

function brandFavicon(modelId, size = 32) {
  const domain = brandDomain(modelId);
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}` : '';
}

// ── State ──
let state = {
  apiKey: '',
  currentChat: null,
  messages: [],
  chats: [],
  selectedModel: 'glm-5.2',
  models: [],
  isStreaming: false,
  usage: { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 },
  chatTokens: 0, // tokens used by the chat currently open (all-time total lives in usage)
  chatCost: 0,   // cost the API reports for this chat; some models report "0"
  reviewDone: false,    // asked once and answered either way; never ask again
  theme: 'system',      // 'system' | 'light' | 'dark'
  showThinking: false,  // off by default: most people want the answer, not the transcript
};

// ── Theme ──
// theme-init.js has already applied a theme before first paint. These helpers
// keep it in sync afterwards, when the setting changes or the OS flips.
const osPrefersLight = () =>
  window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return osPrefersLight() ? 'light' : 'dark';
}

function applyTheme(pref) {
  state.theme = pref;
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
  try {
    localStorage.setItem(LS_KEY_THEME, pref);
  } catch (e) {
    // Non-fatal: we just lose the no-flash fast path on the next open.
  }
  // The floating window chrome lives in the content script's shadow DOM and
  // cannot see this document's tokens, so it is told separately.
  notifyHostTheme(resolveTheme(pref));
}

function notifyHostTheme(resolved) {
  try {
    window.parent?.postMessage({ oc: 'theme', theme: resolved }, '*');
  } catch (e) {
    // Not embedded (e.g. opened directly as a tab) — nothing to notify.
  }
}

// Only meaningful while the preference is "system"; an explicit choice wins.
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (state.theme === 'system') applyTheme('system');
  });
}

// ── DOM Elements ──
const $ = (sel) => document.querySelector(sel);

const dom = {
  setup: $('#setup'),
  app: $('#app'),
  apiKeyInput: $('#api-key-input'),
  saveKeyBtn: $('#save-key-btn'),
  toggleKeyVis: $('#toggle-key-vis'),
  messages: $('#messages'),
  chatInput: $('#chat-input'),
  sendBtn: $('#send-btn'),
  newChatBtn: $('#new-chat-btn'),
  openSettings: $('#open-settings'),
  hintModel: $('#hint-model'),
  dropdown: $('#model-dropdown'),
  dropdownTrigger: $('#model-dropdown-trigger'),
  dropdownMenu: $('#model-dropdown-menu'),
  dropdownList: $('#model-dropdown-list'),
  modelSearch: $('#model-search'),
  currentModelName: $('#current-model-name'),
  currentModelFavicon: $('#current-model-favicon'),
  appHeader: $('#app-header'),
  winMin: $('#win-min'),
  winClose: $('#win-close'),
  sidebar: $('#sidebar'),
  sidebarToggle: $('#sidebar-toggle'),
  sidebarClose: $('#sidebar-close'),
  sidebarOverlay: $('#sidebar-overlay'),
  sidebarList: $('#sidebar-list'),
};

function modelDisplayName(modelId) {
  const m = state.models.find(m => m.id === modelId);
  return m ? m.name : modelIdToDisplayName(modelId);
}

function updateUsageDisplay() {
  const model = modelDisplayName(state.selectedModel);
  const chat = state.chatTokens || 0;
  const cost = state.chatCost || 0;

  if (chat <= 0) {
    dom.hintModel.textContent = model;
    return;
  }

  // Only surface cost when the API actually reports one — some models return
  // "0", and showing "$0.0000" there would be noise rather than information.
  dom.hintModel.textContent = cost > 0
    ? `${model} \u00b7 ${formatTokens(chat)} \u00b7 ${formatCost(cost)}`
    : `${model} \u00b7 ${formatTokens(chat)}`;
}

function formatCost(n) {
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(3);
  return '$' + n.toFixed(4);
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M tokens';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k tokens';
  return n === 1 ? '1 token' : n + ' tokens';
}

// ── Model Fetching ──
async function fetchModels(apiKey) {
  try {
    const res = await fetch(`${API_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = await res.json();
    const models = (body.data || []).map(m => ({
      id: m.id,
      name: modelIdToDisplayName(m.id),
    }));

    // Sort: put selected model first, then alphabetically
    models.sort((a, b) => {
      if (a.id === state.selectedModel) return -1;
      if (b.id === state.selectedModel) return 1;
      return a.name.localeCompare(b.name);
    });

    return models;
  } catch (err) {
    console.warn('Failed to fetch models:', err.message);
    return [];
  }
}

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
    .replace(/v4-pro/i, 'V4 Pro')
    .replace(/v4-flash/i, 'V4 Flash')
    .replace(/v2.5-pro/i, 'V2.5 Pro')
    .replace(/v2.5/i, 'V2.5')
    .replace(/v2-pro/i, 'V2 Pro')
    .replace(/v2-omni/i, 'V2 Omni')
    .replace(/3.7-max/, '3.7 Max')
    .replace(/3.7-plus/, '3.7 Plus')
    .replace(/3.6-plus/, '3.6 Plus')
    .replace(/3.5-plus/, '3.5 Plus')
    .replace(/k2.7-code/, 'K2.7 Code')
    .replace(/k2.6/, 'K2.6')
    .replace(/k2.5/, 'K2.5')
    .replace(/m2.7/, 'M2.7')
    .replace(/m2.5/, 'M2.5')
    .replace(/m3$/, 'M3')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function loadModels(apiKey) {
  const cached = await chrome.storage.local.get([STORAGE_KEY_MODELS_CACHE]);
  const cache = cached[STORAGE_KEY_MODELS_CACHE];

  if (cache && cache.models && cache.models.length > 0 && (Date.now() - cache.ts) < MODEL_CACHE_TTL) {
    state.models = cache.models;
  } else {
    state.models = await fetchModels(apiKey);
    if (state.models.length > 0) {
      await chrome.storage.local.set({
        [STORAGE_KEY_MODELS_CACHE]: { models: state.models, ts: Date.now() },
      });
    }
  }

  populateDropdown();
  updateSelectedModelUI();
}

// ── Dropdown ──
function populateDropdown(filter = '') {
  dom.dropdownList.innerHTML = '';

  const filtered = filter
    ? state.models.filter(m =>
        m.name.toLowerCase().includes(filter.toLowerCase()) ||
        m.id.toLowerCase().includes(filter.toLowerCase()) ||
        (m.provider && m.provider.toLowerCase().includes(filter.toLowerCase()))
      )
    : state.models;

  if (filtered.length === 0) {
    dom.dropdownList.innerHTML = '<div class="model-dropdown-empty">No models found</div>';
    return;
  }

  for (const m of filtered) {
    const opt = document.createElement('div');
    opt.className = 'model-dropdown-option';
    if (m.id === state.selectedModel) opt.classList.add('selected');
    const src = brandFavicon(m.id, 32);
    const iconHtml = src ? `<img class="model-favicon" src="${src}" alt="" width="18" height="18" onerror="this.remove()">` : '';
    opt.innerHTML = `${iconHtml}<span class="model-name">${m.name}</span>`;
    opt.addEventListener('click', () => selectModel(m.id));
    dom.dropdownList.appendChild(opt);
  }
}

function selectModel(modelId) {
  state.selectedModel = modelId;
  updateSelectedModelUI();
  closeDropdown();
  chrome.storage.local.set({ [STORAGE_KEY_MODEL]: modelId });
  dom.hintModel.textContent = modelDisplayName(modelId);
}

function updateSelectedModelUI() {
  dom.currentModelName.textContent = modelDisplayName(state.selectedModel);
  const src = brandFavicon(state.selectedModel, 16);
  if (src) {
    dom.currentModelFavicon.src = src;
    dom.currentModelFavicon.style.display = '';
  } else {
    dom.currentModelFavicon.removeAttribute('src');
    dom.currentModelFavicon.style.display = 'none';
  }
}

function openDropdown() {
  dom.dropdown.classList.add('open');
  dom.modelSearch.value = '';
  populateDropdown();
  dom.modelSearch.focus();
}

function closeDropdown() {
  dom.dropdown.classList.remove('open');
}

dom.dropdownTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  if (dom.dropdown.classList.contains('open')) {
    closeDropdown();
  } else {
    openDropdown();
  }
});

dom.modelSearch.addEventListener('input', () => {
  populateDropdown(dom.modelSearch.value);
});

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (!dom.dropdown.contains(e.target)) {
    closeDropdown();
  }
});

// Close on Escape
dom.modelSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDropdown();
    dom.dropdownTrigger.focus();
  }
});

// ── Sidebar ──
function openSidebar() {
  dom.sidebar.classList.remove('hidden');
  dom.sidebarOverlay.classList.remove('hidden');
  renderSidebarChats();
}

function closeSidebar() {
  dom.sidebar.classList.add('hidden');
  dom.sidebarOverlay.classList.add('hidden');
}

dom.sidebarToggle.addEventListener('click', () => {
  if (!dom.sidebar.classList.contains('hidden')) {
    closeSidebar();
  } else {
    openSidebar();
  }
});

dom.sidebarClose.addEventListener('click', closeSidebar);
dom.sidebarOverlay.addEventListener('click', closeSidebar);

function renderSidebarChats() {
  dom.sidebarList.innerHTML = '';

  if (state.chats.length === 0) {
    dom.sidebarList.innerHTML = '<div class="sidebar-empty">No chats yet</div>';
    return;
  }

  const sorted = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);

  for (const chat of sorted) {
    const el = document.createElement('div');
    el.className = 'sidebar-chat';
    if (state.currentChat?.id === chat.id) el.classList.add('active');

    const src = brandFavicon(chat.model || '', 24);
    const iconHtml = src ? `<img class="sidebar-chat-model-icon" src="${src}" alt="" width="14" height="14" onerror="this.remove()">` : '';

    el.innerHTML = `${iconHtml}
      <div class="sidebar-chat-info">
        <div class="sidebar-chat-title">${escapeHtml(chat.title || 'Untitled')}</div>
        <div class="sidebar-chat-meta">
          <span>${modelDisplayName(chat.model)}</span>
          <span>&middot;</span>
          <span>${formatTime(chat.updatedAt)}</span>
          ${chat.tokens ? `<span>&middot;</span><span>${formatTokens(chat.tokens)}</span>` : ''}
          ${chat.cost > 0 ? `<span>&middot;</span><span>${formatCost(chat.cost)}</span>` : ''}
        </div>
      </div>
    `;

    el.addEventListener('click', () => {
      loadChat(chat.id);
      closeSidebar();
      scrollToBottom();
    });

    dom.sidebarList.appendChild(el);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

// ── Initialization ──
async function init() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEY_API_KEY,
    STORAGE_KEY_CHATS,
    STORAGE_KEY_MODEL,
    STORAGE_KEY_USAGE,
    STORAGE_KEY_THEME,
    STORAGE_KEY_SHOW_THINKING,
    STORAGE_KEY_REVIEW,
  ]);

  state.apiKey = stored[STORAGE_KEY_API_KEY] || '';
  state.chats = stored[STORAGE_KEY_CHATS] || [];
  state.selectedModel = stored[STORAGE_KEY_MODEL] || 'glm-5.2';
  state.usage = stored[STORAGE_KEY_USAGE] || { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
  state.showThinking = stored[STORAGE_KEY_SHOW_THINKING] === true;
  state.reviewDone = stored[STORAGE_KEY_REVIEW] === 'done';
  applyTheme(stored[STORAGE_KEY_THEME] || 'system');

  if (state.apiKey) {
    showApp();
    loadModels(state.apiKey);
  } else {
    showSetup();
  }
}

// The options page is a separate tab, so a settings change there has to reach
// any chat window already on screen rather than waiting for a reopen.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes[STORAGE_KEY_THEME]) {
    applyTheme(changes[STORAGE_KEY_THEME].newValue || 'system');
  }

  if (changes[STORAGE_KEY_SHOW_THINKING]) {
    state.showThinking = changes[STORAGE_KEY_SHOW_THINKING].newValue === true;
    // Re-render so existing replies gain or lose their transcript immediately.
    if (!state.isStreaming) renderMessages();
  }
});

function showSetup() {
  dom.setup.classList.remove('hidden');
  dom.app.classList.add('hidden');
  dom.apiKeyInput.focus();
}

function showApp() {
  dom.setup.classList.add('hidden');
  dom.app.classList.remove('hidden');
  updateSelectedModelUI();
  dom.hintModel.textContent = modelDisplayName(state.selectedModel);
  updateUsageDisplay();
  dom.chatInput.focus();

  // Reopen the most recent conversation, but only if it is still fresh.
  // After STALE_CHAT_MS of inactivity, start a new chat instead — picking up an
  // hours-old thread is rarely what you want on a fresh open.
  if (state.chats.length > 0) {
    const last = state.chats[state.chats.length - 1];
    const idle = Date.now() - (last.updatedAt || 0);
    if (last.messages.length > 0 && idle < STALE_CHAT_MS) {
      loadChat(last.id); // loadChat scrolls to the newest message
    }
  }
}

// ── API Key Management ──
dom.saveKeyBtn.addEventListener('click', async () => {
  const key = dom.apiKeyInput.value.trim();
  if (!key) {
    showToast('Please enter your API key');
    return;
  }

  dom.saveKeyBtn.disabled = true;
  dom.saveKeyBtn.innerHTML = `<span class="loading-dots"><span></span><span></span><span></span></span>`;

  try {
    const models = await fetchModels(key);

    if (!models || models.length === 0) {
      throw new Error('Invalid API key (no models returned)');
    }

    state.apiKey = key;
    state.models = models;
    await chrome.storage.local.set({ [STORAGE_KEY_API_KEY]: key });
    await chrome.storage.local.set({
      [STORAGE_KEY_MODELS_CACHE]: { models, ts: Date.now() },
    });

    showApp();
    populateDropdown();
    showToast('Connected successfully');
  } catch (err) {
    dom.saveKeyBtn.disabled = false;
    dom.saveKeyBtn.innerHTML = `<span>Connect</span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
    showToast(err.message, true);
  }
});

dom.toggleKeyVis.addEventListener('click', () => {
  const isPassword = dom.apiKeyInput.type === 'password';
  dom.apiKeyInput.type = isPassword ? 'text' : 'password';
  const eyeSvg = dom.toggleKeyVis.querySelector('svg');
  eyeSvg.innerHTML = isPassword
    ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
});

dom.apiKeyInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    dom.saveKeyBtn.click();
  }
});

// ── Chat Input ──
dom.chatInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    await sendMessage();
  }
});

dom.chatInput.addEventListener('input', () => {
  dom.chatInput.style.height = 'auto';
  dom.chatInput.style.height = Math.min(dom.chatInput.scrollHeight, 120) + 'px';
});

dom.sendBtn.addEventListener('click', sendMessage);
dom.newChatBtn.addEventListener('click', newChat);
dom.openSettings.addEventListener('click', () => {
  try { chrome.runtime.openOptionsPage(); } catch (_) {}
});

// ── Floating-window bridge ──
// When embedded in the floating frame, the header doubles as the drag
// handle and the window controls talk to the content script via postMessage.
const IS_FRAMED = window !== window.parent;

if (!IS_FRAMED) {
  document.body.classList.add('standalone');
}

function notifyFrame(msg) {
  if (!IS_FRAMED) return;
  try { window.parent.postMessage(msg, '*'); } catch (_) {}
}

dom.winMin.addEventListener('click', () => notifyFrame({ oc: 'min' }));
dom.winClose.addEventListener('click', () => notifyFrame({ oc: 'close' }));

// Puts the cursor where the user is about to type. On the setup screen that is
// the key field; once connected it is the composer.
function focusComposer() {
  const target = dom.setup.classList.contains('hidden') ? dom.chatInput : dom.apiKeyInput;
  try { target.focus(); } catch (_) {}
}

// The content script tells us when the window is shown again. Minimizing only
// hides the frame, so nothing in here re-runs on reopen without this.
window.addEventListener('message', (e) => {
  if (!IS_FRAMED || e.source !== window.parent) return;
  if (!e.data || e.data.oc !== 'focus') return;
  focusComposer();
});

// The header is the drag handle; content/float.js owns the pointer once
// dragging starts.
dom.appHeader.addEventListener('pointerdown', (e) => {
  if (!IS_FRAMED || e.button !== 0) return;
  if (e.target.closest('button, .model-dropdown, a, input, textarea, select')) return;
  e.preventDefault();
  notifyFrame({ oc: 'drag-start', x: e.clientX, y: e.clientY });
});

// Suggestion chips → fill the composer (event delegation: welcome is re-rendered)
dom.messages.addEventListener('click', (e) => {
  if (e.target.closest('#review-go')) {
    window.open(REVIEW_URL, '_blank', 'noopener');
    retireReviewPrompt();
    return;
  }
  if (e.target.closest('#review-bad')) {
    window.open(FEEDBACK_URL, '_blank', 'noopener');
    retireReviewPrompt();
    return;
  }
  // Permanent — never retires anything.
  if (e.target.closest('#feedback-link')) {
    window.open(FEEDBACK_URL, '_blank', 'noopener');
    return;
  }

  const chipBtn = e.target.closest('.sugg-chip');
  if (!chipBtn) return;
  dom.chatInput.value = chipBtn.textContent.trim();
  dom.chatInput.dispatchEvent(new Event('input'));
  dom.chatInput.focus();
});

// ── Chat Management ──
function newChat() {
  state.currentChat = null;
  state.messages = [];
  state.chatTokens = 0;
  state.chatCost = 0;
  updateUsageDisplay();
  renderMessages();
  dom.chatInput.focus();
}

function loadChat(chatId) {
  const chat = state.chats.find(c => c.id === chatId);
  if (!chat) return;
  state.currentChat = chat;
  state.chatTokens = chat.tokens || 0;
  state.chatCost = chat.cost || 0;
  state.messages = chat.messages.map(m => ({
    ...m,
    model: m.model || chat.model || state.selectedModel,
  }));
  if (chat.model && state.models.some(m => m.id === chat.model)) {
    state.selectedModel = chat.model;
  }
  updateSelectedModelUI();
  updateUsageDisplay();
  renderMessages();
  // Always land at the newest message, whether the chat was opened from the
  // sidebar or restored when the window opened.
  scrollToBottom();
}

async function saveChat() {
  const existingIdx = state.chats.findIndex(c => c.id === state.currentChat?.id);
  const chat = {
    id: state.currentChat?.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title: generateChatTitle(),
    messages: state.messages,
    model: state.selectedModel,
    tokens: state.chatTokens || 0,
    cost: state.chatCost || 0,
    updatedAt: Date.now(),
  };

  if (existingIdx >= 0) {
    state.chats[existingIdx] = chat;
  } else {
    state.chats.push(chat);
  }
  state.currentChat = chat;

  if (state.chats.length > 50) {
    state.chats = state.chats.slice(-50);
  }

  await chrome.storage.local.set({ [STORAGE_KEY_CHATS]: state.chats });
}

function generateChatTitle() {
  const firstUserMsg = state.messages.find(m => m.role === 'user');
  if (!firstUserMsg) return 'New Chat';
  const text = firstUserMsg.content.replace(/\n/g, ' ').trim();
  return text.length > 40 ? text.slice(0, 40) + '...' : text;
}

// ── Send Message ──
async function sendMessage() {
  const content = dom.chatInput.value.trim();
  if (!content || state.isStreaming) return;

  dom.chatInput.value = '';
  dom.chatInput.style.height = 'auto';

  state.messages.push({ role: 'user', content });
  renderMessages();
  scrollToBottom();

  state.messages.push({ role: 'assistant', content: '', model: state.selectedModel });
  renderMessages();
  // renderMessages() sets `message ${msg.role}`, so the assistant bubble is
  // .message.assistant — not .message.ai. Getting this wrong silently breaks
  // streaming: text accumulates in state but never paints until a re-render.
  const aiMsgEl = dom.messages.querySelector('.message.assistant:last-of-type .message-content');

  state.isStreaming = true;
  dom.sendBtn.disabled = true;
  document.body.classList.add('streaming');
  notifyFrame({ oc: 'streaming', on: true });

  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.apiKey}`,
      },
      body: JSON.stringify({
        model: state.selectedModel,
        messages: state.messages.filter(m => m.content !== '').map(m => ({
          role: m.role,
          content: m.content,
        })),
        stream: true,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      let errMsg = `Error ${response.status}`;
      try {
        const j = JSON.parse(err);
        errMsg = j.error?.message || j.message || errMsg;
      } catch {}
      throw new Error(errMsg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Accumulated for this one request, then written to the usage history once
    // the stream ends — so the request count is per reply, not per chunk.
    const req = { model: state.selectedModel, tokens: 0, reasoning: 0, cost: 0 };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);

          // Capture usage from final chunk (if present)
          if (parsed.usage) {
            state.usage.total_tokens += parsed.usage.total_tokens || 0;
            state.usage.prompt_tokens += parsed.usage.prompt_tokens || 0;
            state.usage.completion_tokens += parsed.usage.completion_tokens || 0;
            state.chatTokens += parsed.usage.total_tokens || 0;
            req.tokens += parsed.usage.total_tokens || 0;
            // Reasoning models report how much of the completion was thinking.
            req.reasoning += parsed.usage.completion_tokens_details?.reasoning_tokens || 0;
            updateUsageDisplay();
            await chrome.storage.local.set({ [STORAGE_KEY_USAGE]: state.usage });
          }

          // `cost` is a top-level field on the final chunk, not part of `usage`.
          // Values are real per-request charges; some models report "0".
          if (parsed.cost != null) {
            const c = parseFloat(parsed.cost);
            if (!Number.isNaN(c)) {
              state.chatCost += c;
              req.cost += c;
              updateUsageDisplay();
            }
          }

          const choice = parsed.choices?.[0]?.delta;
          const delta = choice?.content;
          // Reasoning models (DeepSeek V4, and others) stream their chain of
          // thought in `reasoning_content` while `content` stays null for the
          // whole thinking phase. Without this the window sits on a spinner and
          // then shows nothing, even though tokens and cost arrive normally.
          const reasoning = choice?.reasoning_content;

          if (reasoning) {
            const lastMsg = state.messages[state.messages.length - 1];
            lastMsg.reasoning = (lastMsg.reasoning || '') + reasoning;
            if (aiMsgEl && !lastMsg.content) {
              // Once the shimmer is on screen, patch just the count. Rewriting
              // innerHTML every chunk would rebuild the element and restart its
              // animation, so the shimmer would sit frozen at frame one.
              const countEl = aiMsgEl.querySelector('.thinking-live .thinking-count');
              if (countEl) {
                countEl.textContent = `~${approxTokens(lastMsg.reasoning).toLocaleString()} tokens`;
              } else {
                aiMsgEl.innerHTML = renderAssistant(lastMsg);
              }
            }
            scrollToBottom();
          }

          if (delta) {
            const lastMsg = state.messages[state.messages.length - 1];
            const firstToken = !lastMsg.content;
            lastMsg.content += delta;
            if (aiMsgEl) {
              // Re-render the whole bubble on the first content token so the
              // reasoning block collapses; after that only the answer changes,
              // so patch it directly and leave the user's toggle state alone.
              const answerEl = aiMsgEl.querySelector('.answer');
              if (firstToken || !answerEl) {
                aiMsgEl.innerHTML = renderAssistant(lastMsg);
              } else {
                answerEl.innerHTML = renderMarkdown(lastMsg.content);
              }
            }
            scrollToBottom();
          }
        } catch {}
      }
    }

    // A reasoning model can spend its whole token budget thinking and return no
    // answer at all. Keep the reasoning rather than saving an empty bubble.
    const finalMsg = state.messages[state.messages.length - 1];
    if (finalMsg?.role === 'assistant' && !finalMsg.content && finalMsg.reasoning) {
      finalMsg.content = finalMsg.reasoning;
      renderMessages();
      scrollToBottom();
    }

    await recordUsage(req);
    await saveChat();
  } catch (err) {
    // Persist whatever streamed in before the failure, so a dropped connection
    // leaves a partial reply in history instead of losing it silently.
    const partial = state.messages[state.messages.length - 1];
    if (partial?.role === 'assistant' && partial.content.trim()) {
      await saveChat();
      renderMessages();
      showToast(err.message, true);
      return;
    }

    // Remove both the failed assistant placeholder AND the user message
    if (state.messages.length && state.messages[state.messages.length - 1].role === 'assistant') {
      state.messages.pop();
    }
    if (state.messages.length && state.messages[state.messages.length - 1].role === 'user') {
      dom.chatInput.value = state.messages.pop().content;
      dom.chatInput.style.height = 'auto';
      dom.chatInput.dispatchEvent(new Event('input'));
    }
    renderMessages();
    showToast(err.message, true);
  } finally {
    state.isStreaming = false;
    dom.sendBtn.disabled = false;
    document.body.classList.remove('streaming');
    notifyFrame({ oc: 'streaming', on: false });
    dom.chatInput.focus();
  }
}

// ── Render ──
// Derived from saved chats rather than a counter, so someone who has already
// been using the extension for weeks qualifies immediately instead of starting
// from zero. History caps at 50 chats, which only matters far above these
// thresholds.
function totalUserMessages() {
  return state.chats.reduce(
    (n, c) => n + (c.messages || []).filter(m => m.role === 'user').length,
    0
  );
}

function shouldAskForReview() {
  if (state.reviewDone) return false;
  return state.chats.length >= REVIEW_MIN_CHATS
    && totalUserMessages() >= REVIEW_MIN_MESSAGES;
}

// Sentiment first, destination second. Asking "enjoying it?" rather than
// "leave a review" means an unhappy user has somewhere to go other than the
// store — and the button labels still say plainly where each one leads.
// The footer under the welcome screen. The feedback link is permanent; the
// review ask is the only part that shows once and then retires.
function renderWelcomeFooter() {
  const review = shouldAskForReview()
    ? `
      <div class="review-prompt" id="review-prompt">
        <p>GO Chat UI is free &mdash; are you enjoying it?</p>
        <div class="review-actions">
          <button class="review-btn" id="review-go">Yes, leave a review</button>
          <button class="review-skip" id="review-bad">Not really</button>
        </div>
      </div>`
    : '';

  return `
    <div class="welcome-footer">
      ${review}
      <button class="feedback-link" id="feedback-link">Send feedback</button>
    </div>`;
}

// Either answer retires the prompt for good \u2014 being asked twice is worse than
// never being asked.
async function retireReviewPrompt() {
  state.reviewDone = true;
  document.getElementById('review-prompt')?.remove();
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_REVIEW]: 'done' });
  } catch (_) {}
}

function renderMessages() {
  dom.messages.innerHTML = '';

  if (state.messages.length === 0) {
    dom.messages.innerHTML = `
      <div class="welcome-message">
        <img class="welcome-icon" src="logo.svg" alt="" width="52" height="52">
        <h2>How can I help?</h2>
        <p>Ask me anything \u2014 code, writing, analysis, and more.</p>
        <div class="sugg-chips">
          <button class="sugg-chip">Explain a complex concept simply</button>
          <button class="sugg-chip">Help me debug some code</button>
          <button class="sugg-chip">Brainstorm ideas with me</button>
        </div>
        ${renderWelcomeFooter()}
      </div>
    `;
    return;
  }

  for (const msg of state.messages) {
    const el = document.createElement('div');
    el.className = `message ${msg.role}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';

    if (msg.role === 'user') {
      avatar.textContent = 'Y';
    } else {
      const src = brandFavicon(msg.model || state.selectedModel, 64);
      if (src) {
        avatar.innerHTML = `<img src="${src}" width="30" height="30" alt="" onerror="var p=this.parentElement;p&&(p.textContent='AI')">`;
      } else {
        avatar.textContent = 'AI';
      }
    }

    const content = document.createElement('div');
    content.className = 'message-content';

    if (msg.role === 'assistant') {
      content.innerHTML = renderAssistant(msg);
    } else {
      content.textContent = msg.content;
    }

    el.appendChild(avatar);
    el.appendChild(content);
    dom.messages.appendChild(el);
  }
}

function scrollToBottom() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

// ── Usage history ──
// Local date parts, not toISOString(): a request at 11pm should land on the
// day the user actually made it, not tomorrow in UTC.
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// One write per completed reply, bucketed by day and model so the settings
// page can break usage down either way without re-deriving it.
async function recordUsage({ model, tokens, reasoning, cost }) {
  if (!tokens && !cost) return;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY_USAGE_DAILY]);
    const daily = stored[STORAGE_KEY_USAGE_DAILY] || {};
    const key = dayKey();
    const day = daily[key] || {};
    const bucket = day[model] || { tokens: 0, reasoning: 0, cost: 0, requests: 0 };

    bucket.tokens += tokens || 0;
    bucket.reasoning += reasoning || 0;
    bucket.cost += cost || 0;
    bucket.requests += 1;

    day[model] = bucket;
    daily[key] = day;

    // Bound the record so storage cannot grow forever. Keys are
    // lexicographically sortable, so a string compare is enough.
    const cutoff = dayKey(Date.now() - USAGE_RETENTION_DAYS * 86400000);
    for (const k of Object.keys(daily)) {
      if (k < cutoff) delete daily[k];
    }

    await chrome.storage.local.set({ [STORAGE_KEY_USAGE_DAILY]: daily });
  } catch (_) {
    // Usage history is non-essential; never break a reply over it.
  }
}

// Reasoning models stream their thinking before (or instead of) an answer.
// Shown dimmed so the window is never blank while they work. Once the answer
// starts arriving it collapses, so a long chain of thought does not push the
// actual reply off screen — click the label to reopen it.
function renderThinking(text, { open = true } = {}) {
  return `<details class="thinking"${open ? ' open' : ''}>` +
    `<summary class="thinking-label">Reasoning</summary>` +
    `<div class="thinking-body">${escapeHtml(text)}</div>` +
    `</details>`;
}

// The API reports usage only on the final chunk, so there is no true token
// count to show while the model is still thinking. Four characters per token
// is the usual rough ratio for English text; the figure is prefixed with "~"
// in the UI so it never reads as an exact count.
function approxTokens(text) {
  return Math.max(1, Math.round(text.length / 4));
}

// Replaces the transcript when "show reasoning" is off. Kept to a single
// shimmering line so a model that thinks for a long time still shows progress
// without dumping its chain of thought into the conversation.
function renderThinkingLive(text) {
  return '<div class="thinking-live">' +
    '<span>Thinking</span>' +
    `<span class="thinking-count">~${approxTokens(text).toLocaleString()} tokens</span>` +
    '</div>';
}

// An assistant bubble: reasoning (if any) above the answer.
function renderAssistant(msg) {
  const answer = renderMarkdown(msg.content);

  let thinking = '';
  if (msg.reasoning) {
    if (state.showThinking) {
      thinking = renderThinking(msg.reasoning, { open: !msg.content });
    } else if (!msg.content) {
      // Only while it is still the whole story. Once the answer starts, the
      // indicator disappears rather than lingering above a finished reply.
      thinking = renderThinkingLive(msg.reasoning);
    }
  }

  if (!answer) {
    return thinking || '<div class="loading-dots"><span></span><span></span><span></span></div>';
  }
  return `${thinking}<div class="answer">${answer}</div>`;
}

// ── Simple Markdown Renderer ──
function renderMarkdown(text) {
  if (!text) return '';

  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code class="language-${lang}">${code.trim()}</code></pre>`)

    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')

    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')

    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')

    .replace(/^---$/gm, '<hr>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')

    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  html = '<p>' + html + '</p>';

  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p><(ul|ol|pre|blockquote|hr|h[1-4])/g, '<$1');
  html = html.replace(/<\/(ul|ol|pre|blockquote|hr|h[1-4])><\/p>/g, '</$1>');

  return html;
}

// ── Toast ──
function showToast(message, isError = false) {
  const existing = $('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.cssText = isError ? 'background: rgba(248,113,113,0.15); border-color: rgba(248,113,113,0.3); color: #fca5a5;' : '';
  toast.textContent = message;
  document.body.appendChild(toast);

  const duration = isError ? 8000 : 2500;
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// ── Start ──
init();

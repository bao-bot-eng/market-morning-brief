const CATEGORY_ORDER = [
  "Macro / Rates",
  "Inflation / Economic Data",
  "Oil / Geopolitics",
  "Index Futures / Risk Sentiment",
  "Tech / Mega-cap",
  "Semis / AI",
  "Earnings / Events",
  "Sector Rotation",
];

const CATEGORY_CLASS = {
  "Macro / Rates": "macro",
  "Inflation / Economic Data": "inflation",
  "Oil / Geopolitics": "oil",
  "Index Futures / Risk Sentiment": "futures",
  "Tech / Mega-cap": "tech",
  "Semis / AI": "semis",
  "Earnings / Events": "earnings",
  "Sector Rotation": "rotation",
};

const TOKEN_KEY = "market_brief_session";
const EXPIRES_KEY = "market_brief_session_expires";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  expiresAt: localStorage.getItem(EXPIRES_KEY) || "",
  mode: "quick",
  currentBrief: null,
  currentMarkdown: "",
  currentGeneratedAt: "",
  currentWarning: "",
};

const elements = {
  loginView: document.querySelector("#loginView"),
  dashboard: document.querySelector("#dashboard"),
  loginForm: document.querySelector("#loginForm"),
  usernameInput: document.querySelector("#usernameInput"),
  passwordInput: document.querySelector("#passwordInput"),
  loginMessage: document.querySelector("#loginMessage"),
  appMessage: document.querySelector("#appMessage"),
  usDateDisplay: document.querySelector("#usDateDisplay"),
  sydneyDateDisplay: document.querySelector("#sydneyDateDisplay"),
  generatedAtDisplay: document.querySelector("#generatedAtDisplay"),
  quickModeButton: document.querySelector("#quickModeButton"),
  readingModeButton: document.querySelector("#readingModeButton"),
  usDateInput: document.querySelector("#usDateInput"),
  sydneyDateInput: document.querySelector("#sydneyDateInput"),
  includeEventsInput: document.querySelector("#includeEventsInput"),
  generateButton: document.querySelector("#generateButton"),
  historyButton: document.querySelector("#historyButton"),
  copyButton: document.querySelector("#copyButton"),
  downloadButton: document.querySelector("#downloadButton"),
  logoutButton: document.querySelector("#logoutButton"),
  historyDrawer: document.querySelector("#historyDrawer"),
  closeHistoryButton: document.querySelector("#closeHistoryButton"),
  historyList: document.querySelector("#historyList"),
  briefView: document.querySelector("#briefView"),
  sourceNotice: document.querySelector("#sourceNotice"),
  summaryGrid: document.querySelector("#summaryGrid"),
  eventList: document.querySelector("#eventList"),
  categoryList: document.querySelector("#categoryList"),
  watchlist: document.querySelector("#watchlist"),
  questions: document.querySelector("#questions"),
  adviceEn: document.querySelector("#adviceEn"),
  adviceZh: document.querySelector("#adviceZh"),
};

init();

function init() {
  validateConfig();
  setDefaultDates();
  bindEvents();
  renderAuthState();
  if (isSessionValid()) {
    loadHistory();
  }
}

function validateConfig() {
  if (!window.APP_CONFIG?.SUPABASE_URL || !window.APP_CONFIG?.SUPABASE_ANON_KEY) {
    throw new Error("Missing frontend/config.js. Use frontend/config.example.js as the template.");
  }
}

function bindEvents() {
  elements.loginForm.addEventListener("submit", login);
  elements.generateButton.addEventListener("click", () => generateBrief(false));
  elements.historyButton.addEventListener("click", openHistory);
  elements.closeHistoryButton.addEventListener("click", () => elements.historyDrawer.classList.remove("open"));
  elements.logoutButton.addEventListener("click", logout);
  elements.copyButton.addEventListener("click", copyMarkdown);
  elements.downloadButton.addEventListener("click", downloadMarkdown);
  elements.quickModeButton.addEventListener("click", () => setMode("quick"));
  elements.readingModeButton.addEventListener("click", () => setMode("reading"));
}

async function login(event) {
  event.preventDefault();
  setMessage(elements.loginMessage, "Logging in...");
  const response = await callFunction("login-market-brief", {
    username: elements.usernameInput.value.trim(),
    password: elements.passwordInput.value,
  }, false);

  if (!response.success) {
    setMessage(elements.loginMessage, response.error || "Invalid username or password", true);
    return;
  }

  state.token = response.token;
  state.expiresAt = response.expires_at;
  localStorage.setItem(TOKEN_KEY, state.token);
  localStorage.setItem(EXPIRES_KEY, state.expiresAt);
  elements.passwordInput.value = "";
  setMessage(elements.loginMessage, "");
  renderAuthState();
  await loadHistory();
}

async function generateBrief(forceRegenerate, existingId = "") {
  if (!requireSession()) return;

  setLoading(true, "Generating brief...");
  const response = await callFunction("generate-market-brief", {
    us_date: elements.usDateInput.value,
    sydney_date: elements.sydneyDateInput.value,
    include_next_events: elements.includeEventsInput.checked,
    mode: state.mode,
    force_regenerate: forceRegenerate,
  });
  setLoading(false);

  if (!response.success) {
    if (response.code === "BRIEF_EXISTS") {
      const openExisting = window.confirm(`${response.error}\n\nOK: open existing brief\nCancel: regenerate`);
      if (openExisting) {
        await openBrief(response.existing_brief_id || existingId);
      } else {
        await generateBrief(true, response.existing_brief_id);
      }
      return;
    }
    setMessage(elements.appMessage, response.error || "Generation failed.", true);
    return;
  }

  state.currentBrief = response.brief_json;
  state.currentMarkdown = response.markdown || "";
  state.currentGeneratedAt = response.generated_at || response.brief_json?.generated_at || "";
  state.currentWarning = response.warning || "";
  renderBrief(response);
  await loadHistory();
  setMessage(elements.appMessage, "Brief generated and saved.");
}

async function loadHistory() {
  if (!requireSession(false)) return;
  const response = await callFunction("briefs-market-brief", { action: "list" });
  if (!response.success) {
    handleApiError(response);
    return;
  }
  renderHistory(response.items || []);
}

async function openBrief(briefId) {
  if (!briefId) return;
  const response = await callFunction("briefs-market-brief", { action: "get", brief_id: briefId });
  if (!response.success) {
    handleApiError(response);
    return;
  }
  state.currentBrief = response.brief_json;
  state.currentMarkdown = response.markdown || "";
  state.currentGeneratedAt = response.generated_at || response.brief_json?.generated_at || "";
  state.currentWarning = response.warning || "";
  renderBrief(response);
  elements.historyDrawer.classList.remove("open");
  setMessage(elements.appMessage, "Loaded saved brief.");
}

async function deleteBrief(briefId) {
  const confirmed = window.confirm("Delete this brief?");
  if (!confirmed) return;

  const response = await callFunction("briefs-market-brief", { action: "delete", brief_id: briefId });
  if (!response.success) {
    handleApiError(response);
    return;
  }
  await loadHistory();
  setMessage(elements.appMessage, "Brief deleted.");
}

async function callFunction(name, body, includeToken = true) {
  const headers = {
    "Content-Type": "application/json",
    apikey: window.APP_CONFIG.SUPABASE_ANON_KEY,
  };
  if (includeToken) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  try {
    const response = await fetch(`${window.APP_CONFIG.SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({
      success: false,
      error: `Function ${name} returned an invalid response.`,
    }));
    return data;
  } catch (error) {
    return { success: false, error: error.message || "Network request failed." };
  }
}

function renderBrief(response) {
  const brief = response.brief_json;
  elements.briefView.classList.remove("hidden");
  elements.usDateDisplay.textContent = brief.us_date || "-";
  elements.sydneyDateDisplay.textContent = brief.sydney_date || "-";
  elements.generatedAtDisplay.textContent = formatDateTime(response.generated_at || brief.generated_at);
  elements.sourceNotice.textContent = response.warning || "";
  elements.sourceNotice.classList.toggle("hidden", !response.warning);
  elements.adviceEn.textContent = brief.not_trading_advice_en || "";
  elements.adviceZh.textContent = brief.not_trading_advice_zh || "";

  renderSummaries(brief.key_market_background || []);
  renderEvents(brief.hard_events_today || []);
  renderCategories(brief.categories || {});
  renderWatchlist(brief.next_1_2_weeks_watchlist || []);
  renderQuestions(brief.observation_questions || []);
  applyMode();
}

function renderSummaries(items) {
  elements.summaryGrid.innerHTML = "";
  const visible = state.mode === "quick" ? items.slice(0, 3) : items.slice(0, 5);
  if (!visible.length) {
    elements.summaryGrid.innerHTML = emptyCard("No key background returned.");
    return;
  }
  visible.forEach((item) => {
    elements.summaryGrid.appendChild(createNode(`
      <article class="summary-card">
        <div class="card-top">
          ${confidenceBadge(item.confidence)}
        </div>
        <h3>${escapeHtml(pair(item, "theme"))}</h3>
        <p class="en">${escapeHtml(item.summary_en || "")}</p>
        <p class="zh">${escapeHtml(item.summary_zh || "")}</p>
        <div class="chips">${chips(item.related_assets)}</div>
      </article>
    `));
  });
}

function renderEvents(items) {
  elements.eventList.innerHTML = "";
  if (!items.length) {
    elements.eventList.innerHTML = emptyCard("No hard events returned.");
    return;
  }
  items.forEach((item) => {
    elements.eventList.appendChild(createNode(`
      <article class="event-card">
        <div>
          <h3>${escapeHtml(pair(item, "event"))}</h3>
          <p>${escapeHtml([item.date, item.time].filter(Boolean).join(" ") || "-")}</p>
          <p class="zh">${escapeHtml(item.notes_zh || "")}</p>
        </div>
        <div class="chips">${chips(item.related_assets)}</div>
        ${sourceButton(item.url, item.source)}
      </article>
    `));
  });
}

function renderCategories(categories) {
  elements.categoryList.innerHTML = "";
  CATEGORY_ORDER.forEach((category) => {
    const items = categories[category] || [];
    const limit = state.mode === "quick" ? 2 : items.length;
    const cards = items.slice(0, limit).map((item) => newsCard(item, category)).join("");
    elements.categoryList.appendChild(createNode(`
      <section class="category-section">
        <button class="category-head ${CATEGORY_CLASS[category]}" type="button">
          <span>${escapeHtml(category)}</span>
          <strong>${items.length}</strong>
        </button>
        <div class="news-grid">${cards || emptyCard("No items in this category.")}</div>
      </section>
    `));
  });
}

function newsCard(item, category) {
  return `
    <article class="news-card">
      <div class="card-top">
        <span class="category-badge ${CATEGORY_CLASS[category] || "macro"}">${escapeHtml(category)}</span>
        ${confidenceBadge(item.confidence)}
      </div>
      <h3>${escapeHtml(pair(item, "title"))}</h3>
      <div class="meta">
        <span>${escapeHtml(item.source || "Unknown source")}</span>
        <span>${escapeHtml(item.published_time || "")}</span>
      </div>
      <div class="chips">${chips(item.related_assets)}</div>
      <p class="en">${escapeHtml(item.summary_en || item.fact_en || "")}</p>
      <p class="zh">${escapeHtml(item.summary_zh || item.fact_zh || "")}</p>
      <details>
        <summary>Expand</summary>
        <p><strong>Fact:</strong> ${escapeHtml(item.fact_en || "")}</p>
        <p class="zh"><strong>事实：</strong>${escapeHtml(item.fact_zh || "")}</p>
        <p><strong>Why it matters:</strong> ${escapeHtml(item.why_it_matters_en || "")}</p>
        <p class="zh"><strong>为什么重要：</strong>${escapeHtml(item.why_it_matters_zh || "")}</p>
        <div class="warning">
          <strong>Do not over-interpret</strong>
          <p>${escapeHtml(item.do_not_overinterpret_en || "")}</p>
          <p class="zh">${escapeHtml(item.do_not_overinterpret_zh || "")}</p>
        </div>
      </details>
      ${sourceButton(item.url, "Open Source")}
    </article>
  `;
}

function renderWatchlist(items) {
  elements.watchlist.innerHTML = "";
  if (!items.length) {
    elements.watchlist.innerHTML = emptyCard("No upcoming watchlist returned.");
    return;
  }
  items.forEach((item) => {
    elements.watchlist.appendChild(createNode(`
      <article class="timeline-item">
        <time>${escapeHtml(item.date || "-")}</time>
        <h3>${escapeHtml(pair(item, "event"))}</h3>
        <p>${escapeHtml(item.why_it_matters_en || "")}</p>
        <p class="zh">${escapeHtml(item.why_it_matters_zh || "")}</p>
        <div class="chips">${chips(item.related_assets)}</div>
        ${sourceButton(item.url, item.source || "Source")}
      </article>
    `));
  });
}

function renderQuestions(items) {
  elements.questions.innerHTML = "";
  if (!items.length) {
    elements.questions.innerHTML = "<p>No observation questions returned.</p>";
    return;
  }
  items.forEach((item, index) => {
    elements.questions.appendChild(createNode(`
      <article class="question-card">
        <strong>${index + 1}</strong>
        <div>
          <p>${escapeHtml(item.en || "")}</p>
          <p class="zh">${escapeHtml(item.zh || "")}</p>
        </div>
      </article>
    `));
  });
}

function renderHistory(items) {
  elements.historyList.innerHTML = "";
  if (!items.length) {
    elements.historyList.innerHTML = "<p>No saved briefs yet.</p>";
    return;
  }
  items.forEach((item) => {
    const row = createNode(`
      <article class="history-item">
        <button type="button" class="history-open">
          <strong>${escapeHtml(item.us_date || "-")}</strong>
          <span>${escapeHtml(item.title || "US Market Morning Brief")}</span>
          <small>${escapeHtml(formatDateTime(item.generated_at))}</small>
        </button>
        <button type="button" class="danger-button">Delete</button>
      </article>
    `);
    row.querySelector(".history-open").addEventListener("click", () => openBrief(item.id));
    row.querySelector(".danger-button").addEventListener("click", () => deleteBrief(item.id));
    elements.historyList.appendChild(row);
  });
}

function setMode(mode) {
  state.mode = mode;
  elements.quickModeButton.classList.toggle("active", mode === "quick");
  elements.readingModeButton.classList.toggle("active", mode === "reading");
  if (state.currentBrief) {
    renderBrief({
      brief_json: state.currentBrief,
      markdown: state.currentMarkdown,
      generated_at: state.currentGeneratedAt,
      warning: state.currentWarning,
    });
  }
}

function applyMode() {
  document.body.dataset.mode = state.mode;
}

function openHistory() {
  loadHistory();
  elements.historyDrawer.classList.add("open");
}

function logout() {
  state.token = "";
  state.expiresAt = "";
  state.currentBrief = null;
  state.currentMarkdown = "";
  state.currentGeneratedAt = "";
  state.currentWarning = "";
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRES_KEY);
  renderAuthState();
}

async function copyMarkdown() {
  if (!state.currentMarkdown) {
    setMessage(elements.appMessage, "No Markdown available.", true);
    return;
  }
  await navigator.clipboard.writeText(state.currentMarkdown);
  setMessage(elements.appMessage, "Markdown copied.");
}

function downloadMarkdown() {
  if (!state.currentMarkdown) {
    setMessage(elements.appMessage, "No Markdown available.", true);
    return;
  }
  const blob = new Blob([state.currentMarkdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `market-brief-${elements.usDateInput.value || "latest"}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function renderAuthState() {
  const loggedIn = isSessionValid();
  elements.loginView.classList.toggle("hidden", loggedIn);
  elements.dashboard.classList.toggle("hidden", !loggedIn);
  if (!loggedIn && state.token) {
    setMessage(elements.loginMessage, "Session expired. Please log in again.", true);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRES_KEY);
  }
}

function requireSession(showMessage = true) {
  if (isSessionValid()) return true;
  logout();
  if (showMessage) {
    setMessage(elements.loginMessage, "Session expired. Please log in again.", true);
  }
  return false;
}

function isSessionValid() {
  return Boolean(state.token && state.expiresAt && new Date(state.expiresAt).getTime() > Date.now());
}

function handleApiError(response) {
  if ((response.error || "").toLowerCase().includes("session expired")) {
    logout();
    setMessage(elements.loginMessage, "Session expired. Please log in again.", true);
    return;
  }
  setMessage(elements.appMessage, response.error || "Request failed.", true);
}

function setDefaultDates() {
  const now = new Date();
  const usDate = dateInZone(now, "America/New_York");
  const sydneyDate = dateInZone(now, "Australia/Sydney");
  elements.usDateInput.value = usDate;
  elements.sydneyDateInput.value = sydneyDate;
  elements.usDateDisplay.textContent = usDate;
  elements.sydneyDateDisplay.textContent = sydneyDate;
}

function setLoading(isLoading, message = "") {
  elements.generateButton.disabled = isLoading;
  elements.generateButton.textContent = isLoading ? "Generating..." : "Generate Morning Brief";
  setMessage(elements.appMessage, message);
}

function setMessage(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle("error", isError);
}

function pair(item, key) {
  const en = item?.[`${key}_en`] || "";
  const zh = item?.[`${key}_zh`] || "";
  return zh && en ? `${en} / ${zh}` : en || zh || "-";
}

function chips(items = []) {
  return items.map((item) => `<span>${escapeHtml(item)}</span>`).join("");
}

function confidenceBadge(value = "medium") {
  const safe = String(value).toLowerCase();
  return `<span class="confidence ${safe}">${escapeHtml(safe)}</span>`;
}

function sourceButton(url, label = "Open Source") {
  if (!url) {
    return `<span class="source-missing">No reliable source link</span>`;
  }
  return `<a class="source-button" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label || "Open Source")}</a>`;
}

function emptyCard(text) {
  return `<article class="empty-card">${escapeHtml(text)}</article>`;
}

function createNode(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function dateInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

import './style.css';

// ── State ───────────────────────────────────────────────────────
const state = {
    apiUrl: localStorage.getItem('search_api_url') || '/api',
    inferenceEnabled: false,
    health: null,
    results: null,
    loading: false,
    error: null,
    searchTime: 0,
    rawJson: null,
};

// ── Settings defaults ───────────────────────────────────────────
const defaults = {
    mode: 'web',
    maxResults: 5,
    fetchTopN: 3,
    includeCitations: true,
    maxTokensMarkdown: 3000,
    topKVector: 20,
    topKFTS: 20,
    topKFinal: 5,
    useReranker: true,
};

// ── Render ──────────────────────────────────────────────────────
function render() {
    const app = document.getElementById('app');
    app.innerHTML = `
    ${renderSidebar()}
    <div class="main-content">
      ${renderSearchHeader()}
      <div class="results-area" id="results-area">
        ${state.error ? renderError() : ''}
        ${state.results ? renderResults() : renderEmpty()}
      </div>
    </div>
  `;
    bindEvents();
}

// ── Sidebar ─────────────────────────────────────────────────────
function renderSidebar() {
    const h = state.health;
    const statusDot = h ? (h.status === 'ok' ? 'ok' : 'error') : 'loading';
    const statusText = h
        ? `<strong>${h.status === 'ok' ? 'All systems healthy' : 'Degraded'}</strong><br/>
       DB: ${h.database} · Redis: ${h.redis}`
        : '<strong>Connecting...</strong>';

    return `
    <div class="sidebar">
      <div class="sidebar-header">
        <h1>
          <span class="icon">⚡</span>
          Agent Search Console
        </h1>
        <div class="subtitle">Test & debug the search API</div>
      </div>

      <!-- Status -->
      <div class="sidebar-section">
        <h3>Service Status</h3>
        <div class="status-bar" id="status-bar">
          <span class="status-dot ${statusDot}"></span>
          <span class="status-text">${statusText}</span>
        </div>
        ${h ? `
        <div class="status-bar">
          <span class="status-dot ${h.inference_enabled ? 'ok' : 'error'}"></span>
          <span class="status-text">
            Inference: <strong>${h.inference_enabled ? 'Enabled' : 'Disabled'}</strong>
          </span>
        </div>` : ''}
        ${renderLatency()}
      </div>

      <!-- Connection -->
      <div class="sidebar-section">
        <h3>Connection</h3>
        <div class="form-group">
          <label>API Base URL</label>
          <input type="text" id="api-url" value="${state.apiUrl}" placeholder="http://localhost:8000" />
        </div>
        <button class="save-btn" id="save-url-btn">💾 Save & Reconnect</button>
      </div>

      <!-- Web Search Settings -->
      <div class="sidebar-section">
        <h3>Web Search</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Max Results</label>
            <input type="number" id="max-results" value="${defaults.maxResults}" min="1" max="20" />
          </div>
          <div class="form-group">
            <label>Fetch Top N</label>
            <input type="number" id="fetch-top-n" value="${defaults.fetchTopN}" min="1" max="10" />
          </div>
        </div>
        <div class="form-group">
          <label>Max Markdown Tokens</label>
          <input type="number" id="max-tokens" value="${defaults.maxTokensMarkdown}" min="500" max="8000" />
        </div>
        <div class="toggle-group">
          <label>Include Citations</label>
          <input type="checkbox" class="toggle" id="include-citations" ${defaults.includeCitations ? 'checked' : ''} />
        </div>
      </div>

      <!-- KB Settings -->
      <div class="sidebar-section">
        <h3>Knowledge Base</h3>
        <div class="form-group">
          <label>Tenant ID</label>
          <input type="text" id="tenant-id" placeholder="00000000-0000-0000-0000-000000000000" />
        </div>
        <div class="form-group">
          <label>Knowledge Base IDs (comma-separated)</label>
          <input type="text" id="kb-ids" placeholder="uuid1, uuid2" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Top K Vector</label>
            <input type="number" id="top-k-vector" value="${defaults.topKVector}" min="1" max="50" />
          </div>
          <div class="form-group">
            <label>Top K FTS</label>
            <input type="number" id="top-k-fts" value="${defaults.topKFTS}" min="1" max="50" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Top K Final</label>
            <input type="number" id="top-k-final" value="${defaults.topKFinal}" min="1" max="20" />
          </div>
          <div class="form-group">
            <div class="toggle-group" style="margin-top: 20px;">
              <label>Reranker</label>
              <input type="checkbox" class="toggle" id="use-reranker" ${defaults.useReranker ? 'checked' : ''} />
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Latency panel ───────────────────────────────────────────────
function renderLatency() {
    const lat = state.health?.latency_p95;
    if (!lat || Object.keys(lat).length === 0) return '';

    const items = Object.entries(lat).map(([key, val]) => `
    <div class="latency-item">
      <div class="label">${key.replace(/_/g, ' ')}</div>
      <div class="value">${val.p95_ms?.toFixed(0) ?? '—'}ms <span style="color:var(--text-muted);font-size:10px">(${val.count})</span></div>
    </div>
  `).join('');

    return `<div class="latency-grid">${items}</div>`;
}

// ── Search header ───────────────────────────────────────────────
function renderSearchHeader() {
    return `
    <div class="search-header">
      <div class="search-bar">
        <div class="search-input-wrapper">
          <span class="search-icon">🔍</span>
          <input
            type="text"
            class="search-input"
            id="search-query"
            placeholder="Search the web or your knowledge base..."
            autofocus
          />
        </div>
        <select class="mode-select" id="search-mode">
          <option value="web" ${defaults.mode === 'web' ? 'selected' : ''}>🌐 Web</option>
          <option value="kb" ${defaults.mode === 'kb' ? 'selected' : ''}>📚 KB</option>
          <option value="auto" ${defaults.mode === 'auto' ? 'selected' : ''}>🤖 Auto</option>
        </select>
        <button class="search-btn ${state.loading ? 'loading' : ''}" id="search-btn" ${state.loading ? 'disabled' : ''}>
          Search
        </button>
      </div>
    </div>
  `;
}

// ── Empty state ─────────────────────────────────────────────────
function renderEmpty() {
    return `
    <div class="empty-state">
      <div class="icon">🔎</div>
      <h3>Ready to search</h3>
      <p>Type a query above and hit Enter or click Search. Configure search parameters in the sidebar.</p>
    </div>
  `;
}

// ── Error ────────────────────────────────────────────────────────
function renderError() {
    return `<div class="error-banner">⚠️ ${escapeHtml(state.error)}</div>`;
}

// ── Results ─────────────────────────────────────────────────────
function renderResults() {
    const r = state.results;
    if (!r || !r.results?.length) {
        return `
      <div class="empty-state">
        <div class="icon">😶</div>
        <h3>No results found</h3>
        <p>Try a different query or adjust the search parameters.</p>
      </div>
    `;
    }

    const cards = r.results.map((item, idx) => renderResultCard(item, idx)).join('');

    return `
    <div class="results-meta">
      <span class="count"><strong>${r.results.length}</strong> results · mode: <strong>${r.mode_used}</strong></span>
      <span class="timing">${state.searchTime}ms</span>
    </div>
    ${cards}
    <button class="json-toggle" id="toggle-json">📋 View raw JSON response</button>
    <div class="json-panel" id="json-panel" style="display:none">${escapeHtml(JSON.stringify(state.rawJson, null, 2))}</div>
  `;
}

function renderResultCard(item, idx) {
    const badge = item.source_type === 'kb' ? 'kb' : 'web';
    const title = item.title || 'Untitled';
    const url = item.url || '';
    const score = typeof item.score === 'number' ? item.score.toFixed(3) : '—';
    const content = item.markdown || '';
    const truncated = content.length > 1200 ? content.slice(0, 1200) + '\n\n... [truncated]' : content;
    const meta = item.metadata || {};

    return `
    <div class="result-card" style="animation-delay: ${idx * 60}ms">
      <div class="result-header">
        <span class="result-badge ${badge}">${badge}</span>
        <span class="result-title">
          ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>` : escapeHtml(title)}
        </span>
        <span class="result-score">${score}</span>
      </div>
      ${url ? `<div class="result-url"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></div>` : ''}
      <div class="result-content">${escapeHtml(truncated)}</div>
      <div class="result-meta-row">
        ${meta.cache_hit ? '<span class="meta-chip cached">✓ cached</span>' : '<span class="meta-chip">● live</span>'}
        ${meta.lang ? `<span class="meta-chip">🌐 ${escapeHtml(meta.lang)}</span>` : ''}
        ${meta.fetched_at ? `<span class="meta-chip">⏱ ${new Date(meta.fetched_at).toLocaleTimeString()}</span>` : ''}
        ${item.citations?.length ? `<span class="meta-chip">📎 ${item.citations.length} citation${item.citations.length > 1 ? 's' : ''}</span>` : ''}
      </div>
    </div>
  `;
}

// ── API calls ───────────────────────────────────────────────────
async function fetchHealth() {
    try {
        const resp = await fetch(`${state.apiUrl}/health/detailed`);
        state.health = await resp.json();
        state.error = null;
    } catch (e) {
        state.health = null;
        state.error = `Cannot reach API at ${state.apiUrl}/health — ${e.message}`;
    }
    render();
}

async function doSearch() {
    const query = document.getElementById('search-query')?.value?.trim();
    if (!query) return;

    const mode = document.getElementById('search-mode')?.value || 'web';
    const maxResults = parseInt(document.getElementById('max-results')?.value) || 5;
    const fetchTopN = parseInt(document.getElementById('fetch-top-n')?.value) || 3;
    const maxTokens = parseInt(document.getElementById('max-tokens')?.value) || 3000;
    const includeCitations = document.getElementById('include-citations')?.checked ?? true;
    const useReranker = document.getElementById('use-reranker')?.checked ?? true;
    const topKVector = parseInt(document.getElementById('top-k-vector')?.value) || 20;
    const topKFTS = parseInt(document.getElementById('top-k-fts')?.value) || 20;
    const topKFinal = parseInt(document.getElementById('top-k-final')?.value) || 5;

    const tenantId = document.getElementById('tenant-id')?.value?.trim();
    const kbIdsRaw = document.getElementById('kb-ids')?.value?.trim();

    const body = {
        query,
        mode,
        web: { max_results: maxResults, fetch_top_n: fetchTopN },
        kb: { top_k_vector: topKVector, top_k_fts: topKFTS, top_k_final: topKFinal, use_reranker: useReranker },
        response: { include_citations: includeCitations, max_tokens_markdown: maxTokens },
    };

    // Add KB scope if provided
    if (tenantId && kbIdsRaw) {
        body.kb_scope = {
            tenant_id: tenantId,
            knowledge_base_ids: kbIdsRaw.split(',').map(s => s.trim()).filter(Boolean),
        };
    }

    state.loading = true;
    state.error = null;
    render();

    const t0 = performance.now();

    try {
        const resp = await fetch(`${state.apiUrl}/tools/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`HTTP ${resp.status}: ${errText}`);
        }

        const data = await resp.json();
        state.results = data;
        state.rawJson = data;
        state.searchTime = Math.round(performance.now() - t0);
        state.error = null;
    } catch (e) {
        state.error = e.message;
        state.results = null;
    }

    state.loading = false;
    render();

    // Refocus the search input
    document.getElementById('search-query')?.focus();
}

// ── Event binding ───────────────────────────────────────────────
function bindEvents() {
    document.getElementById('search-btn')?.addEventListener('click', doSearch);

    document.getElementById('search-query')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
    });

    document.getElementById('save-url-btn')?.addEventListener('click', () => {
        const url = document.getElementById('api-url')?.value?.trim();
        if (url) {
            state.apiUrl = url;
            localStorage.setItem('search_api_url', url);
            const btn = document.getElementById('save-url-btn');
            if (btn) {
                btn.textContent = '✅ Saved!';
                btn.classList.add('saved');
                setTimeout(() => { btn.textContent = '💾 Save & Reconnect'; btn.classList.remove('saved'); }, 1500);
            }
            fetchHealth();
        }
    });

    document.getElementById('toggle-json')?.addEventListener('click', () => {
        const panel = document.getElementById('json-panel');
        if (panel) {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        }
    });
}

// ── Helpers ─────────────────────────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

// ── Initialize ──────────────────────────────────────────────────
render();
fetchHealth();

// Refresh health every 30s
setInterval(fetchHealth, 30000);

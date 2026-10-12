/**
 * BeeFlow Install Wizard — Simplified 5-Step Flow
 * ═══════════════════════════════════════════════════
 * 1. Setup Type  → 2. AI Config → 3. Services → 4. Settings → 5. Deploy
 */

// ── State ───────────────────────────────────────────────────────
const state = {
    step: 0,

    // GPU (detected silently in background)
    gpu: { available: false, gpuName: '', gpuMemory: '', checked: false },

    // Step 1: Deployment type
    deploymentType: '', // azure | standard

    // Step 2: AI Config
    azureEndpoint: '',
    azureKey: '',
    azureModels: '',
    bingKey: '',
    bingMarket: '',
    msClientId: '',
    msClientSecret: '',
    msTenantId: '',
    officeAppsEnabled: false,
    aiProvider: '',
    genericKey: '',
    searchProvider: '',
    serperKey: '',
    tierConfig: {
        fast: { modelId: '' },
        thinking: { modelId: '' },
        writer: { modelId: '' },
        pro: { modelId: '' },
    },
    showTiers: false,
    showSso: false,

    // Step 3: Services
    enableSearch: true,
    enableSearchGpu: false,
    enableSearchLlm: false,
    enableGuard: true,
    enableWhisperx: false,
    enablePii: false,
    enableLocalLlm: false,

    // Step 4: Settings
    adminPassword: '',
    confirmPassword: '',
    serverProtocol: 'http',
    serverHost: 'localhost:3001',
    clientProtocol: 'http',
    clientHost: 'localhost:5176',
    serverPort: '3001',
    clientPort: '5176',
    dbPassword: '',
    sessionSecret: '',
    masterEncryptionKey: '',
    servicesApiKey: '',
    hfToken: '',
    showNetworkEdit: false,
    showSecretEdit: false,

    // Step 5: Deploy
    deploying: false,
    deployResult: null,
    statusInterval: null,
    deploySecrets: {},

    // Update mode
    updateMode: false,
    runningContainers: [],
    registryMode: false,
    selectedForUpdate: [],  // container names to update, empty = all
    updating: false,
    updateResult: null,

    // Version check
    versionChecks: {},   // { containerName: { hasUpdate, isUnknown } }
    checkingVersions: false,
    wizardHasUpdate: false,
};

const STEPS = [
    { key: 'type',     icon: '⚙️', label: 'Setup' },
    { key: 'ai',       icon: '🤖', label: 'AI Config' },
    { key: 'services', icon: '📦', label: 'Services' },
    { key: 'settings', icon: '🔧', label: 'Settings' },
    { key: 'deploy',   icon: '🚀', label: 'Deploy' },
];

const TIER_DEFS = [
    { key: 'fast',     icon: '⚡', label: 'Fast',          desc: 'Quick responses' },
    { key: 'thinking', icon: '🧠', label: 'Thinking',      desc: 'Complex reasoning' },
    { key: 'writer',   icon: '✍️', label: 'Writer',         desc: 'Long-form content' },
    { key: 'pro',      icon: '✨', label: 'Deep Thinking',  desc: 'Maximum quality' },
];

const $ = id => document.getElementById(id);

// Start GPU detection + running service detection immediately in background
detectGpu();
detectRunning();

// ── Render ──────────────────────────────────────────────────────

function render() {
    if (state.updateMode) {
        renderUpdateHeader();
        renderUpdateMode();
        $('wizardActions').style.display = 'none';
        $('stepIndicators').innerHTML = '';
        renderSelfUpdateBanner();
        return;
    }
    renderSelfUpdateBanner();
    renderIndicators();
    renderStepContent();
    renderActions();
    renderHeader();
}

function renderSelfUpdateBanner() {
    let el = document.getElementById('selfUpdateBanner');
    if (!el) {
        el = document.createElement('div');
        el.id = 'selfUpdateBanner';
        el.style.cssText = 'display:none; position:fixed; top:0; left:0; right:0; z-index:9999; padding:8px 16px; background:linear-gradient(90deg,#1d4ed8,#2563eb); color:#fff; font-size:0.78rem; font-weight:600; display:flex; align-items:center; justify-content:center; gap:12px; box-shadow:0 2px 8px rgba(0,0,0,0.18);';
        document.body.prepend(el);
    }
    if (state.wizardHasUpdate) {
        el.style.display = 'flex';
        el.innerHTML = `
            <span>🔄 A new wizard version is available in Harbor</span>
            <button onclick="startSelfUpdate()" style="background:rgba(255,255,255,0.2); border:1px solid rgba(255,255,255,0.4); color:#fff; padding:3px 12px; border-radius:4px; font-size:0.72rem; font-weight:700; cursor:pointer; font-family:inherit;">Update Wizard</button>
            <button onclick="state.wizardHasUpdate=false; renderSelfUpdateBanner();" style="background:transparent; border:none; color:rgba(255,255,255,0.6); cursor:pointer; font-size:1rem;">✕</button>
        `;
    } else {
        el.style.display = 'none';
    }
}

async function startSelfUpdate() {
    const banner = document.getElementById('selfUpdateBanner');
    if (banner) banner.innerHTML = `<span>⏳ Pulling new wizard image... wizard will restart in ~5s</span>`;
    try {
        await fetch('/api/self-update', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    } catch { /* expected — server will die */ }
    // Countdown + auto-reconnect
    let countdown = 8;
    const timer = setInterval(() => {
        countdown--;
        if (banner) banner.innerHTML = `<span>🔄 Wizard is restarting... reconnecting in ${countdown}s</span>`;
        if (countdown <= 0) {
            clearInterval(timer);
            window.location.reload();
        }
    }, 1000);
}

function renderHeader() {
    const s = STEPS[state.step];
    const titles = {
        type: 'Choose Your Setup',
        ai: state.deploymentType === 'azure' ? 'Azure Configuration' : 'AI Provider',
        services: 'Services',
        settings: 'Settings',
        deploy: state.deployResult ? 'Installation Complete!' : (state.deploying ? 'Deploying...' : 'Ready to Deploy'),
    };
    $('stepTitle').textContent = titles[s.key] || s.label;
    $('stepSubtitle').textContent = `Step ${state.step + 1} of ${STEPS.length}`;
}

function renderIndicators() {
    $('stepIndicators').innerHTML = STEPS.map((s, i) => {
        const cls = i < state.step ? 'done' : i === state.step ? 'active' : 'pending';
        const icon = i < state.step ? '✓' : s.icon;
        const conn = i < STEPS.length - 1
            ? `<div class="step-connector ${i < state.step ? 'done' : 'pending'}"></div>` : '';
        return `<div class="step-dot"><div class="step-dot-circle ${cls}">${icon}</div>${conn}</div>`;
    }).join('');
}

function renderActions() {
    const s = STEPS[state.step];
    const isDeploy = s.key === 'deploy';

    if (isDeploy && state.deploying) {
        $('wizardActions').style.display = 'none';
        return;
    }
    $('wizardActions').style.display = '';

    $('btnBack').style.display = state.step > 0 && !isDeploy ? '' : 'none';

    if (isDeploy && state.deployResult) {
        $('btnNext').style.display = 'none';
    } else if (isDeploy) {
        $('btnNext').textContent = '🚀 Deploy Now';
        $('btnNext').className = 'btn btn-success';
        $('btnNext').disabled = false;
        $('btnNext').style.display = '';
    } else {
        $('btnNext').textContent = 'Continue';
        $('btnNext').className = 'btn btn-primary';
        $('btnNext').disabled = s.key === 'type' && !state.deploymentType;
        $('btnNext').style.display = '';
    }

    // Skip button for optional steps
    const skipEl = $('btnSkip');
    if (skipEl) {
        skipEl.style.display = (s.key === 'ai' || s.key === 'settings') ? '' : 'none';
    }
}

function renderStepContent() {
    const s = STEPS[state.step];
    const el = $('stepContent');
    el.style.animation = 'none';
    el.offsetHeight;
    el.style.animation = 'fadeIn 0.3s ease-out';

    const renderers = {
        type: renderSetupType,
        ai: renderAiConfig,
        services: renderServices,
        settings: renderSettings,
        deploy: renderDeploy,
    };
    (renderers[s.key] || (() => {}))();
}

// ═══════════════════════════════════════════════════════════════
// STEP 1: Setup Type
// ═══════════════════════════════════════════════════════════════

function renderSetupType() {
    const hasRunning = state.runningContainers.length > 0;
    $('stepContent').innerHTML = `
        ${hasRunning ? `
        <div class="info-box info-box-update" style="margin-bottom:14px; cursor:pointer;"
             onclick="state.updateMode=true; render();">
            <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-size:1.3rem;">🔄</span>
                <div>
                    <div style="font-weight:600; font-size:0.88rem;">Running installation detected</div>
                    <div style="font-size:0.75rem; color:var(--text-muted);">${state.runningContainers.length} service(s) running — click to update instead of reinstalling</div>
                </div>
                <span style="margin-left:auto; font-size:0.8rem; color:var(--accent); font-weight:600;">Update →</span>
            </div>
        </div>
        ` : ''}
        <div class="deploy-type-grid">
            <div class="deploy-type-card ${state.deploymentType === 'azure' ? 'active-azure' : ''}"
                 onclick="state.deploymentType='azure'; render(); setTimeout(() => nextStep(), 150);">
                ${state.deploymentType === 'azure' ? '<div class="check" style="background:#0078D4;">✓</div>' : ''}
                <div class="deploy-type-icon" style="background:rgba(0,120,212,0.08);">
                    <svg width="22" height="22" viewBox="0 0 96 96"><path d="M33 14L55.3 82H16L33 14z" fill="#0078D4" opacity="0.8"/><path d="M60.5 25L80 82H45.5L60.5 25z" fill="#0078D4"/></svg>
                </div>
                <div class="card-title">Microsoft Azure</div>
                <div class="card-desc">Azure OpenAI, Bing Search, Microsoft SSO</div>
                <div class="tag-row">
                    ${['Azure OpenAI', 'Bing', 'SSO'].map(t => `<span class="tag tag-azure">${t}</span>`).join('')}
                </div>
            </div>

            <div class="deploy-type-card ${state.deploymentType === 'standard' ? 'active-standard' : ''}"
                 onclick="state.deploymentType='standard'; render(); setTimeout(() => nextStep(), 150);">
                ${state.deploymentType === 'standard' ? '<div class="check" style="background:var(--accent);">✓</div>' : ''}
                <div class="deploy-type-icon" style="background:rgba(15,118,110,0.08);">
                    <span style="font-size:20px;">🔧</span>
                </div>
                <div class="card-title">Custom Setup</div>
                <div class="card-desc">OpenAI, Google, Mistral, Claude</div>
                <div class="tag-row">
                    ${['OpenAI', 'Google', 'Mistral', 'Claude'].map(t => `<span class="tag tag-standard">${t}</span>`).join('')}
                </div>
            </div>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════════
// STEP 2: AI Config (dynamic based on deployment type)
// ═══════════════════════════════════════════════════════════════

function renderAiConfig() {
    if (state.deploymentType === 'azure') {
        renderAzureConfig();
    } else {
        renderCustomConfig();
    }
}

function renderAzureConfig() {
    const azureModels = state.azureModels.trim()
        ? state.azureModels.split(',').map(m => m.split('=')[0].trim()).filter(Boolean) : [];

    $('stepContent').innerHTML = `
        <div class="form-group">
            <label class="form-label">Azure OpenAI Endpoint</label>
            <input class="form-input" value="${esc(state.azureEndpoint)}"
                onchange="state.azureEndpoint=this.value"
                placeholder="https://your-resource.openai.azure.com">
        </div>
        <div class="form-group">
            <label class="form-label">API Key</label>
            <input class="form-input" type="password" value="${esc(state.azureKey)}"
                onchange="state.azureKey=this.value" placeholder="Azure API key">
        </div>
        <div class="form-group">
            <label class="form-label">Model Deployments</label>
            <input class="form-input" value="${esc(state.azureModels)}"
                onchange="state.azureModels=this.value; render();"
                placeholder="gpt-5.6-terra, gpt-6-astra, gpt-4.1 (comma-separated)">
        </div>

        ${azureModels.length > 0 ? renderTiersInline(azureModels) : ''}

        <div class="section-divider"></div>

        <div class="optional-header" onclick="state.showSso=!state.showSso; render();">
            <span>🔷 Bing Search & Microsoft SSO</span>
            <span class="badge badge-optional">Optional</span>
            <span class="section-chevron ${state.showSso ? 'open' : ''}">▼</span>
        </div>

        ${state.showSso ? `
            <div class="config-explainer">
                <strong>Bing Web Search</strong> allows the AI to browse the internet for up-to-date information.
                <a href="https://learn.microsoft.com/en-us/bing/search-apis/bing-web-search/create-bing-search-service-resource" target="_blank">How to get a Bing API key</a>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Bing API Key</label>
                    <input class="form-input" type="password" value="${esc(state.bingKey)}"
                        onchange="state.bingKey=this.value" placeholder="Bing Search subscription key">
                </div>
                <div class="form-group">
                    <label class="form-label">Bing Market</label>
                    <input class="form-input" value="${esc(state.bingMarket)}"
                        onchange="state.bingMarket=this.value" placeholder="e.g. nl-NL, en-US">
                </div>
            </div>

            <div class="config-explainer" style="margin-top: 15px;">
                <strong>Microsoft Entra ID (SSO)</strong> lets your team log in with their corporate Microsoft accounts.
                <a href="https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app" target="_blank">How to register an app in Entra</a>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Client (Application) ID</label>
                    <input class="form-input" value="${esc(state.msClientId)}"
                        onchange="state.msClientId=this.value" placeholder="App Client ID">
                </div>
                <div class="form-group">
                    <label class="form-label">Client Secret</label>
                    <input class="form-input" type="password" value="${esc(state.msClientSecret)}"
                        onchange="state.msClientSecret=this.value" placeholder="App Client value">
                </div>
            </div>
            <div class="info-box info-box-info" style="margin-top: -4px; margin-bottom: 12px;">
                <strong>Redirect URI:</strong>
                <code style="user-select: all; cursor: text; padding: 2px 4px; background: rgba(0,0,0,0.05); border-radius: 4px; margin-left: 4px;">https://&lt;your-domain&gt;/auth/callback/microsoft</code>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Tenant ID</label>
                    <input class="form-input" value="${esc(state.msTenantId)}"
                        onchange="state.msTenantId=this.value" placeholder="common or tenant GUID">
                </div>
                <div class="form-group">
                    <label class="form-label">Office 365 Integration</label>
                    <select class="form-select" onchange="state.officeAppsEnabled = this.value === 'true'">
                        <option value="false" ${!state.officeAppsEnabled ? 'selected' : ''}>Disabled</option>
                        <option value="true" ${state.officeAppsEnabled ? 'selected' : ''}>Enabled</option>
                    </select>
                    <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">
                        Allows AI to read/write Outlook, OneDrive, and Teams. Requires Graph API permissions.
                    </div>
                </div>
            </div>
        ` : ''}
    `;
}

function renderCustomConfig() {
    const providers = [
        { id: 'openai',  icon: '🟢', label: 'OpenAI' },
        { id: 'google',  icon: '🔵', label: 'Google AI' },
        { id: 'mistral', icon: '🟠', label: 'Mistral' },
        { id: 'claude',  icon: '🟣', label: 'Claude' },
    ];

    const searchOptions = [
        { id: 'bing',         icon: '🔍', label: 'Bing' },
        { id: 'agent-search', icon: '🤖', label: 'Agent Search' },
        { id: '',             icon: '⏭️', label: 'None' },
    ];

    $('stepContent').innerHTML = `
        <div class="form-label" style="margin-bottom:6px;">AI Provider</div>
        <div class="provider-grid">
            ${providers.map(p => `
                <div class="provider-card ${state.aiProvider === p.id ? 'active' : ''}"
                     onclick="state.aiProvider='${p.id}'; render();">
                    <div class="provider-icon">${p.icon}</div>
                    <div class="provider-label">${p.label}</div>
                </div>
            `).join('')}
        </div>

        ${state.aiProvider ? `
            <div class="form-group" style="margin-top:10px;">
                <label class="form-label">${capitalize(state.aiProvider)} API Key</label>
                <input class="form-input" type="password" value="${esc(state.genericKey)}"
                    onchange="state.genericKey=this.value"
                    placeholder="Enter your API key">
            </div>
        ` : ''}

        <div class="section-divider"></div>

        <div class="form-label" style="margin-bottom:6px;">Web Search</div>
        <div class="provider-grid provider-grid-3">
            ${searchOptions.map(p => `
                <div class="provider-card ${state.searchProvider === p.id ? 'active' : ''}"
                     onclick="state.searchProvider='${p.id}'; render();">
                    <div class="provider-icon">${p.icon}</div>
                    <div class="provider-label">${p.label}</div>
                </div>
            `).join('')}
        </div>

        ${state.searchProvider === 'bing' ? `
            <div class="form-row" style="margin-top:8px;">
                <div class="form-group">
                    <label class="form-label">Bing API Key</label>
                    <input class="form-input" type="password" value="${esc(state.bingKey)}"
                        onchange="state.bingKey=this.value" placeholder="Subscription key">
                </div>
                <div class="form-group">
                    <label class="form-label">Market</label>
                    <input class="form-input" value="${esc(state.bingMarket)}"
                        onchange="state.bingMarket=this.value" placeholder="e.g. en-US">
                </div>
            </div>
        ` : ''}

        ${state.searchProvider === 'agent-search' ? `
            <div class="form-group" style="margin-top:8px;">
                <label class="form-label">Serper API Key</label>
                <input class="form-input" type="password" value="${esc(state.serperKey)}"
                    onchange="state.serperKey=this.value" placeholder="serper.dev key">
            </div>
        ` : ''}

        <div class="section-divider"></div>

        <div class="optional-header" onclick="state.showSso=!state.showSso; render();">
            <span>🔷 Microsoft SSO</span>
            <span class="badge badge-optional">Optional</span>
            <span class="section-chevron ${state.showSso ? 'open' : ''}">▼</span>
        </div>

        ${state.showSso ? `
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Client ID</label>
                    <input class="form-input" value="${esc(state.msClientId)}"
                        onchange="state.msClientId=this.value" placeholder="Application (Client) ID">
                </div>
                <div class="form-group">
                    <label class="form-label">Client Secret</label>
                    <input class="form-input" type="password" value="${esc(state.msClientSecret)}"
                        onchange="state.msClientSecret=this.value" placeholder="Client secret">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Tenant ID</label>
                <input class="form-input" value="${esc(state.msTenantId)}"
                    onchange="state.msTenantId=this.value" placeholder="common or tenant GUID">
            </div>
        ` : ''}
    `;
}

function renderTiersInline(models) {
    return `
        <div class="section-divider"></div>
        <div class="optional-header" onclick="state.showTiers=!state.showTiers; render();">
            <span>⚡ Model Tiers</span>
            <span class="badge badge-optional">Optional</span>
            <span class="section-chevron ${state.showTiers ? 'open' : ''}">▼</span>
        </div>
        ${state.showTiers ? `
            <div class="service-grid">
                ${TIER_DEFS.map(t => `
                    <div class="tier-row">
                        <span class="tier-icon">${t.icon}</span>
                        <div class="tier-info">
                            <div class="tier-label">${t.label}</div>
                        </div>
                        <select class="form-select" style="width:auto;max-width:150px;"
                            onchange="state.tierConfig['${t.key}'].modelId=this.value">
                            <option value="">Auto</option>
                            ${models.map(m => `<option value="${m}" ${state.tierConfig[t.key].modelId === m ? 'selected' : ''}>${m}</option>`).join('')}
                        </select>
                    </div>
                `).join('')}
            </div>
        ` : ''}
    `;
}

// ═══════════════════════════════════════════════════════════════
// STEP 3: Services (with inline GPU detection)
// ═══════════════════════════════════════════════════════════════

function renderServices() {
    const hasGpu = state.gpu.available;
    const gpuChecked = state.gpu.checked;

    const gpuBadge = !gpuChecked
        ? '<div class="gpu-inline loading"><div class="spinner"></div> Detecting GPU...</div>'
        : hasGpu
            ? `<div class="gpu-inline found">✅ ${state.gpu.gpuName} (${state.gpu.gpuMemory})</div>`
            : '<div class="gpu-inline not-found">🖥️ No GPU — CPU mode</div>';

    const services = [
        { key: 'enableSearch',    icon: '🔍', name: 'Search Engine',        desc: 'Vector search, web scraping, knowledge base' },
        { key: 'enableSearchGpu', icon: '⚡', name: 'Search GPU Inference', desc: 'Local embeddings & reranking',              gpu: true, parent: 'enableSearch' },
        { key: 'enableSearchLlm', icon: '🧠', name: 'Document Cleanup LLM', desc: 'Qwen 2B via vLLM',                        gpu: true, parent: 'enableSearch' },
        { key: 'enableGuard',     icon: '🛡️', name: 'Guard Service',        desc: 'CPU-based PII detection (GLiNER multi PII v1)' },
        { key: 'enableWhisperx',  icon: '🎤', name: 'WhisperX',             desc: 'Speech-to-text transcription',              gpu: true },
        { key: 'enablePii',       icon: '🔏', name: 'PII Service',          desc: 'Standalone PII detection' },
        { key: 'enableLocalLlm',  icon: '🖥️', name: 'Local Models (Ollama)', desc: 'Run open-weight LLMs on this machine — no API keys, no per-token cost' },
    ];

    $('stepContent').innerHTML = `
        ${gpuBadge}
        <div class="service-grid">
            ${services.map(s => {
                const disabled = (s.gpu && !hasGpu) || (s.parent && !state[s.parent]);
                const active = state[s.key] && !disabled;
                const indent = s.parent ? 'margin-left:20px;' : '';
                return `
                    <div class="service-card ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}"
                         style="${indent}"
                         onclick="toggleService('${s.key}', ${!!s.gpu}, '${s.parent || ''}')">
                        <div class="service-icon">${s.icon}</div>
                        <div class="service-info">
                            <div class="service-name">${s.name} ${s.gpu ? '<span class="badge badge-gpu">GPU</span>' : ''}</div>
                            <div class="service-desc">${s.desc}</div>
                        </div>
                        <div class="service-toggle ${active ? 'on' : ''}"></div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function toggleService(key, needsGpu, parent) {
    if (needsGpu && !state.gpu.available) return;
    if (parent && !state[parent]) return;
    state[key] = !state[key];
    if (key === 'enableSearch' && !state.enableSearch) { state.enableSearchGpu = false; state.enableSearchLlm = false; }
    renderServices();
}

// ═══════════════════════════════════════════════════════════════
// STEP 4: Settings (Network + Secrets combined)
// ═══════════════════════════════════════════════════════════════

function renderSettings() {
    const pw = state.adminPassword;
    const cpw = state.confirmPassword;
    const pwMatch = pw && cpw && pw === cpw;
    const pwValid = pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw);

    $('stepContent').innerHTML = `
        <div class="form-group" style="margin-bottom: 16px;">
            <label class="form-label" style="font-size: 0.85rem; font-weight: 600;">🔐 Admin Password</label>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-bottom: 6px;">Min 8 chars, uppercase + lowercase + number</div>
            <div class="form-row">
                <div class="form-group">
                    <input class="form-input" type="password" value="${esc(state.adminPassword)}"
                        oninput="state.adminPassword=this.value; updatePwHint();"
                        placeholder="Create admin password">
                </div>
                <div class="form-group">
                    <input class="form-input" type="password" value="${esc(state.confirmPassword)}"
                        oninput="state.confirmPassword=this.value; updatePwHint();"
                        placeholder="Confirm password">
                </div>
            </div>
            <div id="pwHint" style="font-size: 0.72rem; margin-top: 2px; color: ${pw && !pwValid ? '#e53e3e' : pw && pwMatch ? '#38a169' : 'var(--text-muted)'}">
                ${!pw ? '' : !pwValid ? '⚠ Password does not meet requirements' : !pwMatch ? '⚠ Passwords do not match' : '✅ Password set'}
            </div>
        </div>

        <div class="settings-summary">
            <div class="summary-row">
                <span class="summary-label">Network</span>
                <span class="summary-value">${state.serverProtocol}://${state.serverHost}</span>
                <button class="btn-inline" onclick="state.showNetworkEdit=!state.showNetworkEdit; render();">
                    ${state.showNetworkEdit ? 'Hide' : 'Edit'}
                </button>
            </div>
            ${state.showNetworkEdit ? `
                <div class="settings-edit-panel">
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Protocol</label>
                            <select class="form-select" onchange="state.serverProtocol=this.value; state.clientProtocol=this.value; render();">
                                <option value="http" ${state.serverProtocol === 'http' ? 'selected' : ''}>HTTP</option>
                                <option value="https" ${state.serverProtocol === 'https' ? 'selected' : ''}>HTTPS</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Server Host</label>
                            <input class="form-input" value="${state.serverHost}"
                                onchange="state.serverHost=this.value; render();" placeholder="localhost:3001">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Client Host</label>
                            <input class="form-input" value="${state.clientHost}"
                                onchange="state.clientHost=this.value" placeholder="localhost:5176">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Server Port</label>
                            <input class="form-input" value="${state.serverPort}"
                                onchange="state.serverPort=this.value" placeholder="3001">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Client Port</label>
                            <input class="form-input" value="${state.clientPort}"
                                onchange="state.clientPort=this.value" placeholder="5176">
                        </div>
                    </div>
                </div>
            ` : ''}
        </div>

        <div class="settings-summary">
            <div class="summary-row">
                <span class="summary-label">Security</span>
                <span class="summary-value">🔐 Auto-generated</span>
                <button class="btn-inline" onclick="state.showSecretEdit=!state.showSecretEdit; render();">
                    ${state.showSecretEdit ? 'Hide' : 'Customize'}
                </button>
            </div>
            ${state.showSecretEdit ? `
                <div class="settings-edit-panel">
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Database Password</label>
                            <input class="form-input" type="password" value="${esc(state.dbPassword)}"
                                onchange="state.dbPassword=this.value" placeholder="Auto-generate">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Session Secret</label>
                            <input class="form-input" type="password" value="${esc(state.sessionSecret)}"
                                onchange="state.sessionSecret=this.value" placeholder="Auto-generate">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Encryption Key</label>
                            <input class="form-input" type="password" value="${esc(state.masterEncryptionKey)}"
                                onchange="state.masterEncryptionKey=this.value" placeholder="Auto-generate">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Services API Key</label>
                            <input class="form-input" type="password" value="${esc(state.servicesApiKey)}"
                                onchange="state.servicesApiKey=this.value" placeholder="Auto-generate">
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">HuggingFace Token <span style="color:var(--text-muted);font-weight:400;">(for GPU models)</span></label>
                        <input class="form-input" type="password" value="${esc(state.hfToken)}"
                            onchange="state.hfToken=this.value" placeholder="hf_...">
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════════
// STEP 5: Deploy (review summary + deploy button + progress)
// ═══════════════════════════════════════════════════════════════

function renderDeploy() {
    if (state.deploying) {
        renderDeployProgress();
        return;
    }
    if (state.deployResult) {
        renderDeployComplete();
        return;
    }
    renderDeployReview();
}

function renderDeployReview() {
    const profiles = getProfiles();
    const isAzure = state.deploymentType === 'azure';
    const aiInfo = isAzure
        ? (state.azureEndpoint ? '☁️ Azure OpenAI' : '☁️ Azure')
        : (state.aiProvider ? `🤖 ${capitalize(state.aiProvider)}` : '—');

    $('stepContent').innerHTML = `
        <table class="review-table">
            <tr><td>Setup</td><td>${isAzure ? '☁️ Azure' : '🔧 Custom'}</td></tr>
            <tr><td>AI Provider</td><td>${aiInfo}</td></tr>
            <tr><td>Server</td><td>${state.serverProtocol}://${state.serverHost}</td></tr>
            <tr><td>GPU</td><td>${state.gpu.available ? '✅ ' + state.gpu.gpuName : '❌ CPU'}</td></tr>
            <tr><td>Services</td><td>${profiles.length} selected</td></tr>
            <tr><td>SSO</td><td>${state.msClientId ? '✅ Entra ID' : '—'}</td></tr>
            <tr><td>Secrets</td><td>${state.dbPassword ? 'Custom' : '🔐 Auto'}</td></tr>
        </table>
    `;
}

function renderDeployProgress() {
    $('stepContent').innerHTML = `
        <div style="text-align:center; margin-bottom:14px;">
            <div class="spinner" style="width:28px;height:28px;border-width:3px;margin:0 auto 8px;"></div>
            <p style="color:var(--text-muted);font-size:0.78rem;">Building and starting containers...</p>
        </div>
        <div class="progress-log" id="deployLog">Waiting for logs...</div>
        <div class="container-status" id="containerStatus"></div>
    `;
    pollStatus();
}

function renderDeployComplete() {
    const url = `${state.clientProtocol}://${state.clientHost}`;
    const secrets = state.deploySecrets || {};

    $('stepContent').innerHTML = `
        <div style="text-align:center;">
            <div class="complete-icon">✓</div>
            <h2 style="font-size:1.1rem; font-weight:700; margin-bottom:4px;">BeeFlow is Running!</h2>
            <p style="color:var(--text-muted); font-size:0.78rem; margin-bottom:14px;">All services deployed successfully.</p>
            <a href="${url}" target="_blank" class="btn btn-primary" style="text-decoration:none;">Open BeeFlow →</a>
        </div>
        ${Object.keys(secrets).length > 0 ? `
        <div style="margin-top:16px;">
            <div class="form-label" style="margin-bottom:4px;">🔐 Generated Secrets</div>
            <div class="secrets-display">
                ${Object.entries(secrets).map(([k, v]) => `
                    <div class="secret-row">
                        <span class="secret-label">${k}</span>
                        <span class="secret-value" onclick="navigator.clipboard.writeText('${v}')" title="Click to copy">${v.substring(0, 24)}...</span>
                    </div>
                `).join('')}
            </div>
            <div class="form-hint">Click values to copy. Save these somewhere safe — they are not stored on disk.</div>
        </div>
        ` : ''}
        <div class="container-status" id="containerStatus" style="margin-top:12px;"></div>
    `;
    fetchStatus().then(data => { if (data && data.containers) renderContainers(data.containers); });
}

// ── Profiles ────────────────────────────────────────────────────

function getProfiles() {
    const p = ['core'];
    if (state.enableSearch) p.push('search');
    if (state.enableSearch && state.enableSearchGpu) p.push('search-gpu');
    if (state.enableSearch && state.enableSearchLlm) p.push('search-llm');
    if (state.enableGuard) p.push('guard');
    if (state.enableWhisperx) p.push('whisperx');
    if (state.enablePii) p.push('pii');
    if (state.enableLocalLlm) p.push('local-llm');
    return p;
}

// ── Deploy Logic ────────────────────────────────────────────────

async function startDeploy() {
    state.deploying = true;
    render();

    try {
        const r = await fetch('/api/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                serverProtocol: state.serverProtocol, serverHost: state.serverHost,
                clientProtocol: state.clientProtocol, clientHost: state.clientHost,
                serverPort: state.serverPort, clientPort: state.clientPort,
                enableSearch: state.enableSearch, enableSearchGpu: state.enableSearchGpu,
                enableSearchLlm: state.enableSearchLlm, enableGuard: state.enableGuard,
                enableWhisperx: state.enableWhisperx,
                enablePii: state.enablePii,
                enableLocalLlm: state.enableLocalLlm,
                adminPassword: state.adminPassword,
                dbPassword: state.dbPassword, sessionSecret: state.sessionSecret,
                masterEncryptionKey: state.masterEncryptionKey, servicesApiKey: state.servicesApiKey,
                hfToken: state.hfToken,
                deploymentType: state.deploymentType,
                azureEndpoint: state.azureEndpoint, azureKey: state.azureKey,
                azureModels: state.azureModels,
                bingKey: state.bingKey, bingMarket: state.bingMarket,
                msClientId: state.msClientId, msClientSecret: state.msClientSecret,
                msTenantId: state.msTenantId, officeAppsEnabled: state.officeAppsEnabled,
                aiProvider: state.aiProvider, genericKey: state.genericKey,
                searchProvider: state.searchProvider, serperKey: state.serperKey,
                tierConfig: state.tierConfig,
            }),
        });
        const data = await r.json();
        if (!data.success) { showError(data.error || 'Deployment failed'); state.deploying = false; render(); return; }
        state.deploySecrets = data.secrets;
    } catch (e) {
        showError('Failed: ' + e.message);
        state.deploying = false;
        render();
    }
}

async function fetchStatus() {
    try { const r = await fetch('/api/status'); return await r.json(); } catch { return null; }
}

function pollStatus() {
    if (state.statusInterval) clearInterval(state.statusInterval);
    state.statusInterval = setInterval(async () => {
        const data = await fetchStatus();
        if (!data) return;
        const logEl = document.getElementById('deployLog');
        if (logEl && data.logs) { logEl.textContent = data.logs; logEl.scrollTop = logEl.scrollHeight; }
        if (data.containers) renderContainers(data.containers);
        if (data.complete) {
            clearInterval(state.statusInterval);
            if (state.updateMode) {
                state.updating = false;
                state.updateResult = { complete: true };
                renderUpdateMode();
            } else {
                state.deploying = false;
                state.deployResult = { complete: true };
                render();
            }
        }
    }, 3000);
}

function renderContainers(containers) {
    const el = document.getElementById('containerStatus');
    if (!el || !containers.length) return;
    el.innerHTML = containers.map(c => {
        const dot = c.state === 'running' ? 'running' : c.state === 'created' || c.state === 'restarting' ? 'starting' : 'stopped';
        return `<div class="container-row"><div class="container-dot ${dot}"></div><span class="container-name">${c.name}</span><span class="container-state">${c.status || c.state}</span></div>`;
    }).join('');
}

// ── GPU Detection (background) ──────────────────────────────────

async function detectGpu() {
    try {
        const r = await fetch('/api/detect-gpu');
        const data = await r.json();
        state.gpu = { ...data, checked: true };
    } catch {
        state.gpu = { available: false, gpuName: '', gpuMemory: '', checked: true };
    }
    if (!state.gpu.available) {
        state.enableSearchGpu = false;
        state.enableSearchLlm = false;
        state.enableWhisperx = false;
    }
    // Re-render if user is on the services step
    if (STEPS[state.step]?.key === 'services') render();
}

// ── Running Service Detection (background) ───────────────────────

async function detectRunning() {
    try {
        const r = await fetch('/api/running-services');
        const data = await r.json();
        state.runningContainers = data.containers || [];
        state.registryMode = data.registryMode || false;
        // Pre-select all running containers for update
        state.selectedForUpdate = state.runningContainers.map(c => c.name);
        // Re-render step 1 if that's where we are, to show the update banner
        if (state.runningContainers.length > 0 && STEPS[state.step]?.key === 'type') render();
        // Kick off version check in background
        if (state.registryMode && state.runningContainers.length > 0) checkVersions();
    } catch { /* silent */ }
}

// ── Version Check (background) ────────────────────────────────────

async function checkVersions() {
    state.checkingVersions = true;
    if (state.updateMode) renderUpdateMode();
    try {
        const r = await fetch('/api/check-updates');
        const data = await r.json();
        state.versionChecks = {};
        for (const svc of (data.services || [])) {
            state.versionChecks[svc.name] = {
                hasUpdate: svc.hasUpdate,
                isUnknown: svc.isUnknown,
                localError: svc.localError,
                remoteError: svc.remoteError,
            };
        }
        if (data.wizardHasUpdate) state.wizardHasUpdate = true;
    } catch { /* silent */ }
    state.checkingVersions = false;
    if (state.updateMode) renderUpdateMode();
    // If any have updates and user is on step 1, re-render banner
    if (STEPS[state.step]?.key === 'type') render();
}

// ── Update Mode UI ───────────────────────────────────────────────

function renderUpdateHeader() {
    $('stepTitle').textContent = state.updateResult ? 'Update Complete!' : state.updating ? 'Updating...' : 'Update Services';
    $('stepSubtitle').textContent = 'Pull latest images and restart running containers';
}

function renderUpdateMode() {
    const el = $('stepContent');
    el.style.animation = 'none'; el.offsetHeight; el.style.animation = 'fadeIn 0.3s ease-out';

    if (state.updating) {
        el.innerHTML = `
            <div style="text-align:center; margin-bottom:14px;">
                <div class="spinner" style="width:28px;height:28px;border-width:3px;margin:0 auto 8px;"></div>
                <p style="color:var(--text-muted);font-size:0.78rem;">${state.registryMode ? 'Pulling latest images from Harbor and restarting...' : 'Building from source and restarting...'}</p>
            </div>
            <div class="progress-log" id="deployLog">Waiting for logs...</div>
            <div class="container-status" id="containerStatus"></div>
        `;
        pollStatus();
        return;
    }

    if (state.updateResult) {
        el.innerHTML = `
            <div style="text-align:center;">
                <div class="complete-icon">✓</div>
                <h2 style="font-size:1.1rem; font-weight:700; margin-bottom:4px;">Update Complete!</h2>
                <p style="color:var(--text-muted); font-size:0.78rem; margin-bottom:14px;">All selected services restarted with the latest images.</p>
                <button class="btn btn-primary" onclick="state.updateMode=false; state.updateResult=null; state.updating=false; detectRunning(); render();">← Back</button>
            </div>
            <div class="container-status" id="containerStatus" style="margin-top:12px;"></div>
        `;
        fetchStatus().then(data => { if (data?.containers) renderContainers(data.containers); });
        return;
    }

    const containers = state.runningContainers;
    const updatesAvailable = Object.values(state.versionChecks).some(v => v.hasUpdate);

    el.innerHTML = `
        ${!state.registryMode
            ? '<div class="info-box info-box-info" style="margin-bottom:12px;"><strong>Local mode:</strong> Images will be rebuilt from source code and containers recreated.</div>'
            : updatesAvailable
                ? '<div class="info-box" style="margin-bottom:12px; background:rgba(245,158,11,0.06); border:1px solid rgba(245,158,11,0.2);">⚡ <strong>Updates available</strong> — new versions detected in Harbor registry.</div>'
                : state.checkingVersions
                    ? '<div class="info-box info-box-info" style="margin-bottom:12px;"><div class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px;"></div>Checking Harbor for new versions...</div>'
                    : '<div class="info-box info-box-info" style="margin-bottom:12px;"><strong>Registry mode:</strong> Latest images will be pulled from Harbor before restarting.</div>'
        }
        <div style="font-size:0.8rem; font-weight:600; margin-bottom:8px;">Running Services</div>
        <div class="service-grid">
            ${containers.map(c => {
                const sel = state.selectedForUpdate.includes(c.name);
                const check = state.versionChecks[c.name];
                let badge = '';
                if (state.registryMode) {
                    if (state.checkingVersions && !check) {
                        badge = '<span style="font-size:0.65rem; color:var(--text-muted); background:var(--bg-section); padding:1px 6px; border-radius:4px;">⏳ checking</span>';
                    } else if (check?.hasUpdate) {
                        badge = '<span style="font-size:0.65rem; font-weight:700; background:rgba(245,158,11,0.1); color:#b45309; padding:2px 7px; border-radius:4px;">🆕 Update available</span>';
                    } else if (check && !check.isUnknown) {
                        badge = '<span style="font-size:0.65rem; background:rgba(16,185,129,0.08); color:#059669; padding:2px 7px; border-radius:4px;">✅ Up to date</span>';
                    } else if (check?.isUnknown) {
                        const reason = check.localError || check.remoteError || 'no digest';
                        badge = `<span title="${reason}" style="font-size:0.65rem; color:var(--text-muted); background:var(--bg-section); padding:1px 6px; border-radius:4px; cursor:help;">⚪ unknown</span>`;
                    }
                }
                return `
                    <div class="service-card ${sel ? 'active' : ''}"
                         onclick="toggleUpdateService('${c.name}')">
                        <div class="service-info">
                            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                                <span class="service-name" style="font-size:0.82rem;">${c.name}</span>
                                ${badge}
                            </div>
                            <div class="service-desc">${c.status || c.state}</div>
                        </div>
                        <div class="service-toggle ${sel ? 'on' : ''}"></div>
                    </div>`;
            }).join('')}
        </div>
        <div style="display:flex; gap:10px; margin-top:16px; flex-wrap:wrap;">
            <button class="btn btn-success" style="flex:1; min-width:140px;" onclick="startUpdate()">
                🔄 ${state.registryMode ? 'Pull + Restart' : 'Build + Restart'} Selected
            </button>
            ${state.registryMode && Object.values(state.versionChecks).some(v => v.hasUpdate) ? `
            <button class="btn" onclick="selectUpdatesOnly()"
                    style="flex:0; background:rgba(245,158,11,0.08); color:#b45309; border:1px solid rgba(245,158,11,0.3); white-space:nowrap;">
                🆕 Updates Only
            </button>` : ''}
            <button class="btn" onclick="state.updateMode=false; render();"
                    style="flex:0; background:var(--surface-2); color:var(--text-muted); border:1px solid var(--border);">
                ← Fresh Install
            </button>
        </div>
    `;
}

function toggleUpdateService(name) {
    const idx = state.selectedForUpdate.indexOf(name);
    if (idx === -1) state.selectedForUpdate.push(name);
    else state.selectedForUpdate.splice(idx, 1);
    renderUpdateMode();
}

function selectUpdatesOnly() {
    state.selectedForUpdate = state.runningContainers
        .map(c => c.name)
        .filter(name => state.versionChecks[name]?.hasUpdate === true);
    renderUpdateMode();
}

async function startUpdate() {
    if (!state.selectedForUpdate.length) {
        alert('Select at least one service to update.');
        return;
    }
    state.updating = true;
    renderUpdateMode();

    try {
        const r = await fetch('/api/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ services: state.selectedForUpdate }),
        });
        const data = await r.json();
        if (!data.success) {
            state.updating = false;
            alert('Update failed: ' + (data.error || 'Unknown error'));
            renderUpdateMode();
        }
        // pollStatus() is called from renderUpdateMode() when updating=true
    } catch (e) {
        state.updating = false;
        alert('Update failed: ' + e.message);
        renderUpdateMode();
    }
}

// ── Navigation ──────────────────────────────────────────────────

function nextStep() {
    hideError();
    const key = STEPS[state.step]?.key;

    if (key === 'type' && !state.deploymentType) {
        showError('Please select a setup type');
        return;
    }

    // Validate admin password before leaving settings step
    if (key === 'settings') {
        if (!state.adminPassword) {
            showError('Admin password is required');
            return;
        }
        if (state.adminPassword.length < 8 || !/[A-Z]/.test(state.adminPassword) || !/[a-z]/.test(state.adminPassword) || !/[0-9]/.test(state.adminPassword)) {
            showError('Password must be at least 8 characters with uppercase, lowercase, and a number');
            return;
        }
        if (state.adminPassword !== state.confirmPassword) {
            showError('Passwords do not match');
            return;
        }
    }

    if (key === 'deploy') {
        startDeploy();
        return;
    }

    if (state.step < STEPS.length - 1) {
        state.step++;
        render();
        window.scrollTo(0, 0);
    }
}

function prevStep() {
    hideError();
    if (state.step > 0) {
        state.step--;
        render();
    }
}

function skipStep() {
    nextStep();
}

// ── Helpers ─────────────────────────────────────────────────────

function esc(s) { return (s || '').replace(/"/g, '&quot;'); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function showError(msg) { $('errorAlert').style.display = ''; $('errorText').textContent = msg; }
function hideError() { $('errorAlert').style.display = 'none'; }
function updatePwHint() {
    const el = document.getElementById('pwHint');
    if (!el) return;
    const pw = state.adminPassword, cpw = state.confirmPassword;
    const valid = pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw);
    el.style.color = pw && !valid ? '#e53e3e' : pw && pw === cpw ? '#38a169' : 'var(--text-muted)';
    el.textContent = !pw ? '' : !valid ? '⚠ Password does not meet requirements' : pw !== cpw ? '⚠ Passwords do not match' : '✅ Password set';
}

// ── Init ────────────────────────────────────────────────────────
render();

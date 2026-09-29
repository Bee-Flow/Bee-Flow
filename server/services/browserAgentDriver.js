/**
 * Browser Agent Driver — an LLM drives Playwright step-by-step to answer a
 * chat task by reading/interacting with live web pages.
 *
 * A provider-agnostic tool-use loop over the unified adapter layer emits one
 * pw_* tool call at a time against a live Chromium page:
 *   • Cross-origin navigation is ALLOWED (research follows links across sites);
 *     private/loopback/link-local hosts are still blocked (SSRF).
 *   • Streams frames/actions through INJECTED callbacks (the chat SSE `send`);
 *     nothing is persisted — there is no run row.
 *   • Returns extracted answer text.
 *
 * Frames are captured AFTER each action settles (never mid-navigation, which
 * blanks/throws in Chromium) — this is what makes the live preview usable.
 *
 * No new npm deps — reuses the unified adapter layer + the existing `playwright`
 * package and the shared, network-isolated bf-browser container.
 */

const fs = require('fs');
const path = require('path');

const { resolveModelForTier } = require('../core/llm/modelResolver');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'browse-web-prompt.md');
const DEFAULT_MAX_STEPS = parseInt(process.env.BROWSER_AGENT_MAX_STEPS || '8', 10);
const MAX_STEPS_CEILING = parseInt(process.env.BROWSER_AGENT_MAX_STEPS_CEILING || '20', 10);
const WALL_CLOCK_MS = parseInt(process.env.BROWSER_AGENT_TIMEOUT_MS || '90000', 10);
const MIN_FRAME_INTERVAL_MS = parseInt(process.env.BROWSER_AGENT_MIN_FRAME_INTERVAL_MS || '180', 10);
const STEP_TIMEOUT_MS = parseInt(process.env.BROWSER_AGENT_STEP_TIMEOUT_MS || '15000', 10);
const NAV_TIMEOUT_MS = parseInt(process.env.BROWSER_AGENT_NAV_TIMEOUT_MS || '25000', 10);
const MAX_ANSWER_CHARS = 60000;
const MAX_PDF_BYTES = parseInt(process.env.BROWSER_AGENT_MAX_PDF_BYTES || String(25 * 1024 * 1024), 10);
const PDF_FETCH_TIMEOUT_MS = parseInt(process.env.BROWSER_AGENT_PDF_FETCH_TIMEOUT_MS || '20000', 10);
const PDF_RESULT_CHARS = 12000; // per-turn text handed to the model
const FALLBACK_MODEL = 'claude-sonnet-4-6';

function _loadPrompt() {
    try { return fs.readFileSync(PROMPT_PATH, 'utf-8'); }
    catch (_) { return ''; }
}

// Tool schemas exposed to the model. pw_-namespaced so they never collide with
// the outer chat toolbelt (the inner loop has its own isolated tool list).
const TOOLS = [
    {
        name: 'pw_navigate',
        description: 'Navigate the browser to an absolute http(s) URL. Cross-origin is allowed; private/internal addresses are blocked.',
        input_schema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'Absolute URL to navigate to.' } },
            required: ['url'],
        },
    },
    {
        name: 'pw_snapshot',
        description: 'Get a compact accessibility-tree snapshot of the current page. Far cheaper than reading full text — use it to decide what to click.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'pw_get_text',
        description: 'Read the visible text of the page (or a specific element). This is how you collect the content to answer with.',
        input_schema: {
            type: 'object',
            properties: { selector: { type: 'string', description: 'CSS selector — omit to read the whole <body>.' } },
        },
    },
    {
        name: 'pw_click',
        description: 'Click an element. Prefer role+name (Playwright getByRole); fall back to a CSS selector.',
        input_schema: {
            type: 'object',
            properties: {
                role: { type: 'string', description: 'ARIA role (e.g. button, link, textbox).' },
                name: { type: 'string', description: 'Accessible name of the element.' },
                selector: { type: 'string', description: 'CSS selector — only when role+name cannot identify the element.' },
            },
        },
    },
    {
        name: 'pw_type',
        description: 'Type text into an input. Never type real credentials. Set submit:true to press Enter after.',
        input_schema: {
            type: 'object',
            properties: {
                selector: { type: 'string' },
                role: { type: 'string' },
                name: { type: 'string' },
                text: { type: 'string', description: 'Text to type.' },
                submit: { type: 'boolean', description: 'Press Enter after typing.' },
            },
            required: ['text'],
        },
    },
    {
        name: 'pw_scroll',
        description: 'Scroll the page to reveal/load more content.',
        input_schema: {
            type: 'object',
            properties: {
                direction: { type: 'string', enum: ['down', 'up', 'bottom', 'top'], description: 'Default "down".' },
                selector: { type: 'string', description: 'Scroll this element into view instead.' },
            },
        },
    },
    {
        name: 'pw_extract',
        description: 'Save a chunk of information you found that helps answer the task. Everything extracted is returned to the assistant. Include the source URL.',
        input_schema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'The relevant content, in the page\'s own language.' } },
            required: ['text'],
        },
    },
    {
        name: 'pw_done',
        description: 'Finish. Give a short summary of what you found (or why you could not).',
        input_schema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
        },
    },
];

function _toUnifiedTools(tools) {
    return (Array.isArray(tools) ? tools : []).map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description || '',
            parameters: t.input_schema || { type: 'object', properties: {} },
        },
    }));
}
const UNIFIED_TOOLS = _toUnifiedTools(TOOLS);

async function _resolveLocator(page, { role, name, selector }) {
    if (role && name) return page.getByRole(role, { name });
    if (role) return page.getByRole(role);
    if (selector) return page.locator(selector);
    throw new Error('locator requires role+name or selector');
}

function _flattenA11y(node, depth = 0, lines = []) {
    if (!node || depth > 8) return lines.join('\n');
    const indent = '  '.repeat(depth);
    const role = node.role || 'generic';
    const name = node.name ? ` "${String(node.name).slice(0, 80)}"` : '';
    const focusable = node.focusable ? ' [focusable]' : '';
    lines.push(`${indent}- ${role}${name}${focusable}`);
    for (const c of (node.children || [])) _flattenA11y(c, depth + 1, lines);
    return lines.join('\n');
}

function _looksLikePdf(url) {
    return /\.pdf(\?|#|$)/i.test(String(url || ''));
}

// Securely fetch + text-extract a PDF. Uses ssrfGuard.safeFetch — the same
// DNS-rebinding-safe connector used for every user-supplied URL: it refuses
// private/loopback/link-local targets on the initial request AND on every
// redirect hop, and only allows http(s). Size-capped so a hostile server can't
// exhaust memory. Extraction is pdfjs (server/core/pdfExtractor) — no browser
// download, no file ever written to disk.
async function _readPdfSecurely(url) {
    const { safeFetch } = require('../utils/ssrfGuard');
    const { extractTextFromPDF } = require('../core/documents/pdfExtractor');

    const resp = await safeFetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0)', 'Accept': 'application/pdf,*/*' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const declared = parseInt(resp.headers.get('content-length') || '0', 10);
    if (declared && declared > MAX_PDF_BYTES) {
        throw new Error(`PDF is too large (${Math.round(declared / 1e6)}MB > ${Math.round(MAX_PDF_BYTES / 1e6)}MB limit)`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_PDF_BYTES) {
        throw new Error(`PDF is too large (${Math.round(buf.length / 1e6)}MB > ${Math.round(MAX_PDF_BYTES / 1e6)}MB limit)`);
    }
    if (buf.length < 5 || buf.slice(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('The URL did not return a PDF file');
    }
    const text = await extractTextFromPDF(buf, url);
    return { text: (text || '').trim(), bytes: buf.length };
}

// Execute one pw_* tool against the page. `extracted` accumulates pw_extract
// text. Navigation robustness (domcontentloaded + best-effort idle, PDF
// detection) mirrors kbIngestionHelpers.fetchWithPlaywright.
/**
 * Domain allowlist helpers. Hosts are lowercased bare hostnames; a listed
 * host matches itself and every subdomain ("example.com" allows
 * "www.example.com", never "notexample.com").
 */
function normalizeAllowedHosts(list) {
    if (!Array.isArray(list)) return null;
    const hosts = list
        .map((h) => String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, ''))
        .filter(Boolean);
    return hosts.length ? hosts : null;
}

function hostAllowed(hostname, hosts) {
    const h = String(hostname || '').toLowerCase();
    return hosts.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

async function _executeTool(page, name, input, { extracted, allowedHosts = null }) {
    switch (name) {
        case 'pw_navigate': {
            const url = String(input?.url || '').trim();
            if (!url) return { ok: false, error: 'url is required' };

            // Allowlist pre-check: the route hook enforces this too, but a net
            // error teaches the model nothing — a named refusal does. Covers
            // the secure PDF path as well (which never hits the route hook).
            if (allowedHosts) {
                let host = null;
                try { host = new URL(url).hostname; } catch { /* goto will fail it */ }
                if (host && !hostAllowed(host, allowedHosts)) {
                    return { ok: false, error: `domain_not_allowed: ${host}. This app only permits: ${allowedHosts.join(', ')}.` };
                }
            }

            // PDFs can't render in a headless page (Chromium tries to DOWNLOAD
            // them). Read them securely instead — via the SSRF-guarded fetch +
            // pdfjs — so the agent still gets the document's text.
            const readPdf = async () => {
                try {
                    const { text, bytes } = await _readPdfSecurely(url);
                    if (!text || text.length < 20) {
                        return { ok: false, error: 'This PDF has no extractable text (it may be a scanned/image-only document).' };
                    }
                    return {
                        ok: true, url, kind: 'pdf', bytes,
                        totalChars: text.length,
                        truncated: text.length > PDF_RESULT_CHARS,
                        text: text.slice(0, PDF_RESULT_CHARS),
                    };
                } catch (e) {
                    return { ok: false, error: `Could not read the PDF: ${e.message}` };
                }
            };

            if (_looksLikePdf(url)) return await readPdf();

            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
            } catch (navErr) {
                // Content-type turned out to be a download (often a PDF without a
                // .pdf suffix) — fall back to the secure PDF reader.
                if (/download is starting/i.test(navErr.message)) {
                    return await readPdf();
                }
                throw navErr;
            }
            await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
            return { ok: true, url: page.url(), title: await page.title().catch(() => '') };
        }
        case 'pw_snapshot': {
            const snap = await page.accessibility.snapshot({ interestingOnly: true }).catch(() => null);
            return { ok: true, tree: _flattenA11y(snap).slice(0, 6000) };
        }
        case 'pw_get_text': {
            const sel = String(input?.selector || '').trim();
            const txt = sel
                ? await page.locator(sel).first().innerText({ timeout: STEP_TIMEOUT_MS }).catch(() => '')
                : await page.locator('body').innerText({ timeout: STEP_TIMEOUT_MS }).catch(() => '');
            return { ok: true, text: String(txt).slice(0, 8000) };
        }
        case 'pw_click': {
            const loc = await _resolveLocator(page, input || {});
            await loc.first().click({ timeout: STEP_TIMEOUT_MS });
            await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
            return { ok: true, url: page.url() };
        }
        case 'pw_type': {
            const text = String(input?.text || '');
            const loc = input?.role || input?.selector || input?.name
                ? await _resolveLocator(page, input)
                : page.locator('input:visible, textarea:visible').first();
            await loc.first().fill(text, { timeout: STEP_TIMEOUT_MS });
            if (input?.submit) await loc.first().press('Enter');
            return { ok: true, typed: text.length };
        }
        case 'pw_scroll': {
            const sel = String(input?.selector || '').trim();
            if (sel) {
                await page.locator(sel).first().scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS }).catch(() => {});
            } else {
                const dir = input?.direction || 'down';
                await page.evaluate((d) => {
                    if (d === 'bottom') window.scrollTo(0, document.body.scrollHeight);
                    else if (d === 'top') window.scrollTo(0, 0);
                    else if (d === 'up') window.scrollBy(0, -window.innerHeight * 0.9);
                    else window.scrollBy(0, window.innerHeight * 0.9);
                }, dir).catch(() => {});
            }
            await page.waitForTimeout(400);
            return { ok: true };
        }
        case 'pw_extract': {
            const text = String(input?.text || '').trim();
            if (text) extracted.push(text);
            return { ok: true, saved: text.length };
        }
        case 'pw_done': {
            return { ok: true, done: true, summary: String(input?.summary || '').slice(0, 1200) };
        }
        default:
            return { ok: false, error: `unknown_tool: ${name}` };
    }
}

// ── Live-frame emitter — screenshots a SETTLED page, throttled ───────────────
function _makeFrameEmitter(page, onFrame) {
    let lastSent = 0;
    return async function emitFrame() {
        if (typeof onFrame !== 'function') return;
        const now = Date.now();
        if (now - lastSent < MIN_FRAME_INTERVAL_MS) return;
        lastSent = now;
        try {
            const buf = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false, timeout: 5000 });
            onFrame(buf.toString('base64'));
        } catch (_) { /* page may have navigated — drop the frame */ }
    };
}

function _summarizeAction(name, input) {
    const parts = [];
    if (input?.url) parts.push(input.url);
    if (input?.role || input?.name) parts.push(`${input.role || ''}${input.name ? ` "${input.name}"` : ''}`.trim());
    if (input?.selector) parts.push(input.selector);
    if (input?.text) parts.push(`"${String(input.text).slice(0, 40)}"`);
    if (input?.summary) parts.push(String(input.summary).slice(0, 80));
    return `${name}${parts.length ? ' · ' + parts.join(' ') : ''}`.slice(0, 160);
}

/**
 * Run the interactive browse loop.
 *
 * @param {object} args
 * @param {string} args.task            — what the assistant wants read/found/done
 * @param {string|null} [args.startUrl] — optional URL to open first
 * @param {string} args.userId
 * @param {string|null} [args.orgId]
 * @param {(b64:string)=>void} [args.onFrame]
 * @param {(a:{tool,summary,step})=>void} [args.onAction]
 * @param {()=>boolean} [args.isCancelled]
 * @param {string[]|null} [args.allowedHosts] — when set, NAVIGATION is confined
 *   to these hosts (case-insensitive exact or dot-suffix match: "example.com"
 *   also allows "www.example.com"). Enforced in the route hook AND as a
 *   pw_navigate pre-check so the model gets a readable refusal instead of a
 *   net error. Subresources (a page's own CDN assets) stay unconstrained —
 *   the allowlist scopes where the AGENT may go, not how a page renders.
 * @param {number|null} [args.maxSteps] — per-call step cap, clamped to the ceiling.
 * @returns {Promise<{status, answer, visitedUrls, steps, error?}>}
 */
async function runBrowseTask({ task, startUrl = null, userId = null, orgId = null, onFrame = null, onAction = null, isCancelled = null, allowedHosts = null, maxSteps = null }) {
    try { require('playwright'); }
    catch (_) { return { status: 'error', answer: '', visitedUrls: [], steps: 0, error: 'playwright_not_installed' }; }

    const { getAdapter } = require('../core/providers');
    const { getProviderForModel } = require('../core/aiAgent');
    const { isPrivateHostname, isPrivateIp } = require('../utils/ssrfGuard');

    const resolved = await resolveModelForTier('tier:thinking', { userOrgId: orgId, userId });
    let modelId = resolved || FALLBACK_MODEL;
    let provider = null;
    try {
        provider = await getProviderForModel(modelId);
    } catch (_) {
        modelId = FALLBACK_MODEL;
        try { provider = await getProviderForModel(modelId); }
        catch (_2) {
            return { status: 'error', answer: '', visitedUrls: [], steps: 0, error: 'no_provider_for_model: browse_web needs a configured model provider (Admin → AI Config).' };
        }
    }
    if (!provider || (!provider.apiKey && !provider.serviceAccountKey)) {
        return { status: 'error', answer: '', visitedUrls: [], steps: 0, error: 'provider_api_key_not_configured: browse_web requires a model provider with credentials.' };
    }
    const adapter = getAdapter(provider.providerType, provider.url);

    const extracted = [];
    const visitedUrls = [];
    let ctx, page;
    const deadline = Date.now() + WALL_CLOCK_MS;

    try {
        const browserProvider = require('./browserProvider');
        ctx = await browserProvider.newSharedContext({ viewport: { width: 1280, height: 800 } });

        // SSRF: block any request (main nav, redirect, subresource) to a
        // private/loopback/link-local host or a non-http(s) scheme. Cross-origin
        // to PUBLIC hosts is allowed (research follows links).
        //
        // With `allowedHosts`, NAVIGATION requests (main frame, redirects
        // included — each redirect hop is its own navigation request here) are
        // additionally confined to the allowlist. The SSRF checks stay
        // unconditional and first: an allowlist must never widen them.
        const hosts = normalizeAllowedHosts(allowedHosts);
        await ctx.route('**/*', (route) => {
            let u;
            try { u = new URL(route.request().url()); } catch (_) { return route.abort('blockedbyclient'); }
            if (!['http:', 'https:'].includes(u.protocol)) return route.abort('blockedbyclient');
            if (isPrivateHostname(u.hostname) || isPrivateIp(u.hostname)) return route.abort('blockedbyclient');
            if (hosts && route.request().isNavigationRequest() && !hostAllowed(u.hostname, hosts)) {
                return route.abort('blockedbyclient');
            }
            return route.continue();
        });

        page = await ctx.newPage();
        page.setDefaultTimeout(STEP_TIMEOUT_MS);
        const emitFrame = _makeFrameEmitter(page, onFrame);

        // Seed navigation (if a start URL was given), so the model doesn't burn
        // a turn on the obvious first move and the preview shows content fast.
        const messages = [];
        const systemPrompt = _loadPrompt();
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

        let seedNote = '';
        if (startUrl) {
            const seedRes = await _executeTool(page, 'pw_navigate', { url: startUrl }, { extracted, allowedHosts: hosts });
            if (onAction) onAction({ tool: 'pw_navigate', summary: _summarizeAction('pw_navigate', { url: startUrl }), step: 0 });
            if (seedRes.ok && seedRes.kind === 'pdf') {
                // A PDF start URL was read securely (no page nav). Hand its text
                // straight to the model so it doesn't have to re-fetch.
                visitedUrls.push(startUrl);
                seedNote = `The user provided a PDF at ${startUrl}. Its extracted text${seedRes.truncated ? ` (first ${PDF_RESULT_CHARS} of ${seedRes.totalChars} chars)` : ''} follows — read it, pw_extract the relevant parts, then pw_done:\n\n${seedRes.text}`;
            } else if (seedRes.ok) {
                visitedUrls.push(page.url());
                await emitFrame();
                seedNote = `The browser is already open at ${page.url()} (title: ${seedRes.title || '—'}).`;
            } else {
                seedNote = `Tried to open ${startUrl} but it failed: ${seedRes.error}. Navigate somewhere else or report the problem.`;
            }
        } else {
            seedNote = 'No starting URL was given — begin with pw_navigate to a relevant page.';
        }
        messages.push({ role: 'user', content: `Task:\n${String(task || '(read the page and summarize it)').slice(0, 4000)}\n\n${seedNote}` });

        const requestedSteps = Number.isInteger(maxSteps) && maxSteps > 0 ? maxSteps : DEFAULT_MAX_STEPS;
        const stepCap = Math.min(Math.max(requestedSteps, 1), MAX_STEPS_CEILING);
        let stepCount = 0;
        let doneRequested = false;
        let timedOut = false;

        while (stepCount < stepCap && !doneRequested) {
            if (isCancelled && isCancelled()) break;
            if (Date.now() > deadline) { timedOut = true; break; }
            stepCount += 1;

            let response;
            try {
                response = await adapter.chat(provider.apiKey, provider.url, modelId, messages, {
                    maxTokens: 4096,
                    tools: UNIFIED_TOOLS,
                    toolChoice: 'auto',
                });
            } catch (e) {
                return { status: 'error', answer: _finalize(extracted), visitedUrls, steps: stepCount, error: `llm_error: ${e.message}` };
            }

            const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
            messages.push({
                role: 'assistant',
                content: typeof response.content === 'string' ? response.content : '',
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            });

            if (toolCalls.length === 0) {
                // Model answered in text without a tool — treat its text as the
                // final answer and stop.
                if (typeof response.content === 'string' && response.content.trim()) {
                    extracted.push(response.content.trim());
                }
                break;
            }

            const toolMessages = [];
            for (const tc of toolCalls) {
                if (isCancelled && isCancelled()) { doneRequested = true; break; }
                const fn = tc.function || tc;
                let input = {};
                try { input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || fn.input || {}); }
                catch (_) { input = {}; }
                const name = fn.name;

                if (onAction) onAction({ tool: name, summary: _summarizeAction(name, input), step: stepCount });

                let result;
                try { result = await _executeTool(page, name, input, { extracted, allowedHosts: hosts }); }
                catch (e) { result = { ok: false, error: e.message }; }

                if (result?.done) doneRequested = true;
                if (name === 'pw_navigate' && result?.ok && result.url) visitedUrls.push(result.url);

                toolMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify(result).slice(0, 8000),
                });

                await emitFrame();
            }
            messages.push(...toolMessages);
        }

        const answer = _finalize(extracted);
        let status = 'ok';
        if (timedOut) status = 'timeout';
        if (!answer || answer.trim().length < 20) status = 'empty';
        return { status, answer, visitedUrls: [...new Set(visitedUrls)], steps: stepCount };
    } catch (e) {
        return { status: 'error', answer: _finalize(extracted), visitedUrls: [...new Set(visitedUrls)], steps: 0, error: e.message };
    } finally {
        try { await page?.close(); } catch (_) {}
        try { await ctx?.close(); } catch (_) {}
    }
}

function _finalize(extracted) {
    const joined = (extracted || []).join('\n\n').trim();
    return joined.length > MAX_ANSWER_CHARS
        ? joined.slice(0, MAX_ANSWER_CHARS) + `\n\n[...truncated, ${joined.length} chars total...]`
        : joined;
}

module.exports = {
    runBrowseTask,
    normalizeAllowedHosts,
    hostAllowed,
    _internals: { TOOLS, UNIFIED_TOOLS, _executeTool, _flattenA11y, _summarizeAction, _finalize },
};

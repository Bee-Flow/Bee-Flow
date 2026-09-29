/**
 * App Studio — server-side screen render + screenshot.
 *
 * Lets the builder AI SEE a screen it just assembled: the prebuilt runtime
 * bundle (agent-hub `npm run build:runtime` → server/vendor/app-runtime/) is
 * served to the shared bf-browser IN-PROCESS via page.route() against a fake
 * origin — the browser is network-isolated by design and must stay that way,
 * so the page is handed to it rather than navigated to.
 *
 * The screenshot is TRUTHFUL because the data is real: every record/records/
 * aggregate/dataset binding on the screen is executed read-only through the
 * ONLY sanctioned read paths (queryCompiler + rlsGateway access filters,
 * datasetCache.runDataset — the same machinery appDryRun.js uses), as the
 * owner or as `asRole`, and the resolved rows are handed to mount() as a
 * pre-filled DataContext state. Zero network requests happen in the page.
 *
 * Contract (never throws at the caller):
 *   renderAppScreenshot({ app, definition, model, screenId, asRole, viewport })
 *     → { ok:true, png:Buffer, dataUrl, width, height, ... }
 *     | { ok:false, unavailable:true, reason:'<one plain sentence>' }
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');

const { collectDataBindings } = require('../appStudio/collectDataBindings');
const queryCompiler = require('../appStudio/queryCompiler');
const rlsGateway = require('../appStudio/rlsGateway');
const { seedVariableDefaults } = require('../appStudio/componentSpecs');
const { ROLE_PROBE_VIEWER_ID } = require('../appStudio/appDryRun');
const { compile, tryEvaluate } = require('../automation/expr');

const RUNTIME_DIR = path.join(__dirname, '..', 'vendor', 'app-runtime');
const BUNDLE_JS = 'app-runtime.mjs';
const BUNDLE_CSS = 'app-runtime.css';

const VIEWPORTS = {
    desktop: { width: 1280, height: 800 },
    tablet: { width: 834, height: 1112 },
    mobile: { width: 390, height: 844 },
};
// The bundle is served locally (no CDN round-trips like webpageRender's
// esm.sh path), so mount should be fast; the hard cap covers a cold browser
// container spawn on top of navigation + mount + settle.
const NAV_TIMEOUT_MS = 15000;
const MOUNT_WAIT_MS = 10000;
const SETTLE_MS = 500;
const HARD_TIMEOUT_MS = 45000;
const MAX_DIM = 1280;      // cap longest side before handing the PNG to a model
const MAX_IMG_H = 4000;    // a very tall screen still becomes a bounded image
const MAX_DIAG_MSGS = 25;
// Same trick as webpageRender: a real navigation to a fake origin so module
// scripts execute; every URL under it is fulfilled in-process.
const PREVIEW_ORIGIN = 'https://appstudio-preview.beeflow.local/';

// ── Client-lockstep binding resolution ──────────────────────────────
// The runtime looks dataState entries up by dataCacheKey(resolvedBinding),
// resolving dynamic filter values against its live scope FIRST (resolveBinding
// .js in agent-hub). These small ports must produce byte-identical keys for
// the same binding + scope, or mount() finds no entry and renders "loading".

/** Deterministic JSON with sorted keys — port of the client's key hasher. */
function stableStringify(value) {
    if (value == null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Port of the client dataCacheKey for the server-collected binding kinds. */
function dataCacheKey(binding) {
    if (!binding || typeof binding !== 'object') return null;
    if (binding.kind === 'dataset') return `dataset:${binding.datasetId ?? ''}`;
    if (binding.kind === 'record' || binding.kind === 'records') {
        const shape = stableStringify({
            filter: binding.filter ?? null,
            sort: binding.sort ?? null,
            limit: binding.limit ?? null,
        });
        return `${binding.kind}:${binding.tableId ?? ''}:${shape}`;
    }
    if (binding.kind === 'aggregate') {
        const shape = stableStringify({
            filter: binding.filter ?? null,
            groupBy: binding.groupBy ?? null,
            aggregates: binding.aggregates ?? null,
            sort: binding.sort ?? null,
            limit: binding.limit ?? null,
        });
        return `aggregate:${binding.tableId ?? ''}:${shape}`;
    }
    return null;
}

// The scope roots our screen-level synthetic scope can populate identically to
// the mounted runtime's scope. `item`/`index` (repeater rows), a live `form`,
// action results — those resolve per-instance at render time, so a binding
// referencing them is skipped (its entry key can't be precomputed). `now` is
// also excluded: it drifts by milliseconds between our key and the renderer's,
// which would split the key anyway (the client docs tell authors to avoid it).
const RESOLVABLE_ROOTS = new Set(['currentUser', 'vars', 'forms', 'screen', 'today']);
const NO_VALUE_FILTER_OPS = new Set(['isNull', 'isNotNull']);
const AGGREGATE_SHAPE_FIELDS = ['groupBy', 'aggregates', 'sort', 'limit'];

function formulaRefsResolvable(expr) {
    try { return compile(String(expr || '')).refs.every((r) => RESOLVABLE_ROOTS.has(r)); }
    catch { return false; }
}

function evalFormula(v, scope) {
    const expr = v.expr;
    if (typeof expr !== 'string' || !expr.trim()) return undefined;
    return tryEvaluate(expr, scope || {}).value;
}

/** Port of the client resolveBindingShape (aggregate descriptor formulas). */
function resolveShape(binding, scope) {
    if (binding.kind !== 'aggregate') return { binding };
    let changed = false;
    const out = { ...binding };
    for (const field of AGGREGATE_SHAPE_FIELDS) {
        const raw = binding[field];
        if (!raw || typeof raw !== 'object' || raw.kind !== 'formula') continue;
        if (!formulaRefsResolvable(raw.expr)) return { skipped: true };
        changed = true;
        const value = evalFormula(raw, scope);
        if (value === undefined || value === null) delete out[field];
        else out[field] = value;
    }
    return { binding: changed ? out : binding };
}

/**
 * Port of the client resolveBindingFilters, plus the dynamic-skip guard: the
 * omission/required semantics must match EXACTLY (they shape the cache key).
 * Returns { binding } or { skipped:true } (no query, no entry — the renderer
 * lands on the same "no key / different key" outcome for that component).
 */
function resolveFilters(binding, scope) {
    if (!Array.isArray(binding.filter) || binding.filter.length === 0) return { binding };
    let changed = false;
    const filter = [];
    for (const entry of binding.filter) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { filter.push(entry); continue; }
        if (NO_VALUE_FILTER_OPS.has(entry.op)) { filter.push(entry); continue; }
        const { required, ...rest } = entry;
        const raw = entry.value;
        const isFormula = raw && typeof raw === 'object' && raw.kind === 'formula';
        if (isFormula && !formulaRefsResolvable(raw.expr)) return { skipped: true };
        const value = isFormula ? evalFormula(raw, scope) : raw;
        if (value === undefined || value === null) {
            // Client: required + unresolved → the whole binding resolves to
            // null (no query at all); optional → the entry is omitted.
            if (required) return { skipped: true };
            changed = true;
            continue;
        }
        if (required) { changed = true; filter.push({ ...rest, value }); continue; }
        if (value === entry.value) { filter.push(entry); continue; }
        changed = true;
        filter.push({ ...rest, value });
    }
    if (!changed) return { binding };
    if (filter.length === 0) {
        const { filter: _dropped, ...rest } = binding;
        return { binding: rest };
    }
    return { binding: { ...binding, filter } };
}

// ── Data pass — real rows through the sanctioned read paths ─────────

/** Same fallback chain as the client renderer resolves its screen with. */
function resolveScreen(definition, screenId) {
    const screens = (definition && Array.isArray(definition.screens)) ? definition.screens : [];
    return screens.find((s) => s && s.id === screenId)
        || screens.find((s) => s && s.id === definition.homeScreenId)
        || screens[0]
        || null;
}

function findModelTable(model, ref) {
    const tables = (model && Array.isArray(model.tables)) ? model.tables : [];
    return tables.find((t) => t && (t.id === ref || t.key === ref)) || null;
}

/**
 * The expression scope the mounted runtime will build from the same inputs —
 * currentUser is the IDENTICAL object we pass to mount(), so a filter formula
 * like `currentUser.id` resolves to the same value on both sides of the key.
 */
function buildRenderScope(currentUser, variables, screen) {
    const now = Date.now();
    return {
        currentUser,
        vars: seedVariableDefaults(variables),
        forms: {},
        screen: { params: {}, id: screen.id, name: screen.name },
        now,
        today: new Date(now).toISOString().slice(0, 10),
    };
}

function entryBase(overrides) {
    return {
        status: 'success', result: undefined, error: null, errorCode: null,
        errorProvider: null, tableId: null, datasetId: null, connectorId: null,
        ...overrides,
    };
}

/** One record/records/aggregate binding → a DataContext entry with real rows. */
async function runTableEntry(binding, { model, app, roleArg, viewer, deps }) {
    const base = { tableId: binding.tableId ?? null };
    const emptyResult = binding.kind === 'record' ? null : [];
    const table = findModelTable(model, binding.tableId);
    // The live endpoint 404s an unknown table and the client degrades to an
    // empty result — mirror that, so the screenshot shows the empty region the
    // real screen would show (the dry-run's STATIC pass names the bad ref).
    if (!table) return entryBase({ ...base, result: emptyResult });
    if (!rlsGateway.canRead(table, roleArg)) {
        return entryBase({ ...base, status: 'error', error: 'This role has no read access to this table' });
    }
    try {
        const accessFilter = rlsGateway.compileAccessFilter(table, roleArg, viewer, 'read');
        let rows;
        if (binding.kind === 'aggregate') {
            const { sql, params } = queryCompiler.compileAggregate(table, {
                filters: binding.filter,
                groupBy: binding.groupBy,
                aggregates: binding.aggregates,
                sort: binding.sort,
                limit: binding.limit,
            }, accessFilter);
            const out = await deps.dbQuery(app.userId, app.id, sql, params);
            rows = Array.isArray(out && out.rows) ? out.rows : [];
        } else {
            const { sql, params, limit } = queryCompiler.compileRecordList(table, {
                filters: binding.filter,
                sort: binding.sort,
                limit: binding.kind === 'record' ? 1 : binding.limit,
            }, accessFilter);
            const out = await deps.dbQuery(app.userId, app.id, sql, params);
            // The compiler fetches limit+1 as a pagination probe — drop it.
            rows = (Array.isArray(out && out.rows) ? out.rows : []).slice(0, limit);
        }
        const result = binding.kind === 'record' ? (rows[0] ?? null) : rows;
        return entryBase({ ...base, result });
    } catch (e) {
        if (e instanceof rlsGateway.AccessError) {
            return entryBase({ ...base, status: 'error', error: 'This role has no read access to this table' });
        }
        return entryBase({ ...base, status: 'error', error: e && e.message ? e.message : String(e) });
    }
}

/** One dataset binding → a DataContext entry via the cache-aware runner. */
async function runDatasetEntry(binding, { model, app, viewer, deps }) {
    const base = { datasetId: binding.datasetId ?? null };
    try {
        const ds = await deps.getDataset(binding.datasetId, app.id, app.userId);
        // Unknown dataset → the live endpoint 404s → the client stores null.
        if (!ds) return entryBase({ ...base, result: null });
        const out = await deps.runDataset(app, model, ds, viewer, { refresh: false });
        return entryBase({ ...base, result: Array.isArray(out && out.rows) ? out.rows : [] });
    } catch (e) {
        return entryBase({ ...base, status: 'error', error: e && e.message ? e.message : String(e) });
    }
}

/**
 * Execute every binding on the screen and key the results exactly as the
 * runtime DataContext will look them up. Per-binding failures become 'error'
 * entries (what the live screen would show), never a throw.
 */
async function buildDataState({ definition, model, app, screen, roleArg, viewer, currentUser, deps }) {
    const dataState = {};
    if (!app || !app.id) return dataState; // nothing to read against — bindings render as loading
    const scope = buildRenderScope(currentUser, definition.variables, screen);
    for (const { binding } of collectDataBindings(definition, screen.id)) {
        let resolved = { binding };
        if (binding.kind !== 'dataset') {
            resolved = resolveShape(binding, scope);
            if (!resolved.skipped) resolved = resolveFilters(resolved.binding, scope);
            if (resolved.skipped) continue;
        }
        const key = dataCacheKey(resolved.binding);
        if (!key || Object.prototype.hasOwnProperty.call(dataState, key)) continue;
        dataState[key] = binding.kind === 'dataset'
            ? await runDatasetEntry(resolved.binding, { model, app, viewer, deps })
            : await runTableEntry(resolved.binding, { model, app, roleArg, viewer, deps });
    }
    return dataState;
}

// ── Document composition + browser capture ──────────────────────────

/**
 * The HTML the browser renders. The payload travels as a JSON script tag
 * (with `<` escaped so `</script>` in app content can't break out); the module
 * script imports mount() from the routed bundle URL and flags completion on
 * window so the capture loop knows when to screenshot.
 */
function composeRenderDocument(payload) {
    const json = JSON.stringify(payload).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/${BUNDLE_CSS}">
<style>html,body{margin:0;padding:0;background:#fff}#root{min-height:100vh}</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="bf-payload">${json}</script>
<script type="module">
import { mount } from '/${BUNDLE_JS}';
const payload = JSON.parse(document.getElementById('bf-payload').textContent);
try {
    await mount(document.getElementById('root'), payload);
    window.__bfMounted = true;
} catch (err) {
    window.__bfMountError = String((err && err.message) || err);
}
</script>
</body>
</html>`;
}

/**
 * Default browser edge (injectable): serve the doc + bundle to the shared
 * bf-browser via route fulfilment and screenshot the mounted root. The browser
 * deliberately has no route to this server, so EVERY url under the fake origin
 * is answered in-process; anything else gets an empty 204 (mount() performs no
 * network requests by contract — this is belt and braces).
 */
async function captureDocument({ doc, assets, viewport }) {
    const browserProvider = require('./browserProvider');
    const consoleErrors = [];
    const pageErrors = [];

    return browserProvider.withContext(
        { viewport, deviceScaleFactor: 1, javaScriptEnabled: true },
        async (context) => {
            const page = await context.newPage();
            page.setDefaultTimeout(NAV_TIMEOUT_MS);
            page.on('console', (m) => {
                try {
                    const t = m.type();
                    if ((t === 'error' || t === 'warning') && consoleErrors.length < MAX_DIAG_MSGS) {
                        consoleErrors.push(`[${t}] ${m.text()}`.slice(0, 300));
                    }
                } catch (_) { /* ignore */ }
            });
            page.on('pageerror', (e) => {
                if (pageErrors.length < MAX_DIAG_MSGS) pageErrors.push(String((e && e.message) || e).slice(0, 300));
            });

            await page.route((u) => u.href.startsWith(PREVIEW_ORIGIN), (route) => {
                const url = route.request().url();
                if (url === PREVIEW_ORIGIN) {
                    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: doc });
                }
                const rel = url.slice(PREVIEW_ORIGIN.length).split('?')[0];
                if (Object.prototype.hasOwnProperty.call(assets, rel)) {
                    return route.fulfill({ status: 200, contentType: assets[rel].contentType, body: assets[rel].body });
                }
                return route.fulfill({ status: 204, body: '' });
            });
            await page.goto(PREVIEW_ORIGIN, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });

            // Resolve on mount OR on a mount error — a hung mount times out and
            // we still screenshot whatever painted (an honest picture of it).
            await page.waitForFunction(
                () => window.__bfMounted === true || !!window.__bfMountError,
                { timeout: MOUNT_WAIT_MS, polling: 100 },
            ).catch(() => {});
            await page.waitForTimeout(SETTLE_MS);

            const mountError = await page.evaluate(() => window.__bfMountError || null).catch(() => null);
            let png = null;
            try {
                const root = await page.$('#root');
                if (root) png = await root.screenshot({ type: 'png' });
            } catch (_) { /* fall through to viewport shot */ }
            if (!png) png = await page.screenshot({ type: 'png' });
            return { png, mountError, consoleErrors, pageErrors };
        },
    );
}

// ── Bounding + fail-soft plumbing ───────────────────────────────────

function resolveViewport(viewport) {
    if (viewport && typeof viewport === 'object' && viewport.width && viewport.height) {
        return { width: viewport.width, height: viewport.height };
    }
    return VIEWPORTS[viewport] || VIEWPORTS.desktop;
}

async function withHardTimeout(promise, ms) {
    let t;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                t = setTimeout(() => reject(new Error(`the render timed out after ${Math.round(ms / 1000)}s`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(t);
        // A loser that rejects later must not surface as an unhandled rejection.
        Promise.resolve(promise).catch(() => {});
    }
}

/** Downscale so the image is cheap to send to a model (same caps as webpageRender). */
async function boundPng(pngBuffer, vp) {
    let width = vp.width;
    let height = vp.height;
    try {
        const sharp = require('sharp');
        const meta = await sharp(pngBuffer).metadata();
        width = meta.width || width;
        height = meta.height || height;
        if (width > MAX_DIM || height > MAX_IMG_H) {
            pngBuffer = await sharp(pngBuffer)
                .resize({ width: MAX_DIM, height: MAX_IMG_H, fit: 'inside', withoutEnlargement: true })
                .png({ compressionLevel: 9 })
                .toBuffer();
            const m2 = await sharp(pngBuffer).metadata();
            width = m2.width || width;
            height = m2.height || height;
        }
    } catch (_) { /* sharp unavailable — keep the raw PNG */ }
    return { pngBuffer, width, height };
}

async function readRuntimeBundle() {
    try {
        const [js, css] = await Promise.all([
            fs.readFile(path.join(RUNTIME_DIR, BUNDLE_JS), 'utf8'),
            fs.readFile(path.join(RUNTIME_DIR, BUNDLE_CSS), 'utf8'),
        ]);
        return { js, css };
    } catch {
        return null;
    }
}

// Injectable edges, appDryRun-style, so the tests run DB- and browser-free.
function defaultDeps() {
    return {
        readBundle: readRuntimeBundle,
        capture: captureDocument,
        hardTimeoutMs: HARD_TIMEOUT_MS,
        dbQuery: (ownerScope, appId, sql, params) =>
            require('../stores/studioAppDbStore').query(ownerScope, appId, sql, params),
        runDataset: (app, model, ds, viewer, opts) =>
            require('../appStudio/datasetCache').runDataset(app, model, ds, viewer, opts),
        getDataset: (datasetId, appId, ownerId) =>
            require('../stores/studioAppDataStore').getDataset(datasetId, appId, ownerId),
    };
}

function unavailable(reason) {
    return { ok: false, unavailable: true, reason };
}

/**
 * Render one App Studio screen headless and screenshot it.
 *
 * @param {object} input
 * @param {object}  input.app        — the studio_apps row ({ id, userId }); data pass skipped without it
 * @param {object}  input.definition — canonical app definition
 * @param {object}  [input.model]    — the app's data model (or null)
 * @param {string}  [input.screenId] — screen to render (default: home screen)
 * @param {string}  [input.asRole]   — render + read data as this role (must exist in model.roles)
 * @param {string|object} [input.viewport] — 'desktop' | 'tablet' | 'mobile' | { width, height }
 * @param {object}  [input.deps]     — injectable edges (tests): readBundle, capture,
 *                                     dbQuery, runDataset, getDataset, hardTimeoutMs
 */
async function renderAppScreenshot({ app = null, definition = null, model = null, screenId = null, asRole = null, viewport = 'desktop', deps = null } = {}) {
    try {
        const d = { ...defaultDeps(), ...(deps || {}) };

        if (!definition || !Array.isArray(definition.screens) || definition.screens.length === 0) {
            return unavailable('the app definition has no screens to render');
        }
        // An explicit screenId must exist — silently falling back to the home
        // screen would hand the model a screenshot of the WRONG screen.
        if (screenId && !definition.screens.some((s) => s && s.id === screenId)) {
            return unavailable(`screen "${screenId}" is not in the app definition`);
        }
        const screen = resolveScreen(definition, screenId);
        if (!screen) return unavailable('the app definition has no screens to render');

        const roles = (model && Array.isArray(model.roles)) ? model.roles : [];
        const role = asRole ? roles.find((r) => r && r.key === asRole) : null;
        if (asRole && !role) {
            return unavailable(`the role "${asRole}" is not defined in the app's data model`);
        }

        const bundle = await d.readBundle();
        if (!bundle || !bundle.js || !bundle.css) {
            return unavailable('the app runtime bundle is not in this build');
        }

        // Owner renders as the owner; asRole renders as a synthetic non-owner
        // viewer (the dry-run's probe id), so 'own'-scoped tables truthfully
        // show what a member would see — never the owner's rows.
        const roleArg = asRole || 'owner';
        const currentUser = asRole
            ? { id: ROLE_PROBE_VIEWER_ID, name: (role && role.name) || asRole, email: null, roleKey: asRole }
            : { id: app ? app.userId : null, name: 'App owner', email: null, roleKey: 'owner' };
        const viewer = { id: currentUser.id, role: roleArg };

        const dataState = await buildDataState({
            definition, model, app, screen, roleArg, viewer, currentUser, deps: d,
        });

        const doc = composeRenderDocument({
            // A screenshot is a STILL, so it must not be taken mid-animation.
            // The runtime animates charts in run mode (~1.5s), and the capture
            // settles for a fraction of that — so every chart was photographed
            // part-drawn, with its line stopping two-thirds of the way across.
            // A reviewer then reads a complete series as truncated data and
            // "fixes" a binding that was never broken. Forcing motion off makes
            // the picture agree with the page.
            definition: { ...definition, design: { ...(definition.design || {}), motion: 'none' } },
            screenId: screen.id,
            dataState,
            currentUser,
            previewRole: asRole || null,
        });
        const assets = {
            [BUNDLE_JS]: { contentType: 'text/javascript; charset=utf-8', body: bundle.js },
            [BUNDLE_CSS]: { contentType: 'text/css; charset=utf-8', body: bundle.css },
        };
        const vp = resolveViewport(viewport);

        const shot = await withHardTimeout(d.capture({ doc, assets, viewport: vp }), d.hardTimeoutMs);
        if (!shot || !shot.png) {
            return unavailable(shot && shot.mountError
                ? `the screen failed to mount: ${shot.mountError}`
                : 'the browser did not produce a screenshot');
        }

        const { pngBuffer, width, height } = await boundPng(shot.png, vp);
        return {
            ok: true,
            png: pngBuffer,
            dataUrl: `data:image/png;base64,${pngBuffer.toString('base64')}`,
            width,
            height,
            // Diagnostics the caller may relay to the model alongside the image.
            mountError: shot.mountError || null,
            consoleErrors: shot.consoleErrors || [],
            pageErrors: shot.pageErrors || [],
        };
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        return unavailable(`the screenshot could not be rendered: ${msg}`);
    }
}

module.exports = {
    renderAppScreenshot,
    VIEWPORTS,
    // exposed for tests
    _test: {
        buildDataState,
        composeRenderDocument,
        dataCacheKey,
        stableStringify,
        resolveFilters,
        resolveShape,
        buildRenderScope,
        resolveScreen,
    },
};

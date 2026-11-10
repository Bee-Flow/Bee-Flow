#!/usr/bin/env node
/**
 * app-compat-pixels — screenshots of every App Studio compat-corpus app, written as a
 * baseline or compared against one. A tool for the person running a look change, not a
 * test: it is not in check:fast or CI, because it needs a built runtime bundle and a
 * Chromium.
 *
 *   node scripts/app-compat-pixels.mjs --write   <dir> --bundle <dir> (--chrome <path> | --ws <url>)
 *   node scripts/app-compat-pixels.mjs --compare <dir> --bundle <dir> (--chrome <path> | --ws <url>)
 *       [--diff <dir>] [--only <name,name>] [--concurrency <n>] [--tolerance <0-255>]
 *
 * Every screen of every server/appStudio/compat/corpus/*.json app is rendered at the render
 * service's three viewports (desktop, tablet, mobile) under the host themes light, dark and
 * high-contrast. Rendering goes through the product's own path,
 * server/services/appStudioRender.js renderAppScreenshot(): the same document, the same
 * network-less page with the bundle routed in, motion forced off, the same capture. This
 * script supplies only what a running server would: the bundle (`--bundle`, the directory
 * `npm run build:runtime` writes, agent-hub/dist-runtime, holding app-runtime.mjs and
 * app-runtime.css), a browser, and an empty database (every read answers no rows). Two
 * things are added to the document before capture: the host theme on <html> (data-theme, as
 * the SPA sets it) and a fixed clock, so "today" and the default dates do not move between
 * the baseline run and the compare run.
 *
 * One known gap: the render service builds its data keys with the server's real clock, the
 * page with the fixed one, so a binding whose filter reads `today` or `now` finds no entry and
 * shows its loading state (still, with animation off) rather than its empty state. That is
 * the same on every run, so it does not hide a difference elsewhere on the screen.
 *
 * The browser: `--chrome <path>` launches a local Chrome or Chromium through the server's
 * Playwright as a Playwright server (TZ=UTC, LANG=en_US.UTF-8); `--ws <url>` (or
 * BROWSER_WS_ENDPOINT) uses a running Playwright server, e.g. the browser sidecar. Without
 * either it stops: the product's fallback (starting the shared browser container through
 * Docker) is not something a check should do on its own.
 *
 * The baseline lives OUTSIDE the repository (the argument): build the bundle from main,
 * --write, build it from the branch, --compare. Compare exits 1 when any screenshot differs
 * in size or in any pixel, or when the baseline lacks one the corpus has now; --diff writes a
 * red-on-grey image per difference. A pixel differs when a channel is off by more than
 * --tolerance (default 4): the same bundle rendered twice on one machine moves a handful of
 * anti-aliased edge pixels by up to 3, and a real change (a 1px shift, another colour) moves
 * far more. --tolerance 0 compares exactly.
 *
 * The server is loaded in-process for its render service. Its database module connects on
 * load, so CORE_DATABASE_URL is pointed at a port nothing listens on before that: the script
 * never reaches a real database. Expect its connection errors in the output.
 *
 * Exit 0 same (or written), 1 differences, 2 usage or setup error.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = path.join(ROOT, 'server/appStudio/compat/corpus');

export const VIEWPORT_NAMES = ['desktop', 'tablet', 'mobile'];
/** Host themes, as data-theme values the SPA sets on <html> (dark is the :root default). */
export const THEMES = ['light', 'dark', 'high-contrast'];
/** The instant the page's clock is fixed at. */
export const FIXED_NOW = '2026-01-15T12:00:00.000Z';
/** Channel difference below which a pixel counts as the same (see the header). */
export const DEFAULT_TOLERANCE = 4;

const USAGE = 'usage: app-compat-pixels.mjs (--write <dir> | --compare <dir>) --bundle <dir> (--chrome <path> | --ws <url>) [--diff <dir>] [--only a,b] [--concurrency n] [--tolerance n]';

/** argv → options, or { error }. */
export function parseArgs(argv, env = {}) {
    const opts = { mode: null, baseline: null, bundle: null, chrome: null, ws: env.BROWSER_WS_ENDPOINT || null, diff: null, only: null, concurrency: 2, tolerance: DEFAULT_TOLERANCE };
    const takes = new Set(['--write', '--compare', '--bundle', '--chrome', '--ws', '--diff', '--only', '--concurrency', '--tolerance']);
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i];
        if (!takes.has(flag)) return { error: `unknown argument ${flag}` };
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` };
        i += 1;
        if (flag === '--write' || flag === '--compare') {
            if (opts.mode) return { error: 'give one of --write and --compare' };
            opts.mode = flag.slice(2);
            opts.baseline = path.resolve(value);
        } else if (flag === '--only') {
            opts.only = value.split(',').map((s) => s.trim()).filter(Boolean);
        } else if (flag === '--concurrency' || flag === '--tolerance') {
            const n = Number(value);
            const max = flag === '--tolerance' ? 255 : 16;
            if (!Number.isInteger(n) || n < (flag === '--tolerance' ? 0 : 1) || n > max) return { error: `${flag} must be a whole number up to ${max}` };
            opts[flag.slice(2)] = n;
        } else {
            opts[flag.slice(2)] = flag === '--ws' ? value : path.resolve(value);
        }
    }
    if (!opts.mode) return { error: 'give --write <dir> or --compare <dir>' };
    if (!opts.bundle) return { error: '--bundle <dir> is required (agent-hub: npm run build:runtime writes dist-runtime/)' };
    if (!opts.chrome && !opts.ws) return { error: 'give --chrome <path> or --ws <url> (or set BROWSER_WS_ENDPOINT)' };
    if (opts.baseline.startsWith(ROOT + path.sep) || opts.baseline === ROOT) return { error: 'the baseline directory must be outside the repository' };
    return opts;
}

/** A file-name-safe form of an id: letters, digits, `-` and `_` kept, anything else `_`. */
export function safeName(id) {
    let out = '';
    for (const ch of String(id)) {
        const ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_';
        out += ok ? ch : '_';
    }
    return out || '_';
}

/** Every (app, screen, viewport, theme) to render, in a stable order. */
export function buildJobs(apps) {
    const jobs = [];
    for (const app of apps) {
        for (const screen of app.definition?.screens || []) {
            if (!screen || typeof screen.id !== 'string') continue;
            for (const viewport of VIEWPORT_NAMES) {
                for (const theme of THEMES) {
                    jobs.push({ name: app.name, screenId: screen.id, viewport, theme, key: `${app.name}/${safeName(screen.id)}/${viewport}-${theme}.png` });
                }
            }
        }
    }
    return jobs;
}

/**
 * CSS animations and transitions off, the way Playwright's `animations: 'disabled'` takes
 * them out of a screenshot: a loading skeleton's shimmer is caught at a different phase on
 * every run otherwise. The render service forces design motion off for the same reason;
 * this also covers the animations that setting does not reach.
 */
export const STILL_STYLE = '<style>*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}</style>';

/** The render document with the host theme on <html>, the page clock fixed and animation off. */
export function prepareDocument(doc, theme, nowIso = FIXED_NOW) {
    const ms = Date.parse(nowIso);
    const clock = '<script>(function(){var F=' + ms + ',R=Date;function D(){var a=Array.prototype.slice.call(arguments);'
        + 'if(!(this instanceof D))return new R(F).toString();return a.length?new (Function.prototype.bind.apply(R,[null].concat(a)))():new R(F);}'
        + 'D.prototype=R.prototype;D.now=function(){return F};D.parse=R.parse;D.UTC=R.UTC;window.Date=D;})();</script>' + STILL_STYLE;
    const html = doc.indexOf('<html>');
    const head = doc.indexOf('<head>');
    if (html === -1 || head === -1) throw new Error('the render document has no <html> or <head> to add the theme and clock to');
    const withTheme = `${doc.slice(0, html)}<html data-theme="${theme}">${doc.slice(html + '<html>'.length)}`;
    const at = withTheme.indexOf('<head>') + '<head>'.length;
    return `${withTheme.slice(0, at)}\n${clock}${withTheme.slice(at)}`;
}

/**
 * Compare two decoded RGBA images. A pixel differs when any channel differs by more than
 * `tolerance`. → { sameSize, differing, total, mask } (mask: 1 per differing pixel).
 */
export function diffPixels(a, b, tolerance = 0) {
    if (a.width !== b.width || a.height !== b.height) {
        return { sameSize: false, differing: null, total: null, mask: null };
    }
    const total = a.width * a.height;
    const mask = new Uint8Array(total);
    let differing = 0;
    for (let p = 0; p < total; p += 1) {
        const o = p * 4;
        for (let c = 0; c < 4; c += 1) {
            if (Math.abs(a.data[o + c] - b.data[o + c]) > tolerance) {
                mask[p] = 1;
                differing += 1;
                break;
            }
        }
    }
    return { sameSize: true, differing, total, mask };
}

/** A visible diff: differing pixels red, the rest the baseline in faint grey. */
export function diffImageData(base, mask) {
    const out = Buffer.alloc(base.width * base.height * 4);
    for (let p = 0; p < mask.length; p += 1) {
        const o = p * 4;
        if (mask[p]) {
            out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 255;
        } else {
            const grey = Math.round((base.data[o] + base.data[o + 1] + base.data[o + 2]) / 3);
            const faint = 200 + Math.round(grey * 55 / 255);
            out[o] = faint; out[o + 1] = faint; out[o + 2] = faint; out[o + 3] = 255;
        }
    }
    return out;
}

/** Baseline keys vs the keys rendered now → { missing, added } (each sorted). */
export function compareKeySets(baselineKeys, currentKeys) {
    const base = new Set(baselineKeys);
    const now = new Set(currentKeys);
    return {
        missing: [...now].filter((k) => !base.has(k)).sort(),
        added: [...base].filter((k) => !now.has(k)).sort(),
    };
}

// ── The run (side effects from here on) ────────────────────────────────────────

function loadApps(only) {
    const names = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    const unknown = (only || []).filter((n) => !names.includes(n));
    if (unknown.length) throw new Error(`not in the corpus: ${unknown.join(', ')}`);
    return names.filter((n) => !only || only.includes(n)).map((name) => {
        const file = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, `${name}.json`), 'utf8'));
        return { name, definition: file.definition, dataModel: file.dataModel || null, datasets: file.datasets || [] };
    });
}

function readBundleDir(dir) {
    const js = path.join(dir, 'app-runtime.mjs');
    const css = path.join(dir, 'app-runtime.css');
    if (!fs.existsSync(js) || !fs.existsSync(css)) throw new Error(`${dir} has no app-runtime.mjs and app-runtime.css (agent-hub: npm run build:runtime)`);
    return { js: fs.readFileSync(js, 'utf8'), css: fs.readFileSync(css, 'utf8') };
}

/** Launch a local Chrome as a Playwright server; returns { wsEndpoint, close }. */
async function launchLocalBrowser(serverRequire, executablePath) {
    const { chromium } = serverRequire('playwright');
    const server = await chromium.launchServer({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
        env: { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    });
    return { wsEndpoint: server.wsEndpoint(), close: () => server.close() };
}

async function renderJob(render, job, app, bundle) {
    const { renderAppScreenshot, _test } = render;
    const result = await renderAppScreenshot({
        // An app row so the data pass runs; every read answers no rows.
        app: { id: 'compat-pixels', userId: 'compat-pixels' },
        definition: app.definition,
        model: app.dataModel,
        screenId: job.screenId,
        viewport: job.viewport,
        deps: {
            readBundle: async () => bundle,
            // Everything the service hands its capture (fonts and assets fulfilment, crop target) passes on.
            capture: (args) => _test.captureDocument({ ...args, doc: prepareDocument(args.doc, job.theme) }),
            dbQuery: async () => ({ rows: [] }),
            getDataset: async (datasetId) => app.datasets.find((d) => d && d.id === datasetId) || null,
            runDataset: async () => ({ rows: [] }),
        },
    });
    if (!result.ok) throw new Error(`${job.key}: ${result.reason}`);
    return result;
}

async function pool(items, size, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const i = next;
            next += 1;
            await fn(items[i], i);
        }
    });
    await Promise.all(workers);
}

async function run(opts, log) {
    const apps = loadApps(opts.only);
    const byName = new Map(apps.map((a) => [a.name, a]));
    const jobs = buildJobs(apps);
    const bundle = readBundleDir(opts.bundle);
    const bundleSha = crypto.createHash('sha256').update(bundle.js).update(bundle.css).digest('hex');

    // Before the server loads: no real database, ever (see the header).
    process.env.CORE_DATABASE_URL = 'postgresql://compat:compat@127.0.0.1:1/compat_pixels_no_database';
    const serverRequire = createRequire(path.join(ROOT, 'server/package.json'));
    let local = null;
    if (!opts.ws) {
        local = await launchLocalBrowser(serverRequire, opts.chrome);
        opts.ws = local.wsEndpoint;
    }
    process.env.BROWSER_WS_ENDPOINT = opts.ws;
    const render = serverRequire('./services/appStudioRender.js');
    const { PNG } = serverRequire('pngjs');

    let manifest = null;
    if (opts.mode === 'compare') {
        const file = path.join(opts.baseline, 'manifest.json');
        if (!fs.existsSync(file)) throw new Error(`${opts.baseline} holds no baseline (manifest.json)`);
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    }

    const failures = [];
    const failedKeys = new Set();
    const differences = [];
    try {
        await pool(jobs, opts.concurrency, async (job, i) => {
            let shot;
            try {
                shot = await renderJob(render, job, byName.get(job.name), bundle);
            } catch (err) {
                failures.push(String(err && err.message ? err.message : err));
                failedKeys.add(job.key);
                return;
            }
            const target = path.join(opts.baseline, job.key);
            if (opts.mode === 'write') {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, shot.png);
            } else if (!fs.existsSync(target)) {
                if (manifest.keys.includes(job.key)) differences.push(`${job.key}: listed in the baseline, but its file is gone`);
            } else {
                const base = PNG.sync.read(fs.readFileSync(target));
                const now = PNG.sync.read(shot.png);
                const d = diffPixels(base, now, opts.tolerance);
                if (!d.sameSize) {
                    differences.push(`${job.key}: size ${base.width}x${base.height} -> ${now.width}x${now.height}`);
                } else if (d.differing > 0) {
                    differences.push(`${job.key}: ${d.differing} of ${d.total} pixels differ`);
                    if (opts.diff) {
                        const img = new PNG({ width: base.width, height: base.height });
                        diffImageData(base, d.mask).copy(img.data);
                        const out = path.join(opts.diff, job.key);
                        fs.mkdirSync(path.dirname(out), { recursive: true });
                        fs.writeFileSync(out, PNG.sync.write(img));
                    }
                }
            }
            if ((i + 1) % 25 === 0) log(`${i + 1} of ${jobs.length} rendered`);
        });
    } finally {
        if (local) await local.close();
    }

    // A screenshot that failed to render is reported as FAILED, not written or compared.
    const keys = jobs.map((j) => j.key).filter((k) => !failedKeys.has(k));
    if (opts.mode === 'write') {
        fs.mkdirSync(opts.baseline, { recursive: true });
        fs.writeFileSync(path.join(opts.baseline, 'manifest.json'), `${JSON.stringify({ written: new Date().toISOString(), bundleSha256: bundleSha, only: opts.only, keys }, null, 2)}\n`);
        log(`wrote ${jobs.length - failures.length} screenshots to ${opts.baseline}`);
    } else {
        const { missing, added } = compareKeySets(opts.only ? manifest.keys.filter((k) => opts.only.includes(k.split('/')[0])) : manifest.keys, keys);
        for (const k of missing) differences.push(`${k}: not in the baseline`);
        for (const k of added) differences.push(`${k}: in the baseline, not rendered now`);
        if (manifest.bundleSha256 === bundleSha) log('note: the bundle is byte-identical to the baseline\'s');
        differences.sort();
        for (const line of differences) log(`DIFF ${line}`);
        log(`${jobs.length} screenshots compared, ${differences.length} differ`);
    }
    for (const line of failures) log(`FAILED ${line}`);
    return failures.length || differences.length ? 1 : 0;
}

export async function main(argv = process.argv.slice(2), { log = (s) => process.stdout.write(`${s}\n`), env = process.env } = {}) {
    const opts = parseArgs(argv, env);
    if (opts.error) {
        process.stderr.write(`app-compat-pixels: ${opts.error}\n${USAGE}\n`);
        return 2;
    }
    try {
        return await run(opts, log);
    } catch (err) {
        process.stderr.write(`app-compat-pixels: ${err && err.message ? err.message : err}\n`);
        return 2;
    }
}

if (isEntryPoint(import.meta.url)) {
    main().then((code) => process.exit(code));
}

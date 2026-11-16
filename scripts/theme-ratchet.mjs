#!/usr/bin/env node
/**
 * Theme ratchets for agent-hub: colours and theme variables that bypass the theme, counted so they can only go down.
 *
 * The admin dashboard is drawn from theme variables (index.css, themes.css): --accent-primary with its
 * --accent-primary-fg, the --text-* hierarchy, --border-default, --success / --warning / --error and their -ink
 * variants. Every literal colour or wrong token next to them breaks one theme or another (white on the grey default
 * accent measures 2.54:1; a Tailwind green ignores the light and glass themes). These metrics freeze today's count so
 * the sweep can lower it and nothing adds to it in the meantime. Same contract as scripts/count-ratchet.mjs: the
 * budget is <package>/.<metric>-ratchet.json, a rise fails, `--update` only lowers.
 *
 * Metrics (all read with comments blanked; tests are never counted):
 *   admin-palette      Tailwind palette colour classes (`bg-green-500`, `hover:text-red-400`, `from-blue-600`, ...
 *                      on bg|text|border|ring|from|to|via|accent|fill|stroke with a palette hue and a shade) and
 *                      colour literals (`#10b981`, `rgb(…)`, `rgba(…)`) in the admin-dashboard directories
 *                      (ADMIN_DIRS). A colour given to an SVG paint attribute (fill=, stroke=, stopColor=, ...)
 *                      is not counted: that is where the inline brand logos (Microsoft, Google, the integration
 *                      tiles) keep their owner's colours, and a brand colour is not a theme decision.
 *                      The target is a theme variable: `text-[var(--success-ink)]`, CHIP_* / ALERT_* from
 *                      components/mcpLibrary/ui.ts, statusTone from shared/statusTone.ts.
 *   accent-text-white  `text-white` in the same class list as `var(--accent-primary)`: a className attribute, or
 *                      a string literal outside one (a PRIMARY_BUTTON constant). The target is
 *                      `text-[var(--accent-primary-fg)]`, or the shared Button / SAVE_BUTTON / PRIMARY_BTN.
 *   bare-text-token    bare `text-primary`, `text-secondary` and `text-muted` classes, which no utility generates
 *                      (the hierarchy is lost), and `var(--border-color)`, which only the App Studio runtime
 *                      defines, under src/. The target is `text-[var(--text-primary)]` (and -secondary, -muted)
 *                      and `var(--border-default)`.
 *   undefined-css-var  `var(--x)` (with or without a fallback) in a source file under agent-hub/src whose --x no
 *                      CSS file under src/ declares and no source file sets at runtime (a `'--x':` style key,
 *                      `setProperty('--x'`, a Tailwind `[--x:…]` class, `--x:` inside a CSS string). With no
 *                      declaration the property is invalid at computed time, and with a fallback the theme never
 *                      reaches it. Tailwind's own variables are allowed (TAILWIND_VARS). Uses inside .css files are
 *                      not counted: there they are optional hooks a design setting may fill.
 *
 * Usage:
 *   node scripts/theme-ratchet.mjs <metric> agent-hub            gate
 *   node scripts/theme-ratchet.mjs <metric> agent-hub --update   lower the budget
 *   node scripts/theme-ratchet.mjs <metric> agent-hub --list     per-file counts, highest first
 *
 * The reading is lexical, not a parser: a quoted string ends at its line end, and a regex literal holding a quote
 * or `//` can blank or keep a little too much of its line. Deterministic either way, so the count is stable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';
import { gateBudget } from './ratchet-budget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.test\.[jt]sx?$|(^|\/)__tests__\//;
const SOURCE_FILE = /\.[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite']);

/** The admin dashboard's directories, relative to agent-hub/src. */
export const ADMIN_DIRS = [
    'components/admin/', 'components/agents/', 'components/integrations/', 'components/licensing/',
    'components/appearance/', 'components/support/', 'components/meetings/', 'components/mcpLibrary/',
    'components/mcpAccess/', 'pages/settings/',
];

// ── Lexing ────────────────────────────────────────────────────────────

/**
 * Split source into code, string and comment spans (start inclusive, end exclusive).
 * A template literal is one string span, its `${…}` expressions included.
 * @param {string} text
 * @param {{ css?: boolean }} [opts] css: only block comments exist, `//` is code (a URL)
 * @returns {Array<{ kind: 'code' | 'string' | 'comment', start: number, end: number }>}
 */
export function lex(text, opts = {}) {
    const spans = [];
    const n = text.length;
    let codeStart = 0;
    let i = 0;
    const push = (kind, start, end) => {
        if (codeStart < start) spans.push({ kind: 'code', start: codeStart, end: start });
        spans.push({ kind, start, end });
        codeStart = end;
    };
    const quoted = (from, q) => {
        let k = from + 1;
        while (k < n && text[k] !== q && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1;
        return Math.min(n, text[k] === q ? k + 1 : k);
    };
    const template = (from) => {
        let k = from + 1;
        while (k < n) {
            const c = text[k];
            if (c === '\\') { k += 2; continue; }
            if (c === '`') return k + 1;
            if (c === '$' && text[k + 1] === '{') {
                let depth = 1;
                k += 2;
                while (k < n && depth > 0) {
                    const d = text[k];
                    if (d === '\'' || d === '"') k = quoted(k, d);
                    else if (d === '`') k = template(k);
                    else { if (d === '{') depth++; else if (d === '}') depth--; k++; }
                }
                continue;
            }
            k++;
        }
        return n;
    };
    while (i < n) {
        const c = text[i];
        const next = text[i + 1];
        if (c === '/' && next === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end < 0 ? n : end + 2;
            push('comment', i, stop);
            i = stop;
        } else if (!opts.css && c === '/' && next === '/') {
            const end = text.indexOf('\n', i);
            const stop = end < 0 ? n : end;
            push('comment', i, stop);
            i = stop;
        } else if (c === '\'' || c === '"') {
            const stop = quoted(i, c);
            push('string', i, stop);
            i = stop;
        } else if (!opts.css && c === '`') {
            const stop = template(i);
            push('string', i, stop);
            i = stop;
        } else i++;
    }
    if (codeStart < n) spans.push({ kind: 'code', start: codeStart, end: n });
    return spans;
}

/** The text with every comment blanked to spaces (newlines kept). */
export function withoutComments(text, opts = {}) {
    let out = '';
    for (const s of lex(text, opts)) {
        const part = text.slice(s.start, s.end);
        out += s.kind === 'comment' ? part.replace(/[^\n]/g, ' ') : part;
    }
    return out;
}

// ── admin-palette ─────────────────────────────────────────────────────

const PALETTE_HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';
const PALETTE_CLASS = new RegExp(`(?<![\\w-])(?:bg|text|border|ring|from|to|via|accent|fill|stroke)-(?:${PALETTE_HUES})-\\d+(?![\\w-])`, 'g');
const HEX_COLOUR = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const RGB_COLOUR = /(?<![\w-])rgba?\s*\(/g;

// An SVG paint attribute in JSX: `fill="#f35325"`, `stopColor='#9B4AB0'`, `stroke={'#fff'}`.
const SVG_PAINT = /(?<![\w-])(?:fill|stroke|stopColor|stop-color|floodColor|flood-color|lightingColor|lighting-color)\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|\{\s*(['"`])[^'"`\n]*\1\s*\})/g;

/** Palette classes plus colour literals in a source file (SVG paint attributes left out: brand logos). */
export function countPalette(text) {
    const code = withoutComments(text).replace(SVG_PAINT, ' ');
    return (code.match(PALETTE_CLASS) || []).length + (code.match(HEX_COLOUR) || []).length + (code.match(RGB_COLOUR) || []).length;
}

export const inAdminScope = (rel) => ADMIN_DIRS.some((d) => rel.startsWith(d));

// ── accent-text-white ─────────────────────────────────────────────────

const ACCENT = /var\(\s*--accent-primary\s*\)/;
const TEXT_WHITE = /(?<![\w-])text-white(?![\w-])/g;
const CLASS_ATTR = /\bclassName\s*=\s*/g;

/** End index of the className value that starts at `at` (a quoted string or a balanced `{…}`), or -1. */
function attrValueEnd(code, at) {
    const c = code[at];
    if (c === '"' || c === '\'') {
        const end = code.indexOf(c, at + 1);
        return end < 0 ? -1 : end + 1;
    }
    if (c !== '{') return -1;
    let depth = 0;
    for (let k = at; k < code.length; k++) {
        if (code[k] === '{') depth++;
        else if (code[k] === '}' && --depth === 0) return k + 1;
    }
    return -1;
}

/**
 * `text-white` in a class list that also paints `var(--accent-primary)`. A class list is a className attribute's
 * value, or a string literal outside any className attribute (a class constant, a cn() argument).
 */
export function countAccentTextWhite(text) {
    const code = withoutComments(text);
    if (!ACCENT.test(code) || !TEXT_WHITE.test(code)) return 0;
    TEXT_WHITE.lastIndex = 0;
    const attrs = [];
    for (const m of code.matchAll(CLASS_ATTR)) {
        const start = m.index + m[0].length;
        if (attrs.length && start < attrs[attrs.length - 1][1]) continue; // a className inside another one's value
        const end = attrValueEnd(code, start);
        if (end > 0) attrs.push([start, end]);
    }
    // Both lists are in source order, so one pass tells which strings sit inside an attribute.
    const units = [...attrs];
    let k = 0;
    for (const s of lex(code)) {
        if (s.kind !== 'string') continue;
        while (k < attrs.length && attrs[k][1] <= s.start) k++;
        if (!(k < attrs.length && s.start >= attrs[k][0] && s.end <= attrs[k][1])) units.push([s.start, s.end]);
    }
    let n = 0;
    for (const [a, b] of units) {
        const unit = code.slice(a, b);
        if (ACCENT.test(unit)) n += (unit.match(TEXT_WHITE) || []).length;
    }
    return n;
}

// ── bare-text-token ───────────────────────────────────────────────────

const BARE_TEXT = /(?<![\w\-[])text-(?:primary|secondary|muted)(?![\w-])/g;
const BORDER_COLOR_VAR = /var\(\s*--border-color(?![\w-])/g;

export function countBareTokens(text) {
    const code = withoutComments(text);
    return (code.match(BARE_TEXT) || []).length + (code.match(BORDER_COLOR_VAR) || []).length;
}

// ── undefined-css-var ─────────────────────────────────────────────────

const CSS_DECLARATION = /(?<![\w-])--([A-Za-z_][\w-]*)\s*:/g;
const VAR_USE = /var\(\s*--([A-Za-z_][\w-]*)\s*[,)]/g;
// Set at runtime from a source file: a style key or a CSS string (`'--x': v`, `--x: 4px` in cssText or a
// Tailwind `[--x:…]` class), a setProperty('--x', …) call, or a name in a list handed to one. A name read with
// getPropertyValue('--x') or dropped with removeProperty('--x') is not set by that call.
const RUNTIME_SETTERS = [
    /(?<![\w-])--([A-Za-z_][\w-]*)['"`]?\s*:/g,
    /setProperty\s*\(\s*['"`]--([A-Za-z_][\w-]*)/g,
    /(?<!(?:getPropertyValue|removeProperty)\s*\(\s*)['"`]--([A-Za-z_][\w-]*)['"`]\s*[,)\]]/g,
];
/** Variables Tailwind itself emits (its internals and the default theme), allowed although src/ CSS never declares them. */
export const TAILWIND_VARS = new RegExp(`^(?:tw-[\\w-]+|color-(?:${PALETTE_HUES}|black|white)(?:-\\d+)?|spacing|font-(?:sans|serif|mono)|default-[\\w-]+)$`);

/**
 * The variable names src/ defines: declared in a CSS file, or set at runtime from a non-test source file.
 * @param {Array<{ rel: string, text: string }>} cssFiles
 * @param {Array<{ rel: string, text: string }>} sourceFiles
 */
export function definedVars(cssFiles, sourceFiles) {
    const names = new Set();
    for (const { text } of cssFiles) {
        for (const m of withoutComments(text, { css: true }).matchAll(CSS_DECLARATION)) names.add(m[1]);
    }
    for (const { rel, text } of sourceFiles) {
        if (TEST_FILE.test(rel)) continue;
        const code = withoutComments(text);
        for (const re of RUNTIME_SETTERS) for (const m of code.matchAll(re)) names.add(m[1]);
    }
    return names;
}

/** Uses of a variable that is neither defined (see definedVars) nor Tailwind's own. */
export function countUndefinedVars(text, defined) {
    let n = 0;
    for (const m of withoutComments(text).matchAll(VAR_USE)) {
        if (!defined.has(m[1]) && !TAILWIND_VARS.test(m[1])) n++;
    }
    return n;
}

// ── Metrics ───────────────────────────────────────────────────────────

export const METRICS = {
    'admin-palette': {
        include: inAdminScope,
        measure: (text) => countPalette(text),
        what: 'Tailwind palette colour classes and colour literals',
        where: 'in the admin-dashboard directories of agent-hub/src',
        advice: 'use a theme variable (text-[var(--success-ink)], bg-[var(--bg-tertiary)]), CHIP_* / ALERT_* from components/mcpLibrary/ui.ts or statusTone from shared/statusTone.ts',
    },
    'accent-text-white': {
        include: () => true,
        measure: (text) => countAccentTextWhite(text),
        what: 'text-white classes on var(--accent-primary)',
        where: 'under agent-hub/src',
        advice: 'use text-[var(--accent-primary-fg)] (the accent can be light grey or yellow), or the shared Button / SAVE_BUTTON / PRIMARY_BTN',
    },
    'bare-text-token': {
        include: () => true,
        measure: (text) => countBareTokens(text),
        what: 'bare text-primary/-secondary/-muted classes and var(--border-color) uses',
        where: 'under agent-hub/src',
        advice: 'write text-[var(--text-primary)] (or --text-secondary, --text-muted) and var(--border-default)',
    },
    'undefined-css-var': {
        include: () => true,
        measure: (text, ctx) => countUndefinedVars(text, ctx.defined),
        what: 'var(--x) uses of a variable that no CSS file declares and no code sets',
        where: 'under agent-hub/src',
        advice: 'use a variable index.css or themes.css declares (var(--border-default), var(--error-ink), ...), or declare the new one there for every theme',
    },
};

function collect(from, base, into) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const full = path.join(from, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collect(full, base, into);
        } else if (entry.isFile()) {
            into.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
        }
    }
    return into;
}

/**
 * Measure one metric over <pkgDir>/src.
 * @returns {{ count: number, rows: Array<[number, string]> }}
 */
export function measure(metricName, pkgDir) {
    const metric = METRICS[metricName];
    const srcDir = path.join(pkgDir, 'src');
    const files = collect(srcDir, srcDir, []);
    const read = (f) => ({ rel: f.rel, text: fs.readFileSync(f.full, 'utf8') });
    const sources = files.filter((f) => SOURCE_FILE.test(f.rel)).map(read);
    const ctx = {};
    if (metricName === 'undefined-css-var') ctx.defined = definedVars(files.filter((f) => f.rel.endsWith('.css')).map(read), sources);
    const rows = [];
    let count = 0;
    for (const { rel, text } of sources) {
        if (TEST_FILE.test(rel) || rel.endsWith('.d.ts') || !metric.include(rel)) continue;
        const n = metric.measure(text, ctx);
        if (n === 0) continue;
        count += n;
        rows.push([n, `src/${rel}`]);
    }
    return { count, rows };
}

function main() {
    const args = process.argv.slice(2);
    const [metricName, pkg] = args.filter((a) => !a.startsWith('--'));
    const metric = METRICS[metricName];
    if (!metric || !pkg) {
        console.error(`theme-ratchet: usage: node scripts/theme-ratchet.mjs <${Object.keys(METRICS).join('|')}> <package> [--update] [--list]`);
        process.exit(2);
    }
    const pkgDir = path.resolve(ROOT, pkg);
    if (!fs.existsSync(path.join(pkgDir, 'src'))) {
        console.error(`theme-ratchet: ${pkg}/src not found — is "${pkg}" a package with a src/ directory?`);
        process.exit(2);
    }
    const { count, rows } = measure(metricName, pkgDir);
    process.exit(gateBudget({
        root: ROOT,
        budgetFile: path.join(pkgDir, `.${metricName}-ratchet.json`),
        count,
        rows,
        label: pkg,
        what: metric.what,
        where: metric.where,
        advice: metric.advice,
        command: `node scripts/theme-ratchet.mjs ${metricName} ${pkg}`,
        update: args.includes('--update'),
        list: args.includes('--list'),
    }));
}

if (isEntryPoint(import.meta.url)) main();

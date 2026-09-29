/**
 * List the test files whose transitive import closure never touches the DOM,
 * i.e. the candidates for `// @vitest-environment node` on line 1.
 *
 * This is a TOOL, not a check. Run it by hand when you want to review the set:
 *
 *     node scripts/find-dom-free-tests.mjs
 *
 * It is the classifier that produced the ~181-file set the pragmas were
 * applied to, committed so that set can be REGENERATED and reviewed rather
 * than trusted. It always exits 0.
 *
 * NEVER wire this into CI as pass/fail. It is a heuristic: it answers
 * "does anything in this file's import closure mention a DOM identifier",
 * which over-reports (6 of the 11 files that have run fine under node since
 * 71f64c7 are classified DOM-requiring by it). A false positive that fails a
 * build is worse than a slow test. The real check is the suite itself — a
 * file that carries the pragma and touches the DOM fails on the spot with
 * `ReferenceError: window is not defined`.
 *
 * Bias: anything unresolved, unknown or unreadable counts as DOM-REQUIRING.
 * Keep it that way. The cost of a miss is a slow test; the cost of a false
 * DOM-free is a red suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(p, out); }
        else out.push(p);
    }
    return out;
}
const allFiles = walk(SRC);
const testFiles = allFiles.filter(f => /\.test\.(js|jsx|ts|tsx)$/.test(f));

const EXTS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json',
    '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];

function resolveSpec(spec, fromFile) {
    let base;
    if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
    else if (spec.startsWith('@shared/')) base = path.join(SRC, 'shared', spec.slice('@shared/'.length));
    else if (spec === '@shared') base = path.join(SRC, 'shared');
    else if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
    else return null; // bare package
    for (const ext of EXTS) {
        const cand = base + ext;
        try { if (fs.statSync(cand).isFile()) return cand; } catch { /* keep probing */ }
    }
    return { unresolved: base };
}

// DOM-global regex. Conservative: word-boundary matches on identifiers.
const DOM_RE = new RegExp([
    '\\bwindow\\b', '\\bdocument\\b', '\\bnavigator\\b', '\\blocalStorage\\b',
    '\\bsessionStorage\\b', '\\bmatchMedia\\b', '\\bgetComputedStyle\\b',
    '\\brequestAnimationFrame\\b', '\\bcancelAnimationFrame\\b',
    '\\bHTML[A-Z]\\w*Element\\b', '\\bElement\\b', '\\bNode\\b', '\\bDocument\\b',
    '\\bMutationObserver\\b', '\\bResizeObserver\\b', '\\bIntersectionObserver\\b',
    '\\bDOMParser\\b', '\\bXMLHttpRequest\\b', '\\bCustomEvent\\b', '\\bblob:\\b',
    '\\bcreateObjectURL\\b', '\\bFileReader\\b', '\\bImage\\b', '\\bCanvas\\b',
    '\\bscrollIntoView\\b', '\\bhistory\\.', '\\blocation\\b', '\\bcreatePortal\\b',
    '\\bgetBoundingClientRect\\b', '\\bClipboard\\b', '\\bSVGElement\\b',
    '\\bcrypto\\.subtle\\b', '\\bBroadcastChannel\\b', '\\bcaches\\b', '\\bWorker\\b',
].join('|'));

// Bare packages that are DOM-requiring.
const DOM_PKGS = [
    '@testing-library/react', '@testing-library/dom', '@testing-library/user-event',
    '@testing-library/jest-dom', 'react-dom', 'react-dom/client', 'react-dom/test-utils',
    '@xyflow/react', 'recharts', 'mermaid', '@monaco-editor/react', 'react-grid-layout',
    'emoji-picker-react', 'react-markdown', 'msw/browser', '@dnd-kit/core',
    '@dnd-kit/sortable', 'vega', 'vega-embed', 'vega-lite', 'katex', 'highlight.js',
    'jszip', '@tanstack/react-virtual', '@openobserve/browser-logs', '@openobserve/browser-rum',
    '@serenity-kit/opaque', 'esbuild-wasm', 'web-vitals', 'lucide-react', '@tanstack/react-table',
];
// Bare packages considered node-safe.
const SAFE_PKGS = new Set([
    'vitest', 'react', 'react/jsx-runtime', 'uuid', '@tanstack/react-query',
    'd3-geo', 'topojson-client', '@emoji-mart/data', 'remark-gfm', 'remark-math', 'rehype-katex',
]);

function isSafeBare(spec) {
    if (spec.startsWith('node:')) return true;
    if (SAFE_PKGS.has(spec)) return true;
    return false;
}

const importRe = /(?:^|[^\w.])(?:import\s+(?:[\s\S]*?)\s+from\s*|import\s*|export\s+(?:\*|\{[\s\S]*?\})\s*from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const dynImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Remove comments AND string/template literals before the identifier scan.
 *
 * This helper is load-bearing, not tidiness: without it the ordinary English
 * word "document" inside UI copy — i18n/en-defaults.js ("Upload a document…")
 * and flow/nodeDefs.js — reads as the DOM global `document` and misclassifies
 * 42 otherwise DOM-free files as DOM-requiring. Same for "Image", "location",
 * "Element" and friends in prose. Strings are replaced with `""` so the
 * surrounding syntax stays intact.
 */
function strip(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];
        if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
        if (c === '"' || c === "'" || c === '`') {
            const q = c; i++;
            while (i < n) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === q) { i++; break; }
                i++;
            }
            out += '""';
            continue;
        }
        out += c; i++;
    }
    return out;
}

const cache = new Map();

function analyzeFile(file, seen) {
    if (cache.has(file)) return cache.get(file);
    if (seen.has(file)) return { dom: false, reasons: [] }; // cycle
    seen.add(file);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { return { dom: true, reasons: ['unreadable:' + file] }; }
    const reasons = [];
    const code = strip(src);
    if (DOM_RE.test(code)) {
        reasons.push(`domglobal:${file}:${(code.match(DOM_RE) || [])[0]}`);
    }
    const specs = new Set();
    let m;
    importRe.lastIndex = 0;
    while ((m = importRe.exec(src))) specs.add(m[1]);
    dynImportRe.lastIndex = 0;
    while ((m = dynImportRe.exec(src))) specs.add(m[1]);
    for (const spec of specs) {
        // A CSS import needs a DOM (and a vite transform) whatever it contains.
        if (spec.endsWith('.css') || spec.endsWith('.scss')) { reasons.push(`css:${spec}`); continue; }
        const r = resolveSpec(spec, file);
        if (r === null) {
            if (isSafeBare(spec)) continue;
            if (DOM_PKGS.some(p => spec === p || spec.startsWith(p + '/'))) { reasons.push(`dompkg:${spec}@${file}`); continue; }
            // Unknown package: conservative, counts as DOM-requiring.
            reasons.push(`unknownpkg:${spec}@${file}`);
            continue;
        }
        if (r.unresolved) { reasons.push(`unresolved:${spec}@${file}`); continue; }
        const sub = analyzeFile(r, seen);
        if (sub.dom) reasons.push(...sub.reasons.slice(0, 2));
    }
    const res = { dom: reasons.length > 0, reasons };
    cache.set(file, res);
    return res;
}

const results = [];
for (const t of testFiles) {
    cache.clear();
    const r = analyzeFile(t, new Set());
    results.push({ file: path.relative(ROOT, t), dom: r.dom, reasons: r.reasons.slice(0, 3) });
}
const free = results.filter(r => !r.dom);
console.log(`total test files: ${results.length}`);
console.log(`DOM-free (conservative): ${free.length}`);
console.log('');
for (const f of free) console.log(f.file);

// Always succeed. See the header: a heuristic must never fail a build.
process.exit(0);

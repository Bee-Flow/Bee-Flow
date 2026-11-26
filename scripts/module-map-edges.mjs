#!/usr/bin/env node
/**
 * The run-time import edges of a source tree, for the ownership map (scripts/module-map.mjs).
 *
 * An edge is a relative specifier a file loads when it runs: `require('..')`,
 * `nodeRequire('..')` (and any name bound by `const x = createRequire(...)`),
 * `createRequire(...)('..')`, `import ... from '..'`, `export ... from '..'`, `import '..'` and
 * `import('..')` with a string literal, lazy ones inside a function body included.
 * Type-only references are NOT edges: `import type` / `export type`, an import whose every
 * specifier is `type X`, `typeof import('..')`, `import('..').T` in a type position, anything
 * inside a comment (JSDoc `@type {import('..').T}`), and every `.d.ts` file. Comments, strings,
 * template literals and regular expression literals are masked by a small lexer first, so a
 * specifier-shaped text in a string or a comment never counts.
 *
 * Each edge says whether it is lazy (inside a function body, or the body of an arrow function
 * without braces) or top-level; `if (x) { require() }` at the top of a file is top-level.
 * Specifiers resolve like Node does: the exact path, the extensions .js .cjs .mjs .mts .cts
 * .json, a directory index, and a `.js` / `.mjs` / `.cjs` specifier that lands on the
 * TypeScript twin (.mts / .cts). A specifier that leaves the tree or matches no file is dropped.
 *
 *   import { scanSource, importEdges } from './module-map-edges.mjs'
 *   node scripts/module-map-edges.mjs <file>   print the edges one file declares (debugging)
 */

import fs from 'node:fs';
import path from 'node:path';
import { isEntryPoint } from './entry-point.mjs';

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
const REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^';
const BLOCK_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/**
 * Mask comments, string, template and regex contents with spaces (newlines kept), and
 * remember every plain string literal by the index of its opening quote.
 * @param {string} src
 * @returns {{ code: string, strings: Map<number, { value: string, end: number }> }}
 */
export function maskSource(src) {
    const out = src.split('');
    const strings = new Map();
    const stack = []; // 'b' for a brace, 't' for a `${` inside a template
    const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
    let i = 0;
    let prev = ''; // the last significant code character or word
    const readTemplate = (start) => {
        // from just after a backtick or a closing `}` of `${`; returns the index after the stop
        let j = start;
        while (j < src.length) {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === '`') return { stop: j + 1, opened: false };
            if (src[j] === '$' && src[j + 1] === '{') return { stop: j + 2, opened: true };
            j++;
        }
        return { stop: j, opened: false };
    };
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (c === '/' && n === '/') {
            const e = src.indexOf('\n', i);
            const end = e === -1 ? src.length : e;
            blank(i, end); i = end; continue;
        }
        if (c === '/' && n === '*') {
            const e = src.indexOf('*/', i + 2);
            const end = e === -1 ? src.length : e + 2;
            blank(i, end); i = end; continue;
        }
        if (c === '\'' || c === '"') {
            let j = i + 1;
            let value = '';
            while (j < src.length && src[j] !== c && src[j] !== '\n') {
                if (src[j] === '\\') { value += src[j + 1] ?? ''; j += 2; continue; }
                value += src[j]; j++;
            }
            strings.set(i, { value, end: j + 1 });
            blank(i + 1, j); i = j + 1; prev = 'str'; continue;
        }
        if (c === '`' || (c === '}' && stack[stack.length - 1] === 't')) {
            if (c === '}') stack.pop();
            const { stop, opened } = readTemplate(i + 1);
            const bodyEnd = opened ? stop - 2 : stop - 1;
            if (c === '`' && !opened) strings.set(i, { value: src.slice(i + 1, bodyEnd), end: stop });
            blank(i + 1, bodyEnd);
            if (opened) stack.push('t');
            i = stop; prev = opened ? '{' : 'str'; continue;
        }
        if (c === '/' && (prev === '' || REGEX_AFTER.includes(prev) || KEYWORDS_BEFORE_REGEX.has(prev))) {
            let j = i + 1;
            let inClass = false;
            while (j < src.length && src[j] !== '\n') {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === '[') inClass = true;
                else if (src[j] === ']') inClass = false;
                else if (src[j] === '/' && !inClass) break;
                j++;
            }
            blank(i + 1, j); i = j + 1; prev = 're'; continue;
        }
        if (c === '{') stack.push('b');
        else if (c === '}') stack.pop();
        if (/[\w$]/.test(c)) {
            let j = i;
            while (j < src.length && /[\w$]/.test(src[j])) j++;
            prev = src.slice(i, j); i = j; continue;
        }
        if (!/\s/.test(c)) prev = c;
        i++;
    }
    return { code: out.join(''), strings };
}

/**
 * Is the brace at `at` (in masked code) a function body?
 * @param {string} code
 * @param {number} at
 */
function opensFunction(code, at) {
    let k = at - 1;
    while (k >= 0 && /\s/.test(code[k])) k--;
    if (code[k] === '>' && code[k - 1] === '=') return true;
    if (code[k] !== ')') return false;
    let depth = 0;
    for (; k >= 0; k--) {
        if (code[k] === ')') depth++;
        else if (code[k] === '(' && --depth === 0) break;
    }
    let w = k - 1;
    while (w >= 0 && /\s/.test(code[w])) w--;
    let s = w;
    while (s >= 0 && /[\w$]/.test(code[s])) s--;
    return !BLOCK_WORDS.has(code.slice(s + 1, w + 1));
}

/**
 * For each index (ascending), is it inside a function body?
 * @param {string} code
 * @param {number[]} indices
 */
function lazyAt(code, indices) {
    const result = new Map();
    const stack = [];
    let fnDepth = 0;
    let next = 0;
    for (let i = 0; i <= code.length && next < indices.length; i++) {
        while (next < indices.length && indices[next] === i) {
            const stmtStart = Math.max(code.lastIndexOf(';', i), code.lastIndexOf('{', i), code.lastIndexOf('}', i));
            result.set(i, fnDepth > 0 || code.slice(stmtStart + 1, i).includes('=>'));
            next++;
        }
        if (code[i] === '{') {
            const fn = opensFunction(code, i);
            stack.push(fn);
            if (fn) fnDepth++;
        } else if (code[i] === '}' && stack.length && stack.pop()) fnDepth--;
    }
    return result;
}

const TYPE_MEMBER_AFTER = /^\s*\.\s*(?!then\b|catch\b|finally\b)[\w$]/;

/**
 * The relative specifiers a source file loads at run time.
 * @param {string} src
 * @returns {{ spec: string, line: number, lazy: boolean }[]}
 */
export function scanSource(src) {
    const { code, strings } = maskSource(src);
    const names = ['require', 'nodeRequire'];
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*createRequire\s*\(/g)) names.push(m[1]);
    /** @type {{ quote: number, kind: string, at: number }[]} */
    const hits = [];
    const add = (m, kind) => hits.push({ quote: m.index + m[0].length - 1, kind, at: m.index });
    for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(?:${names.join('|')})\\s*\\(\\s*['"\`]`, 'g'))) add(m, 'call');
    for (const m of code.matchAll(/(?<![\w$.])createRequire\s*\((?:[^()]|\([^()]*\))*\)\s*\(\s*['"`]/g)) add(m, 'call');
    for (const m of code.matchAll(/(?<![\w$.])import\s*\(\s*['"`]/g)) add(m, 'dynamic');
    for (const m of code.matchAll(/(?<![\w$.])(?:import|export)\s+(?!type\s)[\w$*{},\s]*?\bfrom\s*['"]/g)) add(m, 'static');
    for (const m of code.matchAll(/(?<![\w$.])import\s*['"]/g)) add(m, 'static');
    const lineStarts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
    const lineOf = (index) => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1; }
        return lo + 1;
    };
    const kept = hits.filter((h) => isRuntime(h, code, strings));
    const lazy = lazyAt(code, [...new Set(kept.map((h) => h.at))].sort((a, b) => a - b));
    return kept.sort((a, b) => a.at - b.at).map((h) => ({ spec: strings.get(h.quote).value, line: lineOf(h.at), lazy: lazy.get(h.at) }));
}

/**
 * @param {{ quote: number, kind: string, at: number }} hit
 * @param {string} code
 * @param {Map<number, { value: string, end: number }>} strings
 */
function isRuntime(hit, code, strings) {
    const lit = strings.get(hit.quote);
    if (!lit || !lit.value.startsWith('.')) return false;
    if (hit.kind === 'static') {
        const braces = code.slice(hit.at, hit.quote).match(/\{([^}]*)\}/);
        const named = braces ? braces[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
        const bare = braces ? code.slice(hit.at, hit.quote).replace(braces[0], '') : '';
        const onlyTypes = named.length > 0 && named.every((s) => s.startsWith('type ')) && !/(?:import|export)\s+(?!from\b)[\w$*]/.test(bare);
        return !onlyTypes;
    }
    if (!/^\s*[),]/.test(code.slice(lit.end))) return false;
    if (hit.kind !== 'dynamic') return true;
    if (/\btypeof\s*$/.test(code.slice(Math.max(0, hit.at - 20), hit.at))) return false;
    const close = code.indexOf(')', lit.end);
    return !TYPE_MEMBER_AFTER.test(code.slice(close + 1, close + 40));
}

const EXT = ['.js', '.cjs', '.mjs', '.mts', '.cts', '.json'];
const TS_TWIN = { '.js': ['.mts', '.ts'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/**
 * Resolve a relative specifier from a tree path, like Node.
 * @param {string} from tree path of the importing file
 * @param {string} spec
 * @param {Set<string>} files every tree path
 * @returns {string | null}
 */
export function resolveSpecifier(from, spec, files) {
    const abs = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\/$/, '');
    if (abs === '..' || abs.startsWith('../')) return null;
    if (files.has(abs)) return abs;
    for (const e of EXT) if (files.has(abs + e)) return abs + e;
    for (const e of EXT) if (files.has(`${abs}/index${e}`)) return `${abs}/index${e}`;
    const ext = path.posix.extname(abs);
    for (const twin of TS_TWIN[ext] || []) {
        const t = abs.slice(0, -ext.length) + twin;
        if (files.has(t)) return t;
    }
    return null;
}

export const CODE_FILE = /\.(?:c|m)?js$|\.(?:c|m)?ts$/;
export const TYPE_FILE = /\.d\.(?:c|m)?ts$/;

/**
 * Every run-time edge between files of a tree.
 * @param {{ treePath: string, abs: string }[]} entries the files, with where they are on disk
 * @returns {{ from: string, to: string, line: number, lazy: boolean }[]}
 */
export function importEdges(entries) {
    const files = new Set(entries.map((e) => e.treePath));
    const edges = [];
    for (const { treePath, abs } of entries) {
        if (!CODE_FILE.test(treePath) || TYPE_FILE.test(treePath)) continue;
        let src;
        try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        for (const { spec, line, lazy } of scanSource(src)) {
            const to = resolveSpecifier(treePath, spec, files);
            if (to && to !== treePath) edges.push({ from: treePath, to, line, lazy });
        }
    }
    return edges;
}

if (isEntryPoint(import.meta.url)) {
    const file = process.argv[2];
    if (!file) { console.error('usage: node scripts/module-map-edges.mjs <file>'); process.exit(2); }
    for (const e of scanSource(fs.readFileSync(file, 'utf8'))) console.log(`${e.line}\t${e.lazy ? 'lazy' : 'top'}\t${e.spec}`);
}

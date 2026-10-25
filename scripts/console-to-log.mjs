#!/usr/bin/env node
/**
 * Codemod: console.* -> the package's structured logger.
 *
 *   node scripts/console-to-log.mjs <dir> [--log <file>] [--dry]
 *
 * <dir> is a source directory (nextcloud-connector/src). `--log` is the
 * logger module (default <dir>/log.js). In every .js/.cjs file but the logger
 * itself, each real `console.log|info|warn|error|debug(...)` call (found with
 * acorn, so strings, comments and templates are never touched) becomes
 * `log.info|warn|error|debug(...)` with the same arguments, and
 * `const log = require('<relative path to the logger>');` is added after the
 * last top-level require (or the 'use strict' line). The logger has console's
 * call shape, so nothing else changes.
 *
 * A file that already binds `log` for something else is skipped and reported.
 * `--dry` prints what would change. Output is a JSON report.
 *
 * acorn is resolved from the first installed of server/, nextcloud-connector/
 * and hub-module-sdk/ (eslint brings it in the last two).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METHOD = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };

export function loadAcorn() {
    for (const pkg of ['server', 'nextcloud-connector', 'hub-module-sdk']) {
        try {
            return createRequire(path.join(ROOT, pkg, 'package.json'))('acorn');
        } catch { /* try the next package */ }
    }
    return null;
}

function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const key of Object.keys(node)) {
        const v = node[key];
        if (Array.isArray(v)) v.forEach((c) => c && typeof c === 'object' && walk(c, visit));
        else if (v && typeof v === 'object') walk(v, visit);
    }
}

/** Names bound anywhere in the file that equal `log` (declarations, params, imports). */
function bindsLog(ast) {
    let found = false;
    walk(ast, (n) => {
        if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === 'log') found = true;
        if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')
            && n.params.some((p) => p.type === 'Identifier' && p.name === 'log')) found = true;
        if (n.type === 'FunctionDeclaration' && n.id?.name === 'log') found = true;
    });
    return found;
}

/**
 * @returns {{ code: string, calls: number, skipped?: string }}
 */
export function convertSource(acorn, code, { requirePath }) {
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    } catch (e) {
        return { code, calls: 0, skipped: `parse error: ${e.message}` };
    }
    const edits = [];
    walk(ast, (n) => {
        if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.computed) return;
        const { object, property } = n.callee;
        if (object.type !== 'Identifier' || object.name !== 'console' || property.type !== 'Identifier') return;
        const method = METHOD[property.name];
        if (!method) return;
        edits.push({ start: object.start, end: property.end, text: `log.${method}` });
    });
    if (edits.length === 0) return { code, calls: 0 };
    if (bindsLog(ast)) return { code, calls: 0, skipped: 'binds `log` already' };

    // Insert the require after the last top-level `const x = require(...)`, else after 'use strict'.
    let insertAt = 0;
    for (const stmt of ast.body) {
        const isDirective = stmt.type === 'ExpressionStatement' && stmt.directive;
        const isRequire = stmt.type === 'VariableDeclaration'
            && stmt.declarations.every((d) => d.init?.type === 'CallExpression' && d.init.callee.name === 'require');
        if (isDirective || isRequire) insertAt = stmt.end;
        else if (insertAt > 0 || stmt.type !== 'ExpressionStatement') break;
    }
    const line = `const log = require('${requirePath}');`;
    let out = code;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    // An edit before the insert point (a console call above the requires) moves it.
    const delta = edits.filter((e) => e.start < insertAt).reduce((d, e) => d + (e.text.length - (e.end - e.start)), 0);
    const at = insertAt + delta;
    const edited = out;
    const sep = insertAt === 0 ? '' : '\n';
    const after = insertAt === 0 ? '\n' : '';
    return { code: edited.slice(0, at) + sep + line + after + edited.slice(at), calls: edits.length };
}

function listFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : listFiles(p);
        return /\.c?js$/.test(e.name) ? [p] : [];
    });
}

function main() {
    const args = process.argv.slice(2);
    const dry = args.includes('--dry');
    const logAt = args.indexOf('--log');
    const dir = args.find((a, i) => !a.startsWith('--') && (logAt < 0 || i !== logAt + 1));
    if (!dir) {
        console.error('usage: node scripts/console-to-log.mjs <dir> [--log <file>] [--dry]');
        process.exit(2);
    }
    const acorn = loadAcorn();
    if (!acorn) {
        console.error('console-to-log: acorn is not installed. Run `npm ci` in server/ or nextcloud-connector/ first.');
        process.exit(2);
    }
    const base = path.resolve(dir);
    const logFile = path.resolve(logAt >= 0 ? args[logAt + 1] : path.join(base, 'log.js'));
    const report = { converted: [], skipped: [] };
    for (const file of listFiles(base)) {
        if (file === logFile) continue;
        let rel = path.relative(path.dirname(file), logFile).replace(/\.c?js$/, '');
        if (!rel.startsWith('.')) rel = `./${rel}`;
        const src = fs.readFileSync(file, 'utf8');
        const res = convertSource(acorn, src, { requirePath: rel });
        if (res.skipped) report.skipped.push({ file: path.relative(ROOT, file), reason: res.skipped });
        else if (res.calls > 0) {
            report.converted.push({ file: path.relative(ROOT, file), calls: res.calls });
            if (!dry) fs.writeFileSync(file, res.code);
        }
    }
    console.log(JSON.stringify({ dry, ...report }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

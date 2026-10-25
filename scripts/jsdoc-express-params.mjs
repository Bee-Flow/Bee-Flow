#!/usr/bin/env node
/**
 * Type the Express handler parameters that nothing types for us.
 *
 * A handler written inline in `router.get('/x', (req, res) => ...)` gets its parameter types
 * from @types/express. One passed by name, built by a factory or exported for a test does not:
 * `req`, `res` and `next` stay `any` and the file cannot move to the noImplicitAny level.
 * This finds those parameters from the compiler's own TS7006 diagnostics and writes the type
 * as an inline JSDoc comment on the parameter:
 *
 *   (req, res, next)        -> Request, Response, NextFunction
 *   (err, req, res, next)   -> Error, Request, Response, NextFunction
 *
 * The request already carries the server's own fields (user, session, orgId ...) through
 * server/types/express.d.ts. Only comments are added. An edit stays when it does not raise the
 * file's diagnostic count (checked in memory with the TypeScript 6 language service); the typecheck
 * of `npm run typecheck` has the last word.
 *
 *   node scripts/jsdoc-express-params.mjs --files server/a.js,server/b.js [--write]
 *   node scripts/jsdoc-express-params.mjs --batch list.txt [--write]
 * Prints one JSON object: edits kept and dropped per file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { insertAll, keepHarmless, openServer } from './lib/server-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.(?:test|spec)\.[cm]?js$|\.testkit\.|\.testutil\./;

/**
 * The Express type for parameter `name` at `index` of a function with `names` as parameters, or null.
 * @param {string} name
 * @param {string[]} names
 */
export function expressTypeFor(name, names) {
    const errorHandler = names.length === 4 && names[0] === 'err';
    if (name === 'err' && errorHandler) return 'Error';
    if (name === 'req' && (names.length >= 2 || errorHandler)) return "import('express').Request";
    if (name === 'res' && names.includes('req')) return "import('express').Response";
    if (name === 'next' && names.includes('req') && names.includes('res')) return "import('express').NextFunction";
    return null;
}

/** The inline comment inserted in front of a parameter. */
export const commentFor = (type) => `/** @type {${type}} */ `;

/**
 * Edits for one file: from each TS7006 on a parameter named req/res/next/err.
 * @param {ReturnType<typeof openServer>} project
 * @param {string} file absolute path
 */
export function planFile(project, file) {
    const { ts } = project;
    const sf = project.svc.service.getProgram().getSourceFile(file);
    const edits = [];
    for (const d of project.diagnostics(file)) {
        if (d.code !== 7006 || d.start === undefined) continue;
        let node = ts.getTokenAtPosition(sf, d.start);
        while (node && !ts.isParameter(node)) node = node.parent;
        if (!node || !ts.isIdentifier(node.name) || node.type) continue;
        const fn = node.parent;
        const names = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
        const type = expressTypeFor(node.name.text, names);
        if (!type) continue;
        // A JSDoc @param on the function for this name would already have typed it; nothing to do then.
        edits.push({ at: node.name.getStart(sf), text: commentFor(type) });
    }
    return edits;
}

export function run({ files, write = false, serverDir } = {}) {
    const abs = files.map((f) => path.resolve(ROOT, f)).filter((f) => !TEST_FILE.test(f));
    const project = openServer(abs, { serverDir });
    const report = [];
    for (const f of abs) {
        const edits = planFile(project, f);
        if (edits.length === 0) continue;
        const original = project.text(f);
        // The implicit-any errors are what the edits remove; every OTHER error may not rise.
        const count = (text) => { project.update(f, text); return project.diagnostics(f).filter((d) => d.code !== 7006).length; };
        const { kept, text } = keepHarmless(original, edits, count);
        project.update(f, text);
        if (write && kept.length) fs.writeFileSync(f, text);
        report.push({ file: path.relative(ROOT, f), planned: edits.length, kept: kept.length, dropped: edits.length - kept.length });
    }
    return report;
}

export { insertAll };

if (isEntryPoint(import.meta.url)) {
    const args = process.argv.slice(2);
    const val = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
    const files = val('--files') ? val('--files').split(',') : val('--batch') ? fs.readFileSync(val('--batch'), 'utf8').split('\n').filter(Boolean) : [];
    if (files.length === 0) {
        console.error('jsdoc-express-params: pass --files a,b or --batch list.txt');
        process.exit(2);
    }
    const report = run({ files, write: args.includes('--write') });
    const sum = (k) => report.reduce((n, r) => n + r[k], 0);
    console.log(JSON.stringify({ planned: sum('planned'), kept: sum('kept'), dropped: sum('dropped'), files: report }, null, 1));
}

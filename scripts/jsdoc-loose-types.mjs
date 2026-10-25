#!/usr/bin/env node
/**
 * Replace a server JSDoc parameter type that says nothing - {any}, {*}, {Object}, {object},
 * {Function} - with the type the checker infers from how the parameter is used and called.
 *
 * For each `@param {loose} name` tag of a function: the tag is taken out of the text in memory, the
 * parameter is then an implicit any, and TypeScript's own "infer parameter types from usage" quick fix
 * (TypeScript 6 language service) says what it would write. That type replaces the loose one when it is
 * concrete (no any, never, unknown, empty object or a lone null) and the file's diagnostics do not rise
 * at the file's own level. Comments only: the compiled program stays the same.
 *
 *   node scripts/jsdoc-loose-types.mjs --files server/a.js,server/b.js [--write]
 *   node scripts/jsdoc-loose-types.mjs --batch list.txt [--write]
 * Prints one JSON object: how many tags were seen, replaced and left per file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { levelOfText } from '../server/scripts/typecheck.mjs';
import { keepHarmless, openServer } from './lib/server-service.mjs';
import { forbiddenInsert } from './ts-convert-codefix.mjs';
import { forbiddenJsDoc, uselessQuickFix } from './jsdoc-convert-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOSE = /^\s*(?:any|\*|Function|Object|object)\s*$/;
const FORMAT = { indentSize: 4, tabSize: 4, convertTabsToSpaces: true, semicolons: 'insert' };
const PREFS = { quotePreference: 'single' };

/** A type text worth writing: concrete and short. */
export function concrete(type) {
    return Boolean(type) && type.length <= 140 && !forbiddenJsDoc(`{${type}}`) && !forbiddenInsert(type) && !uselessQuickFix(`{${type}}`) && !/\bunknown\b|\bobject\b|\bObject\b/.test(type);
}

/** The type in the `@param {T} name` a quick fix wrote, or null. */
export function typeInFix(newText, name) {
    const m = new RegExp(`@param\\s+\\{((?:[^{}]|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*)\\}\\s+\\[?${name}\\b`).exec(newText);
    return m ? m[1].trim() : null;
}

/** Every loose @param tag of the file: { name, typeStart, typeEnd, tagStart, tagEnd, fnStart }. */
export function looseTags(ts, sf) {
    const out = [];
    const visit = (n) => {
        if (ts.isFunctionLike(n) && n.parameters) {
            const docs = n.jsDoc ?? [];
            for (const doc of docs) {
                for (const tag of doc.tags ?? []) {
                    if (!ts.isJSDocParameterTag(tag) || !tag.typeExpression || tag.isBracketed) continue;
                    const name = tag.name.getText(sf);
                    if (name.includes('.')) continue;
                    const inner = tag.typeExpression.type.getText(sf);
                    if (!LOOSE.test(inner)) continue;
                    if (!n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) continue;
                    out.push({ name, typeStart: tag.typeExpression.type.getStart(sf), typeEnd: tag.typeExpression.type.getEnd(), tagStart: tag.getStart(sf), tagEnd: tag.getEnd() });
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

/** The text with the tag's line taken out (or, when it shares its line with `/**` and the end, emptied). */
export function withoutTag(text, tag) {
    const lineStart = text.lastIndexOf('\n', tag.tagStart) + 1;
    const lineEnd = text.indexOf('\n', tag.tagEnd);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    if (/^\s*\*\s*@param\b/.test(line) && lineEnd !== -1) return text.slice(0, lineStart) + text.slice(lineEnd + 1);
    return text.slice(0, tag.tagStart) + text.slice(tag.tagEnd);
}

export function run({ files, write = false, serverDir } = {}) {
    const abs = files.map((f) => path.resolve(ROOT, f)).filter((f) => !/\.(?:test|spec)\.[cm]?js$|\.testkit\./.test(f));
    const byLevel = new Map();
    for (const f of abs) {
        const level = levelOfText(fs.readFileSync(f, 'utf8')) ?? 'base';
        (byLevel.get(level) || byLevel.set(level, []).get(level)).push(f);
    }
    const reports = [];
    for (const [level, group] of byLevel) {
        const project = openServer(group, { serverDir, level });
        // The quick fix hangs on the implicit-any error, so the asking is done where noImplicitAny is on.
        const asker = level === 'base' ? openServer(group, { serverDir, level: 'noImplicitAny' }) : project;
        const { ts } = project;
        for (const f of group) {
            const original = project.text(f);
            const tags = looseTags(ts, project.svc.service.getProgram().getSourceFile(f));
            if (tags.length === 0) continue;
            const edits = [];
            for (const tag of tags) {
                // Ask the checker with the tag gone: the parameter is an implicit any and has a quick fix.
                asker.update(f, withoutTag(original, tag));
                const diag = asker.diagnostics(f).find((d) => d.code === 7006 && ts.flattenDiagnosticMessageText(d.messageText, ' ').includes(`'${tag.name}'`));
                let type = null;
                if (diag) {
                    let fixes = [];
                    // The language service's formatter can fail on an odd file: that tag stays as it is.
                    try { fixes = asker.svc.service.getCodeFixesAtPosition(f, diag.start, diag.start + diag.length, [7006], FORMAT, PREFS).filter((x) => x.fixId === 'inferFromUsage'); } catch { fixes = []; }
                    for (const fix of fixes) for (const c of fix.changes.flatMap((x) => x.textChanges)) type ??= typeInFix(c.newText, tag.name);
                }
                if (type && concrete(type)) edits.push({ at: tag.typeStart, end: tag.typeEnd, text: type });
            }
            asker.update(f, original);
            project.update(f, original);
            if (edits.length === 0) { reports.push({ file: path.relative(ROOT, f), seen: tags.length, replaced: 0 }); continue; }
            const count = (text) => { project.update(f, text); return project.diagnostics(f).length; };
            const { kept, text } = keepHarmless(original, edits, count);
            project.update(f, text);
            asker.update(f, text);
            if (write && kept.length) fs.writeFileSync(f, text);
            reports.push({ file: path.relative(ROOT, f), seen: tags.length, replaced: kept.length });
        }
    }
    return reports;
}

if (isEntryPoint(import.meta.url)) {
    const args = process.argv.slice(2);
    const val = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
    const files = val('--files') ? val('--files').split(',') : val('--batch') ? fs.readFileSync(val('--batch'), 'utf8').split('\n').filter(Boolean) : [];
    if (files.length === 0) {
        console.error('jsdoc-loose-types: pass --files a,b or --batch list.txt');
        process.exit(2);
    }
    const reports = run({ files, write: args.includes('--write') });
    const sum = (k) => reports.reduce((n, r) => n + r[k], 0);
    console.log(JSON.stringify({ seen: sum('seen'), replaced: sum('replaced'), files: reports }, null, 1));
}

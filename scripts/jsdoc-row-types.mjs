#!/usr/bin/env node
/**
 * Type the row a store mapper takes from the generated table types.
 *
 * `rowToTask(r)`, `mapRow(row)` and friends read `r.user_id`, `r.created_at` ... off a database row
 * the type of which is `any` or `QueryResultRow`. server/types/rows.d.ts (scripts/gen-row-types.mjs)
 * has one interface per table. For a mapper in stores/** this finds the columns it reads, takes the
 * table whose columns contain all of them (the smallest such table; a tie is left alone), and writes
 * `@param {DbRow.Table} r` (`| null` when the function starts with `if (!r) return`). The edit stays only
 * when the file's diagnostics do not rise at the file's own level: the checker confirms.
 *
 *   node scripts/jsdoc-row-types.mjs --files server/stores/a.js,server/stores/b.js [--write]
 *   node scripts/jsdoc-row-types.mjs --batch list.txt [--write]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { keepHarmless, openServer } from './lib/server-service.mjs';
import { levelOfText } from '../server/scripts/typecheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAPPER = /^(?:rowTo[A-Z]\w*|mapRow|parseRow)$/;
const LOOSE_ROW = /^(?:import\('pg'\)\.QueryResultRow|QueryResultRow|any|object|Object|Record<string,\s*(?:any|unknown)>|\{\s*\[\w+:\s*string\]:\s*(?:any|unknown)\s*\})(\s*\|\s*null)?$/;
const MIN_COLUMNS = 3;

/** `{ table: Set<column> }` from the text of rows.d.ts. */
export function parseRowTypes(text) {
    const tables = new Map();
    let current = null;
    for (const line of text.split('\n')) {
        const open = /^\s*interface (\w+) \{$/.exec(line);
        if (open) { current = new Set(); tables.set(open[1], current); continue; }
        const col = /^\s+(\w+): /.exec(line);
        if (col && current) current.add(col[1]);
        if (/^\s*\}$/.test(line)) current = null;
    }
    return tables;
}

/**
 * The table a mapper reads: all `columns` present, fewest columns wins, a tie gives null.
 * @param {Set<string>} columns
 * @param {Map<string, Set<string>>} tables
 */
export function tableFor(columns, tables) {
    if (columns.size < MIN_COLUMNS) return null;
    const fits = [...tables].filter(([, cols]) => [...columns].every((c) => cols.has(c)));
    if (fits.length === 0) return null;
    fits.sort((a, b) => a[1].size - b[1].size);
    if (fits.length > 1 && fits[0][1].size === fits[1][1].size) return null;
    return fits[0][0];
}

/** The columns function `fn` reads off its first parameter. */
function columnsRead(ts, fn, name) {
    const cols = new Set();
    const visit = (n) => {
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) cols.add(n.name.text);
        else if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name && ts.isStringLiteral(n.argumentExpression)) cols.add(n.argumentExpression.text);
        else if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.initializer) && n.initializer.text === name && ts.isObjectBindingPattern(n.name)) {
            for (const el of n.name.elements) if (!el.dotDotDotToken) cols.add((el.propertyName ?? el.name).text);
        }
        ts.forEachChild(n, visit);
    };
    visit(fn.body);
    return cols;
}

export function planFile(project, file, tables) {
    const { ts } = project;
    const sf = project.svc.service.getProgram().getSourceFile(file);
    const edits = [];
    const text = sf.text;
    for (const fn of sf.statements) {
        if (!ts.isFunctionDeclaration(fn) || !fn.name || !MAPPER.test(fn.name.text) || !fn.body) continue;
        const param = fn.parameters[0];
        if (!param || !ts.isIdentifier(param.name)) continue;
        const pname = param.name.text;
        const table = tableFor(columnsRead(ts, fn, pname), tables);
        if (!table) continue;
        const first = fn.body.statements[0];
        const nullable = Boolean(first && ts.isIfStatement(first) && /^\s*if\s*\(\s*!\s*\w+\s*\)\s*return\b/.test(first.getText(sf)));
        const type = `DbRow.${table}${nullable ? ' | null' : ''}`;
        const doc = ts.getJSDocCommentsAndTags(fn).filter(ts.isJSDoc).pop();
        const tag = doc?.tags?.find((t) => ts.isJSDocParameterTag(t) && t.name.getText(sf) === pname);
        if (tag?.typeExpression) {
            const inner = tag.typeExpression.type.getText(sf);
            if (!LOOSE_ROW.test(inner)) continue;
            edits.push({ at: tag.typeExpression.type.getStart(sf), end: tag.typeExpression.type.getEnd(), text: type });
        } else if (doc && !(doc.tags || []).some((t) => ts.isJSDocParameterTag(t))) {
            // a description block with no @param: the tag goes in before the closing line
            const start = doc.getStart(sf);
            const block = text.slice(start, doc.getEnd());
            if (!block.includes('\n')) {
                const desc = block.replace(/^\/\*\*\s*/, '').replace(/\s*\*\/$/, '');
                const indent = /([ \t]*)$/.exec(text.slice(text.lastIndexOf('\n', start) + 1, start))?.[1] ?? '';
                edits.push({ at: start, end: doc.getEnd(), text: `/**\n${indent} * ${desc}\n${indent} * @param {${type}} ${pname}\n${indent} */` });
            } else {
                const end = doc.getEnd() - 2;
                const indent = /\n([ \t]*)$/.exec(text.slice(start, end))?.[1] ?? ' ';
                edits.push({ at: end, text: `* @param {${type}} ${pname}\n${indent}` });
            }
        } else if (!doc) {
            edits.push({ at: fn.getStart(sf), text: `/** @param {${type}} ${pname} */\n` });
        }
    }
    return edits;
}

export function run({ files, write = false, serverDir, rowTypes } = {}) {
    const tables = parseRowTypes(rowTypes ?? fs.readFileSync(path.join(serverDir ?? path.join(ROOT, 'server'), 'types', 'rows.d.ts'), 'utf8'));
    const abs = files.map((f) => path.resolve(ROOT, f)).filter((f) => !/\.(?:test|spec)\.[cm]?js$|\.testkit\./.test(f));
    const reports = [];
    const byLevel = new Map();
    for (const f of abs) {
        const level = levelOfText(fs.readFileSync(f, 'utf8')) ?? 'base';
        (byLevel.get(level) || byLevel.set(level, []).get(level)).push(f);
    }
    // One language service per level: an edit is judged under the options its file is checked with.
    for (const [level, group] of byLevel) {
        const project = openServer(group, { serverDir, level });
        for (const f of group) {
            const edits = planFile(project, f, tables);
            if (edits.length === 0) continue;
            const original = project.text(f);
            const count = (text) => { project.update(f, text); return project.diagnostics(f).length; };
            const { kept, text } = keepHarmless(original, edits, count);
            project.update(f, text);
            if (write && kept.length) fs.writeFileSync(f, text);
            reports.push({ file: path.relative(ROOT, f), planned: edits.length, kept: kept.length, dropped: edits.length - kept.length });
        }
    }
    return reports;
}

if (isEntryPoint(import.meta.url)) {
    const args = process.argv.slice(2);
    const val = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
    const files = val('--files') ? val('--files').split(',') : val('--batch') ? fs.readFileSync(val('--batch'), 'utf8').split('\n').filter(Boolean) : [];
    if (files.length === 0) {
        console.error('jsdoc-row-types: pass --files a,b or --batch list.txt');
        process.exit(2);
    }
    const reports = run({ files, write: args.includes('--write') });
    const sum = (k) => reports.reduce((n, r) => n + r[k], 0);
    console.log(JSON.stringify({ planned: sum('planned'), kept: sum('kept'), dropped: sum('dropped'), files: reports }, null, 1));
}

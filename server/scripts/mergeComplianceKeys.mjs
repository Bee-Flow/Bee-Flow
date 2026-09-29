#!/usr/bin/env node
/**
 * mergeComplianceKeys — fold the Compliance Center redesign's per-stream key
 * files (.claude/handoff/compliance/keys/*.json, `{ en: {...}, nl: {...} }`)
 * into the English dictionary, and emit the NL map the migration reads.
 *
 * The dictionary is server/i18n/defaults/en/<namespace>.js (one file per
 * namespace); the frontend copy agent-hub/src/i18n/en-defaults.js is generated
 * from it, so after adding keys this script runs scripts/gen-i18n-defaults.mjs.
 *
 * Idempotent: a key already present in the dictionary is skipped (a differing
 * English is reported, never overwritten — the dictionary wins). New keys are
 * appended inside ONE clearly marked block at the end of their namespace file.
 *
 *   node server/scripts/mergeComplianceKeys.mjs            # apply
 *   node server/scripts/mergeComplianceKeys.mjs --check    # report only
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEYS_DIR = path.join(ROOT, '.claude', 'handoff', 'compliance', 'keys');
const SERVER_DIR = path.join(ROOT, 'server', 'i18n', 'defaults', 'en');
const GEN_DEFAULTS = path.join(ROOT, 'scripts', 'gen-i18n-defaults.mjs');
const NL_OUT = path.join(ROOT, 'server', 'migrations', 'data', 'compliance-center-nl.json');
const MARK_START = 'Compliance Center redesign (2026-09-14) — merged from .claude/handoff/compliance/keys/*.json by server/scripts/mergeComplianceKeys.mjs';
const check = process.argv.includes('--check');

const files = fs.existsSync(KEYS_DIR) ? fs.readdirSync(KEYS_DIR).filter(f => f.endsWith('.json')).sort() : [];
const en = new Map(); const nl = new Map(); const conflicts = [];
for (const f of files) {
    const body = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, f), 'utf8'));
    for (const [k, v] of Object.entries(body.en || {})) {
        if (en.has(k) && en.get(k) !== v) conflicts.push(`${k}: "${en.get(k)}" (kept) vs "${v}" (${f})`);
        else if (!en.has(k)) en.set(k, v);
    }
    for (const [k, v] of Object.entries(body.nl || {})) if (!nl.has(k)) nl.set(k, v);
}

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
const END_MARK = '    // ── end Compliance Center redesign block ──';

function merge() {
    const { GUI_DEFAULTS } = createRequire(import.meta.url)(path.join(SERVER_DIR, 'index.js'));
    const byNs = new Map(); const differ = [];
    let added = 0;
    for (const [k, v] of en) {
        if (!(k in GUI_DEFAULTS)) {
            const ns = k.split('.')[0];
            if (!byNs.has(ns)) byNs.set(ns, []);
            byNs.get(ns).push([k, v]);
            added++;
        } else if (GUI_DEFAULTS[k] !== v) differ.push(`${k}: dictionary "${GUI_DEFAULTS[k]}" ≠ keys "${v}"`);
    }
    for (const [ns, add] of byNs) {
        const file = path.join(SERVER_DIR, `${ns}.js`);
        if (!fs.existsSync(file)) throw new Error(`no namespace file en/${ns}.js — create it and list it in en/index.js first`);
        let src = fs.readFileSync(file, 'utf8');
        const lines = add.map(([k, v]) => `    '${esc(k)}': '${esc(v)}',`).join('\n');
        // Extend the existing block if present, else open one before the file's closing brace.
        if (src.includes(MARK_START) && src.includes(END_MARK)) {
            const i = src.indexOf(END_MARK);
            src = src.slice(0, i) + lines + '\n' + src.slice(i);
        } else {
            const at = src.lastIndexOf('};');
            if (at === -1) throw new Error(`cannot find the closing }; in en/${ns}.js`);
            src = `${src.slice(0, at)}\n    // ── ${MARK_START} ──\n${lines}\n${END_MARK}\n${src.slice(at)}`;
        }
        if (!check) fs.writeFileSync(file, src);
    }
    if (!check && added) execFileSync(process.execPath, [GEN_DEFAULTS], { cwd: ROOT, stdio: 'inherit' });
    return { added, differ };
}

const s = merge();
if (!check) {
    fs.mkdirSync(path.dirname(NL_OUT), { recursive: true });
    const nlObj = {};
    for (const [k] of en) if (nl.has(k)) nlObj[k] = nl.get(k);
    fs.writeFileSync(NL_OUT, JSON.stringify(nlObj, null, 2) + '\n');
}
console.log(`${files.length} keys files · ${en.size} unique EN keys · ${nl.size} NL values`);
console.log(`dictionary: +${s.added}${check ? '   (check only, nothing written)' : ''}`);
for (const d of s.differ) console.log('DIFFERS:', d);
for (const d of conflicts) console.log('CONFLICT between keys files:', d);
if (!check) console.log(`NL map → ${path.relative(ROOT, NL_OUT)} (${nl.size} entries)`);

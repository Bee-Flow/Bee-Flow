#!/usr/bin/env node
/**
 * Environment inventory: which environment variables the server reads, and a
 * ratchet on the ones no document mentions.
 *
 * The server has no schema for its environment: a variable exists because some
 * file reads `process.env.X`. This script is the list. It reads every source
 * file under server/ (tests, test kits, fixtures and node_modules left out) and
 * collects the names read in one of these ways:
 *
 *   process.env.NAME            process.env['NAME']
 *   const { NAME, OTHER } = process.env
 *   envInt('NAME', 60)          envNumber('NAME', 0.5)     (server/utils/envNumber.mts;
 *                               any helper named env<Something>('NAME', …) counts,
 *                               and its second argument is listed as the default)
 *
 * A name is DOCUMENTED when it appears as a whole word in one of
 *
 *   .env.example    server/.env.example    docs/docs/self-hosting/env.md
 *
 * and the number of names that appear in none of them may only go down
 * (server/.env-undocumented-ratchet.json). A new variable therefore arrives with
 * a line in an example file or in the guide.
 *
 * What it cannot see: a name built at run time (`process.env[name]`,
 * `process.env[`${prefix}_URL`]`), and a helper that takes the name under
 * another shape (an options object, `{ env: 'NAME' }`). Those are not counted,
 * in either direction. Variables the platform sets (HOME, PATH, CI) are read by
 * the server like any other and count until a document names them.
 *
 * Usage:
 *   node scripts/env-inventory.mjs            gate (also: --check)
 *   node scripts/env-inventory.mjs --update   lower the budget to the measured count
 *   node scripts/env-inventory.mjs --list     one line per variable: status, name, default, files
 *   node scripts/env-inventory.mjs --list --undocumented   only the undocumented ones
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';
import { stripComments } from './scc-ratchet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_REL = 'server';
export const DOCUMENT_RELS = ['.env.example', 'server/.env.example', 'docs/docs/self-hosting/env.md'];
export const BUDGET_REL = 'server/.env-undocumented-ratchet.json';

const SOURCE_FILE = /\.(?:[cm]?js|[cm]?ts)$/;
const NOT_SOURCE = /\.(?:test|spec|testkit|testutil|fixture|golden)\.[cm]?[jt]s$|\.d\.[cm]?ts$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'testUtils', 'fixtures', '__fixtures__', '__tests__']);

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const DOT_ACCESS = new RegExp(`\\bprocess\\.env\\.(${NAME})`, 'g');
const BRACKET_ACCESS = new RegExp(`\\bprocess\\.env\\[\\s*(['"])(${NAME})\\1\\s*\\]`, 'g');
const DESTRUCTURED = /\{([^{}]*)\}\s*=\s*process\.env\b(?!\s*[.[])/g;
// envInt('NAME', 60, …) and its siblings: the name, then the default up to the next top-level comma.
const HELPER_CALL = new RegExp(`(?<![\\w$.])env[A-Z]\\w*\\(\\s*(['"])(${NAME})\\1\\s*(,|\\))`, 'g');

/**
 * The text of one call argument starting at `from`: up to the comma or the
 * closing parenthesis that ends it, brackets and quotes inside it skipped.
 * @param {string} code
 * @param {number} from
 */
function argumentAt(code, from) {
    let depth = 0;
    let quote = '';
    let i = from;
    for (; i < code.length; i++) {
        const c = code[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = '';
        } else if (c === '\'' || c === '"' || c === '`') quote = c;
        else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) break;
            depth--;
        } else if (c === ',' && depth === 0) break;
    }
    return code.slice(from, i).replace(/\s+/g, ' ').trim();
}

/**
 * The environment variables one source text reads.
 * @param {string} text
 * @returns {{ name: string, default: string | null }[]} one entry per read, in source order
 */
export function readsOf(text) {
    const code = stripComments(text);
    /** @type {{ name: string, default: string | null, at: number }[]} */
    const reads = [];
    for (const m of code.matchAll(DOT_ACCESS)) reads.push({ name: m[1], default: null, at: m.index });
    for (const m of code.matchAll(BRACKET_ACCESS)) reads.push({ name: m[2], default: null, at: m.index });
    for (const m of code.matchAll(DESTRUCTURED)) {
        for (const part of m[1].split(',')) {
            // `NAME`, `NAME: alias` and `NAME = 'fallback'` all read NAME.
            const name = new RegExp(`^\\s*(${NAME})`).exec(part);
            if (name) reads.push({ name: name[1], default: null, at: m.index });
        }
    }
    for (const m of code.matchAll(HELPER_CALL)) {
        const fallback = m[3] === ',' ? argumentAt(code, m.index + m[0].length) : '';
        reads.push({ name: m[2], default: fallback || null, at: m.index });
    }
    return reads.sort((a, b) => a.at - b.at).map(({ name, default: fallback }) => ({ name, default: fallback }));
}

/**
 * Every whole word of the documents: a variable is documented when its name is one of them.
 * @param {string[]} texts
 * @returns {Set<string>}
 */
export function documentedWords(texts) {
    const words = new Set();
    for (const text of texts) for (const m of text.matchAll(new RegExp(NAME, 'g'))) words.add(m[0]);
    return words;
}

/** @param {string} dir @param {string[]} into */
function collect(dir, into) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collect(full, into);
        } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !NOT_SOURCE.test(entry.name)) {
            into.push(full);
        }
    }
    return into;
}

/**
 * The inventory of a checkout.
 * @param {string} root
 * @returns {{ name: string, documented: boolean, defaults: string[], files: string[] }[]} sorted by name
 */
export function inventory(root) {
    const sourceDir = path.join(root, SOURCE_REL);
    /** @type {Map<string, { defaults: Set<string>, files: Set<string> }>} */
    const byName = new Map();
    for (const file of collect(sourceDir, []).sort()) {
        const rel = path.relative(sourceDir, file).split(path.sep).join('/');
        for (const read of readsOf(fs.readFileSync(file, 'utf8'))) {
            let entry = byName.get(read.name);
            if (!entry) byName.set(read.name, entry = { defaults: new Set(), files: new Set() });
            entry.files.add(rel);
            if (read.default) entry.defaults.add(read.default);
        }
    }
    const words = documentedWords(DOCUMENT_RELS
        .map((rel) => path.join(root, rel))
        .filter((file) => fs.existsSync(file))
        .map((file) => fs.readFileSync(file, 'utf8')));
    return [...byName.entries()]
        .map(([name, entry]) => ({ name, documented: words.has(name), defaults: [...entry.defaults], files: [...entry.files] }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** @param {{ name: string, documented: boolean, defaults: string[], files: string[] }} v */
function listLine(v) {
    const shown = v.files.slice(0, 3).join(', ') + (v.files.length > 3 ? ` (+${v.files.length - 3})` : '');
    const fallback = v.defaults.length ? `default ${v.defaults.join(' | ')}` : '-';
    return `${v.documented ? 'documented  ' : 'undocumented'}  ${v.name}  ${fallback}  ${shown}\n`;
}

/**
 * @param {string[]} argv
 * @param {{ root?: string, out?: (s: string) => void, err?: (s: string) => void, today?: string }} [deps]
 * @returns {number} exit code
 */
export function main(argv, { root = ROOT, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), today = new Date().toISOString().slice(0, 10) } = {}) {
    const variables = inventory(root);
    const undocumented = variables.filter((v) => !v.documented);
    const count = undocumented.length;
    const budgetPath = path.join(root, BUDGET_REL);
    const budget = fs.existsSync(budgetPath) ? JSON.parse(fs.readFileSync(budgetPath, 'utf8')).count : null;
    const what = 'environment variables read by the server that no document mentions';

    if (argv.includes('--list')) {
        for (const v of argv.includes('--undocumented') ? undocumented : variables) out(listLine(v));
        err(`${variables.length} variables, ${count} undocumented (budget ${budget ?? 'none'})\n`);
        return 0;
    }
    if (argv.includes('--update')) {
        if (budget !== null && count > budget) {
            err(`❌ server: ${count} ${what}, budget is ${budget}; --update only lowers it.\n`);
            return 1;
        }
        const next = {
            _comment: `Highest number of ${what} (${DOCUMENT_RELS.join(', ')}). Lower it with \`node scripts/env-inventory.mjs --update\` after documenting some; raising it is a deliberate edit that belongs in a commit message with a reason.`,
            _generated: today,
            count,
        };
        fs.writeFileSync(budgetPath, `${JSON.stringify(next, null, 2)}\n`);
        out(`Budget written to ${BUDGET_REL}: ${count} ${what} (was ${budget ?? 'none'})\n`);
        return 0;
    }
    if (budget === null) {
        err(`❌ server: ${BUDGET_REL} is missing; run \`node scripts/env-inventory.mjs --update\` once.\n`);
        return 1;
    }
    if (count > budget) {
        err(`❌ server: ${count} ${what}, budget is ${budget} — add the new variable to .env.example or server/.env.example `
            + '(a commented line with its default and what it does) or to docs/docs/self-hosting/env.md rather than raising the budget '
            + '(`node scripts/env-inventory.mjs --list --undocumented` shows them)\n');
        return 1;
    }
    if (count < budget) out(`✅ server: ${count} ${what}, under the budget of ${budget}. Run \`node scripts/env-inventory.mjs --update\` to lower it.\n`);
    else out(`➖ server: ${count} ${what}, at budget\n`);
    return 0;
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));

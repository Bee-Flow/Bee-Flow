/**
 * Writes the frozen expectations of the App Studio compatibility corpus.
 *
 *   node appStudio/compat/freeze.mts            write frozen/<name>.json for every corpus file that has none
 *   node appStudio/compat/freeze.mts --check    write nothing; list every corpus file whose frozen file is
 *                                               missing or differs from what today's code produces
 *   node appStudio/compat/freeze.mts --all      rewrite every frozen file (a deliberate behaviour change:
 *                                               scripts/check-compat-corpus.mjs then fails the pull request)
 *   ... [names]                                 limit to these corpus names
 *
 * Run from server/ (the paths inside are resolved from this file, so any directory works).
 */

import fs from 'node:fs';
import { corpusNames, formatJson, frozenPath, readCorpus, readFrozen, FROZEN_DIR } from './corpus.mts';
import { syncSections } from './expectations.mts';
import { readsSection } from './readSql.mts';
import type { Obj } from './corpus.mts';

/** Everything a frozen file holds for one corpus entry. */
export function expectationsFor(name: string): Obj {
    const entry = readCorpus(name);
    const out: Obj = { corpus: name, ...syncSections(entry) };
    const reads = readsSection(entry);
    if (reads) out.reads = reads;
    return out;
}

type Mode = 'missing' | 'check' | 'all';

function freezeOne(name: string, mode: Mode): string | null {
    const existing = readFrozen(name);
    if (mode === 'missing' && existing) return null;
    const text = formatJson(expectationsFor(name));
    if (mode === 'check') {
        if (!existing) return `${name}: no frozen file`;
        return formatJson(existing) === text ? null : `${name}: differs from today's output`;
    }
    fs.writeFileSync(frozenPath(name), text);
    return `${name}: written`;
}

export function main(argv: string[]): number {
    const mode: Mode = argv.includes('--check') ? 'check' : argv.includes('--all') ? 'all' : 'missing';
    const wanted = argv.filter((a) => !a.startsWith('--'));
    const known = corpusNames();
    const unknown = wanted.filter((n) => !known.includes(n));
    if (unknown.length) {
        process.stderr.write(`freeze: unknown corpus name(s): ${unknown.join(', ')}\n`);
        return 2;
    }
    fs.mkdirSync(FROZEN_DIR, { recursive: true });
    const lines: string[] = [];
    for (const name of wanted.length ? wanted : known) {
        const line = freezeOne(name, mode);
        if (line) lines.push(line);
    }
    process.stdout.write(lines.length ? `${lines.join('\n')}\n` : 'freeze: nothing to do\n');
    return mode === 'check' && lines.length ? 1 : 0;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
    process.exitCode = main(process.argv.slice(2));
}

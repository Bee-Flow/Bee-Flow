/**
 * The goldens of the GUI inventory (the `*.inventory.test.ts` files beside the
 * lists the app's surface is composed from: routes, sidebar, Studio, admin and
 * organisation sections, composer, providers and overlays). Each test records
 * its list from the running code (and, where a list is JSX or a lazy import,
 * with the TypeScript compiler API, sourceAst.ts) and compares the recording
 * with a JSON golden beside it: `<name>.inventory.golden.json` next to
 * `<name>.inventory.test.ts`.
 *
 * The golden is the baseline of plan phase 2: the rounds that move the web
 * client into module directories must leave every golden unchanged while all
 * modules are present ("the GUI stays exactly as it is"). Each entry names its
 * owner from the ownership map (scripts/module-map.json), so the rows a module
 * will contribute can be read off.
 *
 * Shape and switch follow server/boot/compositionGolden.testkit.js: a
 * `_comment`, then the recording; an array of objects is written one element
 * per line, so a diff shows one route, row or section per line. The golden is
 * written when it is missing, or with UPDATE_GOLDEN=1:
 *   cd agent-hub && UPDATE_GOLDEN=1 npx vitest run <file>.inventory.test.ts
 * Only after a change that is MEANT to change the GUI; review the diff.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** JSON with each element of an array of objects on its own line (as compositionGolden.testkit.js). */
export function renderGolden(value: unknown, indent = ''): string {
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        const inner = `${indent}  `;
        const lines = value.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : renderGolden(v, inner)));
        return `[\n${lines.map((l) => `${inner}${l}`).join(',\n')}\n${indent}]`;
    }
    if (value && typeof value === 'object') {
        const inner = `${indent}  `;
        const lines = Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${renderGolden(v, inner)}`);
        return lines.length ? `{\n${lines.join(',\n')}\n${indent}}` : '{}';
    }
    return JSON.stringify(value);
}

/** The golden file of a test file: `x.inventory.test.ts` -> `x.inventory.golden.json`. */
export function goldenPathOf(testFileUrl: string): string {
    const file = fileURLToPath(testFileUrl);
    const base = path.basename(file).replace(/\.test\.tsx?$/, '');
    return path.join(path.dirname(file), `${base}.golden.json`);
}

/** The lines one text has and the other does not, as multisets, in order. */
export function lineDiff(expected: string, actual: string): { missing: string[]; added: string[] } {
    const count = new Map<string, number>();
    for (const l of expected.split('\n')) count.set(l, (count.get(l) ?? 0) + 1);
    const added: string[] = [];
    for (const l of actual.split('\n')) {
        const n = count.get(l) ?? 0;
        if (n) count.set(l, n - 1);
        else added.push(l);
    }
    const missing = expected.split('\n').filter((l) => {
        const n = count.get(l) ?? 0;
        if (!n) return false;
        count.set(l, n - 1);
        return true;
    });
    return { missing, added };
}

/** The assertion message for a golden that differs: every missing and every new line, then how to regenerate. */
export function describeDiff(goldenFile: string, expected: string, actual: string): string {
    const { missing, added } = lineDiff(expected, actual);
    const body = [...missing.map((l) => `  - ${l.trim()}`), ...added.map((l) => `  + ${l.trim()}`)];
    const moved = body.length ? '' : '  (the same lines, in another order)\n';
    return `${path.basename(goldenFile)} differs from what the code composes now:\n${body.join('\n')}\n${moved}`
        + 'If the change to the GUI is meant: UPDATE_GOLDEN=1 npx vitest run <this test>, and review the diff.';
}

/**
 * Compare a recording with the golden beside the test; write the golden when it
 * is missing or UPDATE_GOLDEN=1. Throws with a line diff when they differ.
 */
export function checkGolden(testFileUrl: string, comment: string, recording: Record<string, unknown>): void {
    const file = goldenPathOf(testFileUrl);
    const actual = `${renderGolden({ _comment: comment, ...recording })}\n`;
    if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(file)) {
        fs.writeFileSync(file, actual);
        return;
    }
    const expected = fs.readFileSync(file, 'utf8');
    if (expected !== actual) throw new Error(describeDiff(file, expected, actual));
}

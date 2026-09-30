/**
 * kinds.ts is a port of the web's kindColors.js, and this test reads the web
 * source to keep it one: the same kinds in the same rail order, the same CSS
 * variable per kind, the same glyph and the same aliases. When it fails the
 * web changed — update the port, don't loosen the test.
 */

import fs from 'node:fs';
import path from 'node:path';

import { KIND_ALIASES, KIND_ICON, KIND_KEYS, KIND_TOKEN } from './kinds';

const WEB = path.resolve(__dirname, '../../../../agent-hub/src/components/shared/kindColors.js');
const src = fs.readFileSync(WEB, 'utf8');

/** The body of `export const NAME = Object.freeze(…)` / `const NAME = Object.freeze({…})`. */
function block(name: string): string {
    const m = new RegExp(`const ${name} = Object\\.freeze\\(([\\s\\S]*?)\\);`).exec(src);
    if (!m) throw new Error(`kindColors.js has no ${name}`);
    return m[1] as string;
}

/** `key: value` pairs of a frozen object, comments stripped. */
function pairs(body: string, value: RegExp): Record<string, string> {
    const out: Record<string, string> = {};
    const clean = body.replace(/\/\/[^\n]*/g, '');
    for (const m of clean.matchAll(new RegExp(`([a-z_]+):\\s*${value.source}`, 'g'))) {
        out[m[1] as string] = m[2] as string;
    }
    return out;
}

describe('kinds.ts against the web kindColors.js', () => {
    it('has the same kinds in the same rail order', () => {
        const web = [...block('KIND_KEYS').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        expect([...KIND_KEYS]).toEqual(web);
    });

    it('names the same CSS variable for every kind', () => {
        const web = pairs(block('KIND_VAR'), /'var\((--[a-z-]+)\)'/);
        expect(KIND_TOKEN).toEqual(web);
    });

    it('draws the same Lucide glyph for every kind', () => {
        const web = pairs(block('KIND_ICON'), /([A-Za-z0-9]+)/);
        expect(KIND_ICON).toEqual(web);
    });

    it('folds the same aliases onto the same kinds', () => {
        const web = pairs(block('KIND_ALIASES'), /'([a-z_]+)'/);
        expect({ ...KIND_ALIASES }).toEqual(web);
    });
});

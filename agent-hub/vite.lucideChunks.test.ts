import { describe, expect, it } from 'vitest';
import { barrelFiles, lucideEntryTest, lucideNamedImports } from './vite.lucideChunks.mjs';

describe('lucideNamedImports', () => {
    it('reads named value imports and skips type imports', () => {
        const text = `import { ArrowRight, Check as Tick } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { type Foo, X } from "lucide-react";`;
        expect(lucideNamedImports(text)).toEqual(['ArrowRight', 'Check', 'X']);
    });
});

describe('barrelFiles', () => {
    it('maps every alias to its icon file', () => {
        const barrel = `export { default as ArrowRight, default as ArrowRightIcon } from './icons/arrow-right.mjs';
export { default as Check } from './icons/check.mjs';`;
        const m = barrelFiles(barrel);
        expect(m.get('ArrowRightIcon')).toBe('arrow-right.mjs');
        expect(m.get('Check')).toBe('check.mjs');
    });
});

describe('lucideEntryTest', () => {
    // The real source tree and the installed lucide: the registry's icons are in, a stray one is out.
    const test = lucideEntryTest(`${import.meta.dirname}/src`, `${import.meta.dirname}/node_modules/lucide-react/dist/esm`);
    const esm = '/x/node_modules/lucide-react/dist/esm';
    it('keeps the base modules and the entry icons, not the barrel or other icons', () => {
        expect(test(`${esm}/createLucideIcon.mjs`)).toBe(true);
        expect(test(`${esm}/icons/arrow-right.mjs`)).toBe(true);
        expect(test(`${esm}/icons/zap-off.mjs`)).toBe(false);
        expect(test(`${esm}/lucide-react.mjs`)).toBe(false);
        expect(test('/x/node_modules/react/index.js')).toBe(false);
    });
});

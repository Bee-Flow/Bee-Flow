// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ORDER = '@layer properties, theme, base, components, utilities;';
const read = (name: string) => readFileSync(path.resolve(import.meta.dirname, '..', name), 'utf8');

describe('Tailwind layer order', () => {
    it.each(['index.css', 'tailwind-utilities.css'])('%s declares the full order, utilities last', (file) => {
        const first = /@layer\s+[a-z, ]+;/.exec(read(file));
        expect(first?.[0]).toBe(ORDER);
    });
});

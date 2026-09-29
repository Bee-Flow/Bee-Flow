/**
 * The EN catalogue is loaded NATIVELY in tests — this pins that, and the two
 * properties it depends on.
 *
 * vite.config.js marks src/i18n/en-defaults.js as `test.server.deps.external`,
 * so node imports the real 2.0 MB file instead of vite-node moving it into
 * every one of the ~1,200 worker threads. Nothing is mocked and no source file
 * changed; the only thing that can quietly undo it is (a) the config entry
 * going away or its path regex ceasing to match, or (b) en-defaults.js growing
 * something that needs a vite transform.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOGUE = path.join(HERE, 'en-defaults.js');

describe('en-defaults is loaded outside vite-node', () => {
    it('is a native module namespace, not a vite-node module', async () => {
        const ns = await import('./en-defaults');
        // A native ESM namespace is non-extensible with non-configurable
        // properties, so it is sealed. vite-node builds its namespace as a
        // plain object with getters, which is not.
        expect(
            Object.isSealed(ns),
            'src/i18n/en-defaults.js is going through vite-node again. Check that '
            + "the test block in agent-hub/vite.config.js still has "
            + '`server: { deps: { external: [/src\\/i18n\\/en-defaults/] } }` and '
            + 'that the regex still matches this file\'s path.',
        ).toBe(true);
    });

    it('resolves to ONE instance whichever specifier is used', async () => {
        const viaRelative = await import('./en-defaults');
        const viaAlias = await import('@/i18n/en-defaults');
        expect(viaAlias.default).toBe(viaRelative.default);
        expect(Object.keys(viaRelative.default).length).toBeGreaterThan(15_000);
    });

    it('stays transform-free, which is what makes the native load possible', () => {
        const lines = fs.readFileSync(CATALOGUE, 'utf8').split('\n');
        const imports = lines.filter((l) => /^\s*import[\s{*(]/.test(l));
        const exports = lines.filter((l) => /^\s*export\b/.test(l));
        const why = 'en-defaults.js is imported natively by node in tests '
            + '(test.server.deps.external in vite.config.js), so it must stay a '
            + 'plain `export default` over an object literal: no imports, no JSX, '
            + 'no import.meta, no "@" alias, no __APP_* define.';
        expect(imports, why).toEqual([]);
        expect(exports, why).toEqual(['export default EN_DEFAULTS;']);
    });
});

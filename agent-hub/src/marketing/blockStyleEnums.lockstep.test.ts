// @vitest-environment node
/**
 * Lockstep: blockStyleEnums.generated.mjs is GENERATED from
 * server/i18n/defaults/blockStyleEnums.js (npm run gen:shared; npm run
 * lint:shared-mirror checks the bytes). This test holds the values to the
 * CommonJS source the server loads.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as generated from './blockStyleEnums.generated.mjs';

const require = createRequire(import.meta.url);
const source = require('../../../server/i18n/defaults/blockStyleEnums.js');

describe('blockStyleEnums.generated.mjs', () => {
    it('exports exactly what server/i18n/defaults/blockStyleEnums.js exports', () => {
        assert.deepStrictEqual(Object.keys(generated).sort(), Object.keys(source).sort());
        for (const name of Object.keys(source)) {
            const value = (generated as Record<string, unknown>)[name];
            if (typeof value !== 'function') assert.deepStrictEqual(value, source[name], name);
        }
    });

    it('its functions answer like the source on a spread of inputs', () => {
        const sizes = ['cover', ' CONTAIN ', '480px', 480, '15px', '2401px', 'url(x)', null, {}];
        for (const v of sizes) {
            assert.equal(generated.cleanBackgroundSize(v), source.cleanBackgroundSize(v), String(v));
        }
        const style = { band: 'dark', backgroundSize: '50%', backgroundPosition: 'top', motif: 'x', motifTiles: 'no' };
        assert.deepStrictEqual(generated.sanitizeBlockDesignStyle(style), source.sanitizeBlockDesignStyle(style));
        assert.equal(generated.backgroundSizePx('320px'), source.backgroundSizePx('320px'));
    });
});

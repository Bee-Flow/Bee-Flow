// @vitest-environment node
/**
 * Lockstep — blockData.generated.mjs is GENERATED from server/i18n/defaults/cmsDefaults.js
 * (npm run gen:shared; npm run lint:shared-mirror checks the bytes). This
 * test holds the values to the CommonJS source the server loads.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as generated from './blockData.generated.mjs';

const require = createRequire(import.meta.url);
const source = require('../../../../../../server/i18n/defaults/cmsDefaults.js');

describe('blockData.generated.mjs', () => {
    it('exports exactly what server/i18n/defaults/cmsDefaults.js exports, deep-equal', () => {
        assert.deepStrictEqual(Object.keys(generated).sort(), Object.keys(source).sort());
        for (const name of Object.keys(source)) {
            assert.deepStrictEqual((generated as Record<string, unknown>)[name], source[name], name);
        }
    });
});

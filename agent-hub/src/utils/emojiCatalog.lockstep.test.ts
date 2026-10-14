// @vitest-environment node
/**
 * Lockstep — emojiCatalog.generated.mjs is GENERATED from server/core/cms/emojiCatalog.js
 * (npm run gen:shared; npm run lint:shared-mirror checks the bytes). This
 * test holds the values to the CommonJS source the server loads.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as generated from './emojiCatalog.generated.mjs';

const require = createRequire(import.meta.url);
const source = require('../../../server/core/cms/emojiCatalog.js');

describe('emojiCatalog.generated.mjs', () => {
    it('exports exactly what server/core/cms/emojiCatalog.js exports, deep-equal', () => {
        assert.deepStrictEqual(Object.keys(generated).sort(), Object.keys(source).sort());
        for (const name of Object.keys(source)) {
            assert.deepStrictEqual((generated as Record<string, unknown>)[name], source[name], name);
        }
    });
});

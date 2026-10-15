/**
 * Pins the exported key set of createPgAppEngine and of the module, so a split
 * into sub-factories can never silently drop or add a facade method.
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('./pgAppEngine');

test('module exports keep their key set', () => {
    assert.deepStrictEqual(Object.keys(mod).sort(), [
        '_dateOnlyString', '_normalizeRows', 'createPgAppEngine', 'mapPgError', 'toDollarParams',
    ]);
});

test('createPgAppEngine returns exactly the facade key set', () => {
    const engine = mod.createPgAppEngine({
        runQuery: async () => ({ rows: [] }),
        getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
        logPrefix: 'T', entityLabel: 'T', schemaFor: (id) => `app_${id}`,
    });
    assert.deepStrictEqual(Object.keys(engine).sort(), [
        '_normalizeParams', '_ownershipCache', '_sizeCache',
        'applyMigration', 'batch', 'closeAll', 'exec', 'flush', 'getSchemaStamp',
        'invalidate', 'query', 'reset', 'schema', 'sizeBytes',
    ]);
    for (const [k, v] of Object.entries(engine)) {
        if (!k.startsWith('_sizeCache') && !k.startsWith('_ownershipCache')) assert.strictEqual(typeof v, 'function', k);
    }
});

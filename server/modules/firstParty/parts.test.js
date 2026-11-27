/**
 * modules/firstParty/parts.js: a composition merges the part files that exist; a part that is
 * absent yields nothing, one that throws throws, and a part may only export its own keys.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withParts, optionalPart, PART_KEYS } = require('./parts');

/**
 * Deps that "find" the parts in a literal table: name -> exports, or a function that throws.
 * @param {Record<string, unknown>} table
 */
function tableDeps(table) {
    /** @type {string[]} */
    const asked = [];
    return {
        asked,
        find: (/** @type {string} */ name) => { asked.push(name); return name in table ? `/virtual/${name}.js` : null; },
        load: (/** @type {string} */ file) => {
            const exported = table[path.basename(file, '.js')];
            return typeof exported === 'function' ? exported() : exported;
        },
    };
}

describe('withParts', () => {
    test('no part file: the composition is its base, and every part was looked for', () => {
        const deps = tableDeps({});
        assert.deepStrictEqual(withParts({ id: 'm1', requires: [], uses: ['m2'] }, deps), { id: 'm1', requires: [], uses: ['m2'] });
        assert.deepStrictEqual(deps.asked, ['m1.mounts', 'm1.register', 'm1.jobs', 'm1.stores']);
    });

    test('the parts that exist are merged', () => {
        const register = () => {};
        const comp = withParts({ id: 'm1' }, tableDeps({
            'm1.register': { register, provides: { featureModules: ['x'] } },
            'm1.stores': { stores: [{ name: 's', file: './stores/s' }], migrations: ['mig'] },
        }));
        assert.deepStrictEqual(comp, {
            id: 'm1', register, provides: { featureModules: ['x'] }, stores: [{ name: 's', file: './stores/s' }], migrations: ['mig'],
        });
    });

    test('a part that throws while it loads throws (it is not swallowed)', () => {
        const deps = tableDeps({ 'm1.jobs': () => { throw new Error('broken part'); } });
        assert.throws(() => withParts({ id: 'm1' }, deps), /broken part/);
    });

    test('a part may only export the keys of its kind', () => {
        assert.throws(() => withParts({ id: 'm1' }, tableDeps({ 'm1.mounts': { jobs: [] } })),
            /firstParty\/m1\.mounts\.js exports "jobs"; a mounts part holds mounts, aiMounts/);
    });

    test('a key the base already has is refused', () => {
        assert.throws(() => withParts({ id: 'm1', requires: [] }, tableDeps({ 'm1.register': { provides: {}, requires: [] } })),
            /exports "requires"/);
        const base = /** @type {any} */ ({ id: 'm1', stores: [] });
        assert.throws(() => withParts(base, tableDeps({ 'm1.stores': { stores: [] } })), /already has/);
    });

    test('a part that exports no object is refused', () => {
        assert.throws(() => withParts({ id: 'm1' }, tableDeps({ 'm1.stores': [] })), /must export an object/);
    });

    test('PART_KEYS covers every list of the contract once', () => {
        const all = Object.values(PART_KEYS).flat();
        assert.strictEqual(new Set(all).size, all.length);
        assert.deepStrictEqual(all.sort(), ['afterListen', 'aiMounts', 'close', 'drain', 'jobs', 'migrations', 'mounts', 'nlTranslations', 'provides', 'register', 'stores']);
    });
});

describe('optionalPart through the tree', () => {
    test('a part file that does not exist yields null', () => {
        assert.strictEqual(optionalPart('no_such_module.mounts'), null);
    });

    test('a real file is required through the default loader', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-parts-'));
        try {
            const file = path.join(dir, 'm9.jobs.js');
            fs.writeFileSync(file, 'module.exports = { jobs: [] };\n');
            assert.deepStrictEqual(optionalPart('m9.jobs', { find: () => file }), { jobs: [] });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

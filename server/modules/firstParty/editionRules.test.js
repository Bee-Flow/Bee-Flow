/**
 * modules/firstParty/editionRules.js: which modules an edition makes available, and the log
 * lines that say so. The loader with an edition is in loader.test.js, the real tree in
 * compositions.test.js.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const edition = require('./editionRules');

/** A log that keeps its lines as [level, first argument]. */
function lineLog() {
    /** @type {Array<[string, string]>} */
    const lines = [];
    return {
        lines,
        info: (/** @type {unknown} */ text) => { lines.push(['info', String(text)]); },
        warn: (/** @type {unknown} */ text) => { lines.push(['warn', String(text)]); },
        error: (/** @type {unknown} */ text) => { lines.push(['error', String(text)]); },
    };
}

describe('availableIds (the edition rule)', () => {
    const REQUIRES = /** @type {Record<string, string[]>} */ ({
        automation: ['datatables'], apps: ['datatables', 'automation'], cowork: ['automation'], datatables: [],
        playbooks: ['apps', 'automation', 'datatables'], learning: [], int_google: [], loose: ['deep'], deep: ['deeper'], deeper: [],
    });
    const IDS = Object.keys(REQUIRES).sort();
    const SWITCHED = new Set(['automation', 'apps', 'learning']);
    /** @param {string[] | null} listed null: no edition in force */
    function pick(listed) {
        /** @type {string[]} */
        const asked = [];
        const out = edition.availableIds(IDS, (id) => { asked.push(id); return REQUIRES[id] || []; }, {
            listed: (id) => listed === null || listed.includes(id),
            hasOwnSwitch: (id) => SWITCHED.has(id),
        });
        return { available: [...out.available].sort(), cameWith: Object.fromEntries(out.cameWith), asked };
    }

    test('no edition in force: every id, each asked once, in the order given', () => {
        const got = pick(null);
        assert.deepStrictEqual(got.available, IDS);
        assert.deepStrictEqual(got.cameWith, {});
        assert.deepStrictEqual(got.asked, IDS);
    });

    test('a listed module brings what it requires that has no switch of its own (automation brings datatables)', () => {
        assert.deepStrictEqual(pick(['automation']), { available: ['automation', 'datatables'], cameWith: { datatables: 'automation' }, asked: ['automation', 'datatables'] });
    });

    test('a module with its own switch never comes along (playbooks does not bring apps or automation)', () => {
        const got = pick(['playbooks']);
        assert.deepStrictEqual(got.available, ['datatables', 'playbooks']);
        assert.deepStrictEqual(got.cameWith, { datatables: 'playbooks' });
    });

    test('through other modules without a switch, and only the available ones are asked', () => {
        const got = pick(['loose', 'learning']);
        assert.deepStrictEqual(got.available, ['deep', 'deeper', 'learning', 'loose']);
        assert.deepStrictEqual(got.cameWith, { deep: 'loose', deeper: 'deep' });
        assert.deepStrictEqual(got.asked, ['learning', 'loose', 'deep', 'deeper']);
    });

    test('core: nothing; an unlisted module is never asked for its requires', () => {
        assert.deepStrictEqual(pick([]), { available: [], cameWith: {}, asked: [] });
        assert.deepStrictEqual(pick(['cowork']).available, ['cowork'], 'cowork is available; the loader makes it absent because automation is not');
    });

    test('a require of an id that is not in the tree is ignored here', () => {
        const out = edition.availableIds(['a'], () => ['nowhere'], { listed: () => true, hasOwnSwitch: () => false });
        assert.deepStrictEqual([...out.available], ['a']);
    });
});

describe('editionRule and reportEdition', () => {
    test('a catalog double with isModuleAvailable alone: listed is that answer, every id has its own switch, no edition in force', () => {
        const rule = edition.editionRule({ isModuleAvailable: (id) => id !== 'x' });
        assert.deepStrictEqual([rule.listed('a'), rule.listed('x'), rule.hasOwnSwitch('a'), rule.inForce], [true, false, true, false]);
    });

    test('the real catalog parts: availableByEdition lists, getModule decides the own switch', () => {
        const rule = edition.editionRule({
            isModuleAvailable: () => true, availableByEdition: (id) => id === 'int_google',
            getModule: (id) => (id === 'learning' ? { id } : null), editionChoice: () => ({ inForce: true, named: ['int_google'] }),
        });
        assert.deepStrictEqual([rule.listed('int_google'), rule.listed('learning'), rule.hasOwnSwitch('learning'), rule.hasOwnSwitch('cms')], [true, false, true, false]);
        assert.deepStrictEqual([rule.inForce, rule.named], [true, ['int_google']]);
    });

    const MODS = [
        { id: 'apps', state: 'absent', detail: 'not available in this edition' },
        { id: 'automation', state: 'loaded' },
        { id: 'cowork', state: 'absent', detail: 'it requires "x", which is not available in this edition' },
        { id: 'datatables', state: 'loaded' },
    ];
    const PICKED = { available: new Set(['automation', 'datatables', 'cowork']), cameWith: new Map([['datatables', 'automation']]) };

    test('the edition line names what came along and why a chosen module is absent all the same', () => {
        assert.strictEqual(edition.editionLine(MODS, PICKED),
            '[modules] edition: core + automation, datatables (comes with automation); left out: apps, cowork (it requires "x", which is not available in this edition)');
        assert.strictEqual(edition.editionLine([{ id: 'a', state: 'absent' }], { available: new Set(), cameWith: new Map() }), '[modules] edition: core; left out: a');
    });

    test('one warning for unknown ids (a catalog id is known), one info line; nothing without an edition', () => {
        const log = lineLog();
        const base = { listed: () => false, hasOwnSwitch: (/** @type {string} */ id) => id === 'approvals' };
        edition.reportEdition(log, { ...base, inForce: false, named: ['nope'] }, PICKED, MODS);
        assert.deepStrictEqual(log.lines, []);
        edition.reportEdition(log, { ...base, inForce: true, named: ['automation', 'approvals', 'nope'] }, PICKED, MODS);
        assert.deepStrictEqual(log.lines, [
            ['warn', '[modules] BEEFLOW_MODULES names unknown module(s) nope; ignored. Known: apps, automation, cowork, datatables'],
            ['info', edition.editionLine(MODS, PICKED)],
        ]);
    });
});

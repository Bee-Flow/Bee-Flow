/**
 * safeInstallGrants (./grants.js), on its own — belt and braces.
 *
 * The install path is protected TWICE, and the outer layer hides the inner
 * one: sanitizeManifest strips every `ai.public*` key before install ever
 * sees the manifest, so an end-to-end test cannot tell whether install's own
 * rule is doing anything. A rule that is only enforced upstream is a rule that
 * disappears the day somebody adds a second way in (upgrade, a script, a
 * repair tool). So the rule is asserted HERE, against a raw entity that still
 * carries everything a hand-made file could carry. The end-to-end install
 * tests live in ../install.test.js.
 *
 * Run: cd server && node --test projects/packaging/install/grants.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { safeInstallGrants } = require('./grants');
// The REAL normalizer and the REAL default: these two turn a patch into the
// row that would actually be written, so the assertions are about what a page
// ENDS UP with.
const { normalizeBridgeGrants, DEFAULT_BRIDGE_GRANTS } = require('../../../stores/webpage/bridgeGrants');

test('safeInstallGrants writes the store default over ANY public-AI request', () => {
    const patch = safeInstallGrants(
        { bridgeGrants: { ai: { enabled: true, publicEnabled: true, publicGroundOnPage: true, publicSpendCapUsd: 50 } } },
        new Map(),
    );
    assert.deepStrictEqual(patch.ai, { ...DEFAULT_BRIDGE_GRANTS.ai });
    const row = normalizeBridgeGrants(patch);
    assert.strictEqual(row.ai.publicEnabled, false);
    assert.strictEqual(row.ai.publicGroundOnPage, false);
    assert.strictEqual(row.ai.publicSpendCapUsd, DEFAULT_BRIDGE_GRANTS.ai.publicSpendCapUsd);
});

test('safeInstallGrants never carries an integration grant, fixedArgs or not', () => {
    const patch = safeInstallGrants(
        { bridgeGrants: { integrations: [{ tool: 'gmail_send' }, { tool: 'nextcloud_upload_file', fixedArgs: { path: '/x' } }] } },
        new Map(),
    );
    assert.deepStrictEqual(patch.integrations, [],
        'the bridge runs as the page author — a tool name IS the authority being asked for');
});

test('safeInstallGrants keeps an in-bundle ref and drops everything else', () => {
    const refMap = new Map([['aut_1', 'real_aut_1']]);
    const unresolved = [];
    const patch = safeInstallGrants({
        bridgeGrants: {
            automations: [
                { automationId: { $ref: 'aut_1' }, label: 'Run' },   // in bundle → kept
                { automationId: { $ref: 'aut_gone' } },              // in file, never landed → dropped + named
                { automationId: 'aut_from_their_instance' },         // another installation's row → dropped
                { automationId: null },
                'not-even-an-object',
            ],
        },
    }, refMap, unresolved);

    assert.deepStrictEqual(patch.automations, [{ automationId: 'real_aut_1', label: 'Run' }]);
    assert.deepStrictEqual(unresolved, ['aut_gone'], 'a grant that could not be connected is named, not silently gone');
});

test('safeInstallGrants writes its six keys and only those', () => {
    // updateBridgeGrants replaces the WHOLE column, so a grant kind install does
    // not vouch for starts EMPTY on an installed page rather than arriving from
    // a file. A table or agent named by a bare id (another installation's row)
    // is such a grant; a kind the normalizer does not know (somethingNew) too.
    const patch = safeInstallGrants(
        { bridgeGrants: {
            tables: [{ datatableId: 't', mode: 'readwrite' }],
            agent: { agentId: 'a' },
            somethingNew: true,
        } },
        new Map(),
    );
    assert.deepStrictEqual(Object.keys(patch).sort(), ['agent', 'ai', 'automations', 'db', 'integrations', 'tables']);

    const column = normalizeBridgeGrants(patch);
    assert.deepStrictEqual(Object.keys(column).sort(), ['agent', 'ai', 'automations', 'db', 'integrations', 'tables']);
    assert.deepStrictEqual(column.tables, [], 'a bare table id names nothing in this bundle');
    assert.strictEqual(column.agent, null);
    assert.strictEqual(column.somethingNew, undefined);
});

test('safeInstallGrants carries an in-bundle table and agent, never public columns (F14)', () => {
    const unresolved = [];
    const patch = safeInstallGrants(
        { bridgeGrants: {
            tables: [
                { datatableId: { $ref: 'dt_1' }, mode: 'readwrite', columns: ['name', 7], publicColumns: ['name'] },
                { datatableId: { $ref: 'dt_gone' }, mode: 'read' },
                { datatableId: null, mode: 'read' },
            ],
            agent: { agentId: { $ref: 'agt_1' } },
        } },
        new Map([['dt_1', 'tbl_real'], ['agt_1', 'agt_real']]),
        unresolved,
    );
    assert.deepStrictEqual(patch.tables, [{ datatableId: 'tbl_real', mode: 'readwrite', columns: ['name'], publicColumns: [] }]);
    assert.deepStrictEqual(patch.agent, { agentId: 'agt_real' });
    assert.deepStrictEqual(unresolved, ['dt_gone']);
    // And it survives the store's normaliser as written.
    assert.deepStrictEqual(normalizeBridgeGrants(patch).tables, patch.tables);
});

test('safeInstallGrants treats a page with no grants and a page with junk grants alike', () => {
    const empty = safeInstallGrants({}, new Map());
    assert.deepStrictEqual(empty, {
        ai: { ...DEFAULT_BRIDGE_GRANTS.ai }, automations: [], integrations: [], tables: [], agent: null, db: { viewersMayWrite: false },
    });
    assert.deepStrictEqual(safeInstallGrants({ bridgeGrants: 'nope' }, new Map()), empty);
    assert.deepStrictEqual(safeInstallGrants({ bridgeGrants: { automations: 'nope', integrations: 'nope', tables: 'nope', agent: 'nope', db: 'nope' } }, new Map()), empty);
});

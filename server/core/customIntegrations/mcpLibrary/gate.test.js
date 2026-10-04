/**
 * Which org-scoped custom integrations may run right now (./gate.js).
 *
 * Two families share one table: AI Integration Builder rows (governed by the
 * builder's kill switch) and MCP library rows (governed by the server-wide
 * org MCP policy, checked against the endpoint the row was ACTIVATED with).
 * The two gates are deliberately not OR-ed together. What this file pins:
 *
 *   - isLibraryRow reads kind + meta.source of the RUNNING definition
 *     (activated snapshot, or the draft for a draft row);
 *   - a library row runs iff the policy allows its ACTIVATED url (a draft
 *     edit pointing elsewhere changes nothing until re-activation);
 *   - a builder row runs iff the builder flag is on, whatever the policy says;
 *   - anyRunnable is false only when the builder is off AND the policy is 'off'.
 *
 * No module mocking: deps.isBuilderEnabled and deps.configStore are replaced
 * on the seam object.
 *
 * Run: cd server && node --test core/customIntegrations/mcpLibrary/gate.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');

const deps = require('./deps');
const { LIBRARY_SOURCE, isLibraryRow, runningDefinition, loadRunGate } = require('./gate');
const { validateCustomIntegration } = require('../validateCustomIntegration');

const ORIGINAL = { isBuilderEnabled: deps.isBuilderEnabled, configStore: deps.configStore };
afterEach(() => Object.assign(deps, ORIGINAL));

/** Point the gate at a builder flag and a stored policy. */
function world({ builder = false, policy = null } = {}) {
    deps.isBuilderEnabled = async () => builder;
    deps.configStore = () => ({ getConfig: async () => policy });
}

const OFFICIAL_URL = 'https://mcp.linear.app/mcp';
const CUSTOM_URL = 'https://mcp.corp.example.org/mcp';

const libDef = (url) => ({ specVersion: 1, meta: { source: LIBRARY_SOURCE }, mcp: { url, authStyle: 'none' } });
const builderDef = (url) => ({ specVersion: 1, meta: { docsUrl: 'https://docs.example.org' }, mcp: { url, authStyle: 'none' } });

const libraryRow = (activatedUrl, draftUrl = activatedUrl) => ({
    id: 'lib-1', kind: 'mcp_remote', status: 'active',
    definition: libDef(draftUrl), activatedDefinition: libDef(activatedUrl),
});
const builderRow = (url = OFFICIAL_URL) => ({
    id: 'b-1', kind: 'mcp_remote', status: 'active',
    definition: builderDef(url), activatedDefinition: builderDef(url),
});
const restRow = () => ({
    id: 'r-1', kind: 'rest', status: 'active',
    definition: { specVersion: 1, meta: { source: LIBRARY_SOURCE } }, activatedDefinition: { specVersion: 1, meta: { source: LIBRARY_SOURCE } },
});

describe('runningDefinition', () => {
    it('prefers the activated snapshot, then its snake_case form, then the draft', () => {
        const a = { x: 'activated' };
        const s = { x: 'snake' };
        const d = { x: 'draft' };
        assert.strictEqual(runningDefinition({ activatedDefinition: a, activated_definition: s, definition: d }), a);
        assert.strictEqual(runningDefinition({ activatedDefinition: null, activated_definition: s, definition: d }), s);
        assert.strictEqual(runningDefinition({ activatedDefinition: null, definition: d }), d);
    });

    it('is null for nothing usable', () => {
        for (const v of [null, undefined, 'row', 42, {}]) assert.strictEqual(runningDefinition(v), null, JSON.stringify(v));
    });
});

describe('isLibraryRow', () => {
    it('an mcp_remote row whose activated definition carries the marker', () => {
        assert.strictEqual(isLibraryRow(libraryRow(OFFICIAL_URL)), true);
    });

    it('a draft row (never activated) is judged by its draft', () => {
        assert.strictEqual(isLibraryRow({ kind: 'mcp_remote', status: 'draft', definition: libDef(OFFICIAL_URL), activatedDefinition: null }), true);
        assert.strictEqual(isLibraryRow({ kind: 'mcp_remote', status: 'draft', definition: builderDef(OFFICIAL_URL), activatedDefinition: null }), false);
    });

    it('the activated snapshot wins over the draft, both ways', () => {
        assert.strictEqual(isLibraryRow({ kind: 'mcp_remote', definition: libDef(OFFICIAL_URL), activatedDefinition: builderDef(OFFICIAL_URL) }), false);
        assert.strictEqual(isLibraryRow({ kind: 'mcp_remote', definition: builderDef(OFFICIAL_URL), activatedDefinition: libDef(OFFICIAL_URL) }), true);
    });

    it('reads the snake_case activated_definition of an unshaped row', () => {
        assert.strictEqual(isLibraryRow({ kind: 'mcp_remote', definition: {}, activated_definition: libDef(OFFICIAL_URL) }), true);
    });

    it('a REST row is never a library row, marker or not', () => {
        assert.strictEqual(isLibraryRow(restRow()), false);
    });

    it('a builder row, another marker, or no definition is not a library row', () => {
        assert.strictEqual(isLibraryRow(builderRow()), false);
        assert.strictEqual(isLibraryRow({ kind: 'mcp_remote', definition: { meta: { source: 'builder' } } }), false);
        assert.strictEqual(isLibraryRow({ kind: 'mcp_remote', definition: { meta: { source: 'MCP_LIBRARY' } } }), false);
        assert.strictEqual(isLibraryRow({ kind: 'mcp_remote', definition: { meta: null } }), false);
        assert.strictEqual(isLibraryRow({ kind: 'mcp_remote' }), false);
        for (const v of [null, undefined, {}, 'x']) assert.strictEqual(isLibraryRow(v), false);
    });
});

describe('loadRunGate', () => {
    it('a library row on an official endpoint runs under the default policy, builder off', async () => {
        world({ builder: false, policy: null });
        const gate = await loadRunGate();
        assert.strictEqual(gate.builderEnabled, false);
        assert.deepStrictEqual(gate.policy, { remote: 'official', allowedHosts: [] });
        assert.strictEqual(gate.isRunnable(libraryRow(OFFICIAL_URL)), true);
    });

    it('it is the ACTIVATED url that counts, not a draft edit', async () => {
        world({ policy: { remote: 'official' } });
        const gate = await loadRunGate();
        // Draft now points at an allowed host; what runs does not.
        assert.strictEqual(gate.isRunnable(libraryRow(CUSTOM_URL, OFFICIAL_URL)), false);
        // Draft now points at a refused host; what runs is still allowed.
        assert.strictEqual(gate.isRunnable(libraryRow(OFFICIAL_URL, CUSTOM_URL)), true);
    });

    it('allowlist and any modes admit a custom endpoint they cover', async () => {
        world({ policy: { remote: 'allowlist', allowedHosts: ['*.corp.example.org'] } });
        assert.strictEqual((await loadRunGate()).isRunnable(libraryRow(CUSTOM_URL)), true);
        world({ policy: { remote: 'allowlist', allowedHosts: ['other.example.org'] } });
        assert.strictEqual((await loadRunGate()).isRunnable(libraryRow(CUSTOM_URL)), false);
        world({ policy: { remote: 'any' } });
        assert.strictEqual((await loadRunGate()).isRunnable(libraryRow(CUSTOM_URL)), true);
    });

    it('policy off stops every library row, even with the builder on', async () => {
        world({ builder: true, policy: { remote: 'off' } });
        const gate = await loadRunGate();
        assert.strictEqual(gate.isRunnable(libraryRow(OFFICIAL_URL)), false);
        assert.strictEqual(gate.anyRunnable, true, 'builder rows can still run');
    });

    it('a library row with a broken or plain-http activated url never runs', async () => {
        world({ policy: { remote: 'any' } });
        const gate = await loadRunGate();
        assert.strictEqual(gate.isRunnable(libraryRow('http://mcp.example.org/mcp')), false);
        assert.strictEqual(gate.isRunnable(libraryRow('not a url')), false);
        const noMcp = { kind: 'mcp_remote', activatedDefinition: { meta: { source: LIBRARY_SOURCE } }, definition: {} };
        assert.strictEqual(gate.isRunnable(noMcp), false);
    });

    it('a builder row runs iff the builder flag is on, whatever the policy says', async () => {
        for (const remote of ['off', 'official', 'allowlist', 'any']) {
            world({ builder: true, policy: { remote } });
            assert.strictEqual((await loadRunGate()).isRunnable(builderRow(CUSTOM_URL)), true, `builder on, ${remote}`);
            assert.strictEqual((await loadRunGate()).isRunnable(restRow()), true, `rest row, builder on, ${remote}`);
            world({ builder: false, policy: { remote } });
            assert.strictEqual((await loadRunGate()).isRunnable(builderRow(OFFICIAL_URL)), false, `builder off, ${remote}`);
            assert.strictEqual((await loadRunGate()).isRunnable(restRow()), false, `rest row, builder off, ${remote}`);
        }
    });

    it('anyRunnable is false only when the builder is off AND the policy is off', async () => {
        const combos = [
            [false, 'off', false],
            [true, 'off', true],
            [false, 'official', true],
            [true, 'any', true],
            [false, 'allowlist', true],
        ];
        for (const [builder, remote, expected] of combos) {
            world({ builder, policy: { remote } });
            assert.strictEqual((await loadRunGate()).anyRunnable, expected, `builder=${builder} remote=${remote}`);
        }
    });

    it('no row is never runnable', async () => {
        world({ builder: true, policy: { remote: 'any' } });
        const gate = await loadRunGate();
        assert.strictEqual(gate.isRunnable(null), false);
        assert.strictEqual(gate.isRunnable(undefined), false);
    });

    it('an unreachable config store reads as the default policy, not wider', async () => {
        deps.isBuilderEnabled = async () => false;
        deps.configStore = () => ({ getConfig: async () => { throw new Error('db down'); } });
        const gate = await loadRunGate();
        assert.strictEqual(gate.policy.remote, 'official');
        assert.strictEqual(gate.isRunnable(libraryRow(OFFICIAL_URL)), true);
        assert.strictEqual(gate.isRunnable(libraryRow(CUSTOM_URL)), false);
    });

    it('reads the two switches once, then answers per row synchronously', async () => {
        let flagReads = 0;
        let configReads = 0;
        deps.isBuilderEnabled = async () => { flagReads++; return true; };
        deps.configStore = () => ({ getConfig: async () => { configReads++; return { remote: 'official' }; } });
        const gate = await loadRunGate();
        for (let i = 0; i < 10; i++) {
            assert.strictEqual(typeof gate.isRunnable(libraryRow(OFFICIAL_URL)), 'boolean');
        }
        assert.strictEqual(flagReads, 1);
        assert.strictEqual(configReads, 1);
    });
});

describe('the library marker', () => {
    it('cannot be written through a definition the builder accepts', async () => {
        // A builder-authored definition that claims the library marker.
        const claimed = { specVersion: 1, meta: { source: LIBRARY_SOURCE }, mcp: { url: OFFICIAL_URL, authStyle: 'none' } };
        const verdict = validateCustomIntegration(claimed, { kind: 'mcp_remote', strict: true, slug: 'abcd1234' });

        // What the builder's activate route would then freeze:
        const row = { kind: 'mcp_remote', status: 'active', definition: claimed, activatedDefinition: claimed };
        world({ builder: false, policy: { remote: 'official' } });
        const runsWithBuilderOff = (await loadRunGate()).isRunnable(row);

        assert.ok(!verdict.ok || !runsWithBuilderOff,
            `the builder validator accepted the marker (ok=${verdict.ok}) and the row runs with the builder switched off (${runsWithBuilderOff})`);
    });
});

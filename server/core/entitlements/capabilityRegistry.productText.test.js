// @typecheck strict
/**
 * What admins read on the Access screens and in the plan editor: every beta
 * and integration they can grant carries a short product description, never
 * the engineering text of betaCatalog.js (routes it gates, data structures,
 * a vendor it is "powered by"), and a beta's name does not repeat "(Beta)"
 * under the "Beta features" heading.
 *
 * Run: node --test server/core/entitlements/capabilityRegistry.productText.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { listCapabilities } = require('./capabilityRegistry');

/** Text that belongs in code, not in an admin screen. */
const DEVELOPER_TEXT = ['/api/', 'DAG', 'Gates ', 'PowerApps', 'Voxtral', 'Mistral', 'GetConnectors', 'SELECT', 'diarization', 'headless', 'Syntess'];

/** @returns {Array<{ id: string, kind: string, name: string, description: string, userFacing?: boolean }>} */
function shown() {
    return /** @type {any[]} */ (listCapabilities()).filter(c => c.userFacing && (c.kind === 'beta' || c.kind === 'integration'));
}

describe('capability registry: the text admins read', () => {
    it('has no developer text in a grantable beta or integration description', () => {
        const offenders = shown().flatMap(c => DEVELOPER_TEXT.filter(w => (c.description || '').includes(w)).map(w => `${c.id}: ${w}`));
        assert.deepEqual(offenders, []);
    });

    it('does not repeat "(Beta)" in a beta name', () => {
        assert.deepEqual(shown().filter(c => c.kind === 'beta' && / \(Beta\)$/.test(c.name)).map(c => c.id), []);
    });

    it('keeps the descriptions short enough for one line under the name', () => {
        assert.deepEqual(shown().filter(c => (c.description || '').length > 180).map(c => c.id), []);
    });
});

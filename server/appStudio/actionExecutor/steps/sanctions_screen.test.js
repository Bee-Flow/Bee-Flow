'use strict';
/**
 * The App Studio step `sanctions_screen`: access for the app's owner (licence + org switch),
 * bindings resolved, the screening's result as the step's result, failures as sentences.
 * Run: cd server && node --test appStudio/actionExecutor/steps/sanctions_screen.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { runSanctionsScreen } = require('./sanctions_screen.mts');

const app = { id: 'app1', userId: 'owner', organizationId: 'org1' };

function deps({ access = { ok: true }, screen = async (input) => ({ candidates: [], candidateCount: 0, input }) } = {}) {
    const seen = { access: [], screened: [] };
    return {
        seen,
        deps: {
            service: () => ({
                access: async (scope, integrationOn) => { seen.access.push({ scope, hasSwitch: typeof integrationOn === 'function' }); return access; },
                screen: async (input) => { seen.screened.push(input); return screen(input); },
            }),
            integrationOn: async () => true,
            // A binding here is { value } so the test sees what was resolved.
            resolve: (binding) => (binding && typeof binding === 'object' ? binding.value : undefined),
        },
    };
}

test('resolves the bindings and returns the screening as the result', async () => {
    const { seen, deps: d } = deps();
    const out = await runSanctionsScreen(app, {
        kind: 'sanctions_screen', name: { value: 'Aldo Examplo' }, birthDate: { value: 1968 }, function: { value: 'Minister' },
        lists: ['un_sc'], minScore: 0.9, maxResults: 3, resultVar: 'screening',
    }, {}, d);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(seen.access, [{ scope: { userId: 'owner', orgId: 'org1' }, hasSwitch: true }]);
    assert.deepStrictEqual(seen.screened[0], { name: 'Aldo Examplo', birthDate: '1968', country: undefined, function: 'Minister', lists: ['un_sc'], minScore: 0.9, maxResults: 3 });
});

test('a refusal from access is the step\'s failure, with its code', async () => {
    const { deps: d } = deps({ access: { ok: false, code: 'integration_off', error: 'Sanctions lists are switched off for this organisation.' } });
    const out = await runSanctionsScreen(app, { kind: 'sanctions_screen', name: { value: 'X Y' } }, {}, d);
    assert.deepStrictEqual(out, { ok: false, code: 'integration_off', error: 'Sanctions lists are switched off for this organisation.', retryable: false });
});

test('nothing to screen, or a store failure, are sentences', async () => {
    const empty = await runSanctionsScreen(app, { kind: 'sanctions_screen', name: { value: '  ' } }, {}, deps().deps);
    assert.strictEqual(empty.ok === false && empty.code, 'bad_input');
    const broken = await runSanctionsScreen(app, { kind: 'sanctions_screen', name: { value: 'A B' } }, {}, deps({ screen: async () => { throw new Error('connection refused'); } }).deps);
    assert.deepStrictEqual(broken, { ok: false, code: 'sanctions_unavailable', error: 'The sanctions lists could not be read just now. Try again in a moment.', retryable: true });
});

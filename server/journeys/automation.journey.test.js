'use strict';

/**
 * Journey: a member builds an automation and runs it.
 *
 * Create (a draft with a manual trigger and one `set` step) → dry run (the
 * working copy runs, nothing is live) → activate → run → read the run's steps
 * back, the computed field included. A member of another organisation does not
 * see the automation or its run.
 *
 * Run: cd server && npm run test:journeys
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openWorld } = require('./journeyWorld.testkit');

const PW = 'Copper-harbour-2290!';

const DEFINITION = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'greet', type: 'set', fields: { greeting: { kind: 'template', value: 'Hello {{trigger.output.name}}' } } },
    ],
    edges: [{ from: 'trg', to: 'greet' }],
};

/** @type {Awaited<ReturnType<typeof openWorld>>} */
let world;

before(async () => {
    world = await openWorld({ mounts: ['auth', 'automation'] });
    await world.seedOrg({ id: 'org-auto-a', name: 'Automation org A' });
    await world.seedOrg({ id: 'org-auto-b', name: 'Automation org B' });
    await world.seedUser({ id: 'auto-maker', password: PW, organizationId: 'org-auto-a', orgRole: 'member' });
    await world.seedUser({ id: 'auto-outsider', password: PW, organizationId: 'org-auto-b', orgRole: 'member' });
}, { timeout: 120_000 });

after(() => world?.close());

test('create → dry run → activate → run → read the run steps; another organisation sees none of it', { timeout: 60_000 }, async () => {
    const maker = await world.login('auto-maker', PW);

    const created = await maker.call('POST', '/api/automation', { body: { title: 'Greeter', definition: DEFINITION, triggerType: 'manual' } });
    assert.equal(created.status, 200, created.text);
    const id = created.body.automation.id;

    const dry = await maker.call('POST', `/api/automation/${id}/dry-run`, { body: { triggerPayload: { name: 'Ada' } } });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.body.run.status, 'success', dry.text.slice(0, 600));
    const dryGreet = dry.body.steps.find((/** @type {{ stepId: string }} */ s) => s.stepId === 'greet');
    assert.equal(dryGreet?.output?.greeting, 'Hello Ada', JSON.stringify(dry.body.steps));

    const activated = await maker.call('POST', `/api/automation/${id}/activate`, { body: {} });
    assert.equal(activated.status, 200, activated.text);

    const run = await maker.call('POST', `/api/automation/${id}/run`, { body: { triggerPayload: { name: 'Grace' } } });
    assert.equal(run.status, 200, run.text);
    assert.equal(run.body.run.status, 'success', run.text.slice(0, 600));
    const runId = run.body.run.id;

    const steps = await maker.call('GET', `/api/automation/runs/${runId}/steps`);
    assert.equal(steps.status, 200, steps.text);
    const list = Array.isArray(steps.body) ? steps.body : steps.body.steps;
    const greet = list.find((/** @type {{ stepId: string }} */ s) => s.stepId === 'greet');
    assert.equal(greet?.output?.greeting, 'Hello Grace', JSON.stringify(list));

    const runs = await maker.call('GET', `/api/automation/${id}/runs`);
    assert.equal(runs.status, 200, runs.text);
    const runRows = Array.isArray(runs.body) ? runs.body : runs.body.runs;
    assert.ok(runRows.some((/** @type {{ id: string }} */ r) => r.id === runId), 'the live run is in the run list');

    const outsider = await world.login('auto-outsider', PW);
    for (const url of [`/api/automation/${id}`, `/api/automation/runs/${runId}/steps`, `/api/automation/runs/${runId}`]) {
        const res = await outsider.call('GET', url);
        assert.ok(res.status === 403 || res.status === 404, `${url} as another organisation: ${res.status} ${res.text.slice(0, 200)}`);
    }
    const foreignRun = await outsider.call('POST', `/api/automation/${id}/run`, { body: {} });
    assert.ok(foreignRun.status === 403 || foreignRun.status === 404, `run as another organisation: ${foreignRun.status}`);
});

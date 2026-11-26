// @typecheck strict
const test = require('node:test');
const assert = require('node:assert/strict');
const { converse } = require('./coworkConversation');

test('questions use the selected steps of the current owned plan and the owner’s model tier', async () => {
    const item = { id: 'c', userId: 'owner', modelTier: 'deep', monthlyBudget: 25, enabledApps: ['fireflies'], isActive: true, title: 'Digest' };
    const pick = { message: 'Where does this go?', scope: { stepIds: ['send', 'sum'], fingerprint: 'f' }, view: 'overview', history: [] };
    const steps = [{ id: 'read' }, { id: 'sum' }, { id: 'send' }];
    const deps = {
        planStateOf: async () => /** @type {any} */ ({ draft: { fingerprint: 'f', view: { steps }, recipients: { send: 'owner' } } }),
        latestRun: async () => ({ status: 'failed', error: 'Mailbox unavailable' }),
        preview: async () => undefined,
        user: async () => ({ organizationId: 'org' }),
        /** @param {Parameters<typeof import('../core/cowork/coworkCompose').coworkTextTurn>[0]} turn */
        coworkTextTurn: async turn => {
            assert.equal(turn.tier, 'deep');
            assert.deepEqual([turn.userOrgId, turn.userId], ['org', 'owner']);
            const facts = JSON.parse(turn.messages[1].content);
            assert.deepEqual(facts.state.latestRun, { status: 'failed', error: 'Mailbox unavailable' });
            assert.deepEqual(facts.state.settings, { modelTier: 'deep', monthlyBudgetEur: 25, enabledApps: ['fireflies'], active: true });
            assert.equal(facts.message, pick.message);
            assert.deepEqual(facts.state.steps, steps);
            assert.deepEqual(facts.state.selected, pick.scope.stepIds);
            return JSON.stringify({ action: 'answer', answer: 'Only to you.' });
        },
    };
    assert.deepEqual(await converse(item, pick, deps), { action: 'answer', answer: 'Only to you.', instruction: '' });
    for (const bad of [{ fingerprint: 'old' }, { stepIds: ['unknown'] }]) {
        await assert.rejects(converse(item, { ...pick, scope: { ...pick.scope, ...bad } }, deps), { code: 'cowork_steps_changed' });
    }
});

test('Bee proposes a weekly clock in the task timezone, preserving omitted fields and never accepting arbitrary updates', () => {
    const { proposeClock } = require('./coworkConversationSchedule.mts');
    const item = { repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00', timezone: 'Europe/Amsterdam' };
    const now = Date.parse('2026-03-27T15:00:00Z');
    const schedule = proposeClock(item, { daysOfWeek: ['fri'], timeOfDay: '15:00' }, now);
    assert.deepEqual(schedule, { repeatInterval: 'weekly', daysOfWeek: ['fri'], timeOfDay: '15:00', timezone: 'Europe/Amsterdam', nextRunAt: '2026-04-03T13:00:00.000Z' });
    for (const invalid of [{}, {timeOfDay: '25:00'}, {daysOfWeek: []}, {isActive: false}, { repeatInterval: 'daily', daysOfWeek: ['mon'] }]) {
        assert.equal(proposeClock(item, invalid, now), null);
    }
    assert.equal(proposeClock({ ...item, triggerKind: 'webhook' }, { timeOfDay: '15:00' }, now), null);
});

test('result questions use the real run, or the current tested preview when no real run exists', async () => {
    const item = { id: 'c', userId: 'owner', repeatInterval: 'daily', timeOfDay: '09:00', timezone: 'UTC' };
    const turn = { message: 'Move it to 14:00', view: 'result', history: [] };
    for (const hasReal of [true, false]) {
        const reply = await converse(item, turn, {
            planStateOf: async () => /** @type {any} */ ({}),
            user: async () => null,
            latestRun: async () => hasReal ? { result: 'Live report.' } : null,
            preview: async () => { assert.equal(hasReal, false); return 'Trial report.'; },
            coworkTextTurn: async model => {
                assert.equal(JSON.parse(model.messages[1].content).output, JSON.stringify(hasReal ? 'Live report.' : 'Trial report.'));
                return JSON.stringify({ action: 'when', answer: 'Review this time.', schedule: { timeOfDay: '14:00' } });
            },
        });
        assert.equal(reply.schedule?.timeOfDay, '14:00');
        assert.equal(reply.schedule?.repeatInterval, 'daily');
        assert.equal(reply.schedule?.timezone, 'UTC');
    }
});

test('an overview question reads this task’s last completed result once and cannot trigger an action', async () => {
    const item = { id: 'owned', userId: 'owner' };
    const turn = { message: 'What were the action items?', view: 'overview', history: [] };
    let calls = 0, checks = 0;
    const reply = await converse(item, turn, {
        planStateOf: async () => /** @type {any} */ ({}),
        user: async () => null,
        latestRun: async () => ({status: 'running'}),
        recentRuns: async id => {
            assert.equal(id, item.id);
            return [{status: 'running'}, {status: 'success', result: 'Call Noor. ' + 'x'.repeat(9000)}];
        },
        preview: async () => assert.fail('a finished run exists'),
        checkSpend: async checked => { assert.equal(checked.id, item.id); checks++; },
        coworkTextTurn: async model => {
            const facts = JSON.parse(model.messages[1].content);
            if (++calls === 1) {
                assert.equal(facts.output, undefined);
                return JSON.stringify({action: 'read_result', answer: 'I’ll check.', id: 'another-task'});
            }
            assert.equal(facts.resultContext, 'run');
            assert.match(facts.output, /Call Noor/);
            assert.equal(facts.output.length, 6000);
            return JSON.stringify({action: 'change', instruction: 'Rewrite the task', answer: 'Call Noor.'});
        },
    });
    assert.deepEqual(reply, { action: 'answer', answer: 'Call Noor.', instruction: '' });
    assert.equal(calls, 2);
    assert.equal(checks, 1);
});

test('reading the output stops at a spent budget and never repeats the lookup when already viewing it', async () => {
    const item = { id: 'owned', userId: 'owner' };
    const turn = { message: 'Which actions?', view: 'overview', history: [] };
    let calls = 0, previews = 0;
    const deps = {
        planStateOf: async () => /** @type {any} */ ({}),
        user: async () => null, latestRun: async () => null,
        preview: async () => { previews++; return 'Preview'; },
        checkSpend: async () => { throw new Error('Budget exhausted'); },
        coworkTextTurn: async () => { calls++; return JSON.stringify({action: 'read_result', answer: 'No further details.'}); },
    };
    await assert.rejects(converse(item, turn, deps), /Budget exhausted/);
    assert.equal(calls, 1);
    assert.equal(previews, 0);
    assert.deepEqual(await converse(item, {...turn, view: 'result'}, deps), {action: 'answer', instruction: '', answer: 'No further details.'});
    assert.equal(calls, 2);
    assert.equal(previews, 1);
});

test('Bee resolves step removal against the owned plan and offers only relevant setting destinations', async () => {
    const item = {id: 'w1', userId: 'alice'};
    const scope = {stepIds: ['bell'], fingerprint: 'fp'};
    const turn = {message: 'Haal die melding weg', view: 'overview', history: [], scope};
    let intent = {action: 'remove_steps', answer: 'Ik maak het voorstel.', stepIds: ['bell']};
    const deps = {
        planStateOf: async () => /** @type {any} */ ({draft: {fingerprint: 'fp', view: {steps: [{id:'mail'}, {id:'bell',title:'Notification'}]}}, upToDate: true, tried: {current: true, status: 'failed', problems: ['Mailbox offline']}}),
        user: async () => null, latestRun: async () => null, preview: async () => '',
        /** @param {Parameters<typeof import('../core/cowork/coworkCompose').coworkTextTurn>[0]} model */
        coworkTextTurn: async model => {
            assert.equal(model.tier, 'thinking');
            assert.equal(JSON.parse(model.messages[1].content).state.plan.test.problems[0], 'Mailbox offline');
            return JSON.stringify(intent);
        },
    };
    const removed = await converse(item, turn, deps);
    assert.deepEqual(removed.remove, scope);
    intent.stepIds = ['mail'];
    await assert.rejects(converse(item, turn, deps), {code: 'cowork_steps_changed'});
    Object.assign(intent, {action: 'answer', choices: ['when', 'delete', 'when', 'uses']});
    assert.deepEqual((await converse(item, turn, deps)).choices, ['when', 'uses']);
});

test('Bee only opens an unambiguous accessible task on a switch request', async () => {
    const item = {id: 'current', userId: 'alice'};
    const turn = {message: 'Open mijn andere taak', view: 'overview', history: []};
    let action = 'find_tasks', query = '';
    const deps = {
        planStateOf: async () => /** @type {any} */ ({}), user: async () => null,
        latestRun: async () => null, preview: async () => '',
        coworkTextTurn: async () => JSON.stringify({action, query, answer: 'Even kijken.'}),
        /** @param {string} owner */
        tasks: async owner => {
            assert.equal(owner, item.userId);
            return [{id: 'current', title: 'Mijn taak'}, {id: 'w1', title: 'Weekoverzicht mail'},
                {id: 's1', title: 'Weekoverzicht meetings', ownerName: 'Noor'}];
        },
    };
    const all = await converse(item, turn, deps);
    assert.deepEqual(all.tasks?.map(t => t.id), ['w1', 's1']);
    assert.equal(all.switchTo, undefined);
    action = 'switch_task';
    query = 'weekoverzicht';
    assert.equal((await converse(item, turn, deps)).switchTo, undefined);
    query = 'weekoverzicht meetings';
    const shared = await converse(item, turn, deps);
    assert.equal(shared.switchTo, 's1');
    assert.equal(shared.tasks?.[0].shared, true);
    query = 'inaccessible';
    assert.deepEqual((await converse(item, turn, deps)).tasks, []);
});

// @typecheck
/**
 * The mailbox of an Outlook step and of the Outlook "New email" trigger, at
 * save time: "me"/absent or a shared mailbox's address. Half-typed addresses
 * save as a draft (autosave fires mid-keystroke) and block go-live; the step
 * and the poller check the value again at every run.
 *
 * Run: cd server && node --test automation/validate.outlookMailbox.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition } = require('./validate');

const lit = (/** @type {unknown} */ value) => ({ kind: 'literal', value });
const withStep = (/** @type {any} */ inputs) => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [{ id: 'read', type: 'integration_action', tool: 'outlook_list_recent', inputs }],
    edges: [{ from: 'trg', to: 'read' }],
});
const withTrigger = (/** @type {any} */ filter, event = 'mail.new') => ({
    trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'msgraph', event, filter } },
    steps: [{ id: 'read', type: 'integration_action', tool: 'outlook_read', inputs: { messageId: { kind: 'ref', path: 'trigger.output.resourceData.id' }, mailbox: { kind: 'ref', path: 'trigger.output.mailbox' } } }],
    edges: [{ from: 'trg', to: 'read' }],
});
const codes = (/** @type {any} */ r) => [...r.errors, ...r.warnings].map((/** @type {any} */ e) => e.code);

test('an Outlook step accepts no mailbox, "me", a shared address or a bound value', () => {
    for (const inputs of [{}, { mailbox: lit('me') }, { mailbox: lit('team@contoso.com') }, { mailbox: { kind: 'ref', path: 'trigger.output.mailbox' } }]) {
        const r = validateDefinition(withStep(inputs));
        assert.ok(!codes(r).includes('integration_action.mailbox_invalid'), JSON.stringify(inputs));
    }
});

test('a written-out mailbox that is no address blocks go-live but saves as a draft', () => {
    const def = withStep({ mailbox: lit('team@') });
    const live = validateDefinition(def);
    const e = /** @type {any} */ (live.errors.find((/** @type {any} */ x) => x.code === 'integration_action.mailbox_invalid'));
    assert.ok(e, 'blocks activation');
    assert.equal(e.path, 'steps[read].inputs.mailbox');
    const draft = validateDefinition(def, { stage: 'draft' });
    assert.ok(!draft.errors.some((/** @type {any} */ x) => x.code === 'integration_action.mailbox_invalid'));
});

test('the trigger: own inbox or a shared address on "New email"', () => {
    for (const filter of [null, { mailbox: 'me' }, { mailbox: 'team@contoso.com' }]) {
        const r = validateDefinition(withTrigger(filter));
        assert.ok(!codes(r).some((/** @type {string} */ c) => c.startsWith('trigger.mailbox')), JSON.stringify(filter));
    }
});

test('the trigger: a bad address, or a shared mailbox on an event that cannot watch one, is refused', () => {
    const bad = validateDefinition(withTrigger({ mailbox: 'x/../y' }));
    assert.ok(bad.errors.some((/** @type {any} */ e) => e.code === 'trigger.mailbox_invalid' && e.path === 'trigger.appEvent.filter.mailbox'));
    const flagged = validateDefinition(withTrigger({ mailbox: 'team@contoso.com' }, 'mail.flagged'));
    assert.ok(flagged.errors.some((/** @type {any} */ e) => e.code === 'trigger.mailbox_unsupported_event'));
});

test('an additional trigger is checked the same way', () => {
    const def = /** @type {any} */ (withTrigger(null));
    def.triggers = [{ id: 'trg2', kind: 'app_event', appEvent: { provider: 'msgraph', event: 'mail.new', filter: { mailbox: 'nope' } } }];
    def.edges.push({ from: 'trg2', to: 'read' });
    const r = validateDefinition(def);
    assert.ok(r.errors.some((/** @type {any} */ e) => e.code === 'trigger.mailbox_invalid' && e.path === 'triggers[trg2].appEvent.filter.mailbox'), JSON.stringify(r.errors));
});

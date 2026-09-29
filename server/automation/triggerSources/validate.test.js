const test = require('node:test');
const assert = require('node:assert');

const { validateTriggerSource } = require('./validate');

const codes = (decl) => validateTriggerSource(decl).filter(i => i.severity === 'error').map(i => i.code);

const ok = (over = {}) => ({
    id: 'acme',
    label: 'Acme',
    defaultEvent: 'widget.changed',
    availability: { kind: 'check', check: 'acme' },
    events: [event()],
    ...over,
});

const event = (over = {}) => ({
    id: 'widget.changed',
    label: 'Widget changed',
    fields: ['sku'],
    sample: { sku: 'W-1' },
    scope: 'user',
    source: {
        kind: 'poll_diff', tool: 'acme_list', requiresIntegration: 'acme',
        itemsPath: 'widgets', idPath: 'sku', changePaths: ['state'],
        emit: { mode: 'item', map: { sku: 'sku' } },
    },
    ...over,
});

test('a well-formed declaration passes', () => {
    assert.deepStrictEqual(codes(ok()), []);
});

test('the output contract must actually agree with itself', () => {
    // This is the join the old hardcoded test guarded, now enforced structurally.
    assert.ok(codes(ok({ events: [event({ fields: undefined })] })).includes('event.fields_missing'));
    assert.ok(codes(ok({ events: [event({ sample: undefined })] })).includes('event.sample_missing'));
    assert.ok(codes(ok({ events: [event({ fields: ['sku', 'colour'] })] })).includes('event.sample_field_missing'),
        'a declared field with no sample renders blank in the variable picker');
});

test('an event with no producer is refused rather than listed', () => {
    assert.ok(codes(ok({ events: [event({ source: undefined })] })).includes('event.source_missing'));
    assert.ok(codes(ok({ events: [event({ source: { kind: 'telepathy' } })] })).includes('event.source_kind_unknown'));
});

test('tenancy has no default — an unscoped event is a hard error', () => {
    assert.ok(codes(ok({ events: [event({ scope: undefined })] })).includes('event.scope_invalid'));
    assert.ok(codes(ok({ events: [event({ scope: 'everyone' })] })).includes('event.scope_invalid'));
});

test('one provider cannot mix scopes', () => {
    const decl = ok({ events: [event(), event({ id: 'widget.gone', scope: 'org' })] });
    assert.ok(codes(decl).includes('source.scope_conflict'));
});

test('ids are constrained and unique', () => {
    assert.ok(codes(ok({ id: 'Acme Corp' })).includes('source.id_invalid'));
    assert.ok(codes(ok({ events: [event({ id: 'Widget Changed' })] })).includes('event.id_invalid'));
    assert.ok(codes(ok({ events: [event(), event()] })).includes('event.id_duplicate'));
    assert.ok(validateTriggerSource(ok(), { existingIds: ['acme'] }).some(i => i.code === 'source.id_duplicate'));
});

test('availability must be resolvable, except for hidden label-only providers', () => {
    assert.ok(codes(ok({ availability: undefined })).includes('source.availability_unknown'));
    assert.ok(codes(ok({ availability: { kind: 'vibes' } })).includes('source.availability_unknown'));
    assert.ok(codes(ok({ availability: { kind: 'mcp' } })).includes('source.availability_mcp_no_server'));
    // github's shape: hidden, no events, no availability rule.
    assert.deepStrictEqual(codes({ id: 'github', label: 'GitHub', hidden: true, events: [] }), []);
});

test('a listed provider needs a listed event and a default that exists', () => {
    assert.ok(codes(ok({ events: [] })).includes('source.no_listed_events'));
    assert.ok(codes(ok({ events: [event({ hidden: true })] })).includes('source.no_listed_events'));
    assert.ok(codes(ok({ defaultEvent: 'nope' })).includes('source.default_event_unlisted'));
});

test('a poll_diff source is checked for the parts the runtime needs', () => {
    const src = (over) => ok({ events: [event({ source: { ...event().source, ...over } })] });
    assert.ok(codes(src({ tool: undefined })).includes('poll.tool_missing'));
    assert.ok(codes(src({ requiresIntegration: undefined })).includes('poll.requires_integration_missing'));
    assert.ok(codes(src({ idPath: undefined })).includes('poll.id_path_missing'));
    assert.ok(codes(src({ emit: undefined })).includes('poll.emit_missing'));
    assert.ok(codes(src({ emit: { mode: 'stream', map: { a: 'b' } } })).includes('poll.emit_mode_invalid'));
    // Nothing to detect: no change paths and no appear/disappear opt-in.
    assert.ok(codes(src({ changePaths: [] })).includes('poll.nothing_to_detect'));
    assert.deepStrictEqual(codes(src({ changePaths: [], emitOnAppear: true })), []);
    // Previous values live in the cursor, which has a hard byte budget.
    assert.ok(codes(src({ trackValues: true, maxTrackedItems: 500 })).includes('poll.track_values_too_many'));
});

test('a connector-gated event without an explanation warns but still loads', () => {
    const issues = validateTriggerSource(ok({ events: [event({ deliverability: 'connector' })] }));
    assert.ok(issues.some(i => i.code === 'event.deliverability_note_missing' && i.severity === 'warning'));
    assert.ok(!issues.some(i => i.severity === 'error'));
});

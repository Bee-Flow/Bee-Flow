const test = require('node:test');
const assert = require('node:assert');

const GOLDEN = require('./triggerRegistry.golden.json');
const { buildAppEventProviders } = require('./triggerProviders');
const { buildTriggerOutputsCatalog } = require('./triggerCatalog');

/**
 * Byte-identity guard for the app_event catalog.
 *
 * The eight built-in providers moved out of a hardcoded array in
 * triggerProviders.js and into per-integration declarations under
 * automation/triggerSources/declared/. Nothing about the wire format may change
 * in the process: the builder's provider/event dropdowns, the variable picker's
 * trigger.output.* paths, and every already-saved automation key on these exact
 * ids, this exact ordering, and these exact field lists.
 *
 * The fixture was captured from the pre-migration implementation and re-captured
 * when Nextcloud's push pipeline moved from AppAPI's (removed) `events_listener`
 * API to the bundled `webhook_listeners` app: that added forms.submitted,
 * tables.row.added, tables.row.updated and file.tagged, and cleared the
 * "will not fire yet" flag from the file and calendar mutation events. If a
 * change here is deliberate — a genuinely new event, a relabelled provider —
 * re-capture it in the same run as the code change, and say so in the commit.
 *
 * Re-capture with:
 *   node -e "const fs=require('fs');
 *     const {buildAppEventProviders}=require('./automation/builderTools/triggerProviders');
 *     const {buildTriggerOutputsCatalog}=require('./automation/builderTools/triggerCatalog');
 *     …write {providers: withoutNotes(...), outputs: ...} to the .json"
 *
 * Because re-capture blesses whatever the code currently produces, the
 * NEVER_REMOVE list below is the part that cannot be regenerated away.
 */

/**
 * Event ids that already shipped and that saved automations bind against.
 * Re-capturing the fixture must never make one of these disappear.
 */
const NEVER_REMOVE = {
    nextcloud: [
        'file.new', 'file.changed', 'file.deleted', 'file.renamed',
        'share.received', 'share.created', 'activity.new', 'notification.new',
        'calendar.event.upcoming', 'calendar.event.created', 'calendar.event.changed',
        'deck.card.created', 'deck.card.changed', 'deck.card.moved', 'deck.card.completed',
        'talk.message.received',
    ],
    gmail: ['mail.new', 'label.added'],
    'google-calendar': ['event.changed', 'event.upcoming'],
    'google-drive': ['file.new'],
    approvals: ['approval.decided', 'approval.requested'],
};

const FULL_CTX = {
    availableAppIds: new Set(['gmail', 'google-calendar', 'google-drive', 'nextcloud', 'outlook']),
    checks: { support: true, approvals: true },
    publicBaseUrl: true,
};

// `deliverabilityNote` is the one deliberate addition to the wire format: the
// per-event explanation used to be a hardcoded sentence naming Nextcloud in the
// frontend, so it now travels with the event that needs it. Strip it here so
// this assertion keeps proving that nothing was renamed, reordered or lost, and
// cover the addition on its own below.
function withoutNotes(providers) {
    return providers.map(p => ({
        ...p,
        events: p.events.map(({ deliverabilityNote, ...rest }) => rest),
    }));
}

test('app_event providers are byte-identical to the pre-migration catalog', () => {
    assert.deepStrictEqual(withoutNotes(buildAppEventProviders(FULL_CTX)), GOLDEN.providers);
});

test('connector-gated events carry their own explanation', () => {
    const events = buildAppEventProviders(FULL_CTX).flatMap(p => p.events);
    const gated = events.filter(e => e.deliverability === 'connector');
    assert.ok(gated.length > 0, 'fixture still has connector-gated events');
    for (const e of gated) {
        assert.ok(e.deliverabilityNote, `${e.id} explains why it cannot fire yet`);
    }
    // Deliverable events stay silent — the builder only warns when there is
    // something to warn about.
    for (const e of events.filter(e => e.deliverability === 'ok')) {
        assert.ok(!('deliverabilityNote' in e), `${e.id} carries no needless note`);
    }
});

test('no already-shipped event was regenerated out of existence', () => {
    const providers = buildAppEventProviders(FULL_CTX);
    for (const [providerId, eventIds] of Object.entries(NEVER_REMOVE)) {
        const provider = providers.find(p => p.id === providerId);
        assert.ok(provider, `provider ${providerId} disappeared`);
        const present = new Set(provider.events.map(e => e.id));
        for (const id of eventIds) {
            assert.ok(present.has(id), `${providerId}.${id} disappeared — saved automations bind against it`);
        }
    }
});

test('provider ordering is preserved (the builder snaps a new trigger to providers[0])', () => {
    // SettingsForm auto-selects the first available provider for a fresh
    // trigger, so reordering silently changes what every new routine defaults
    // to. Discovery order must never decide this.
    assert.deepStrictEqual(
        buildAppEventProviders(FULL_CTX).map(p => p.id),
        ['gmail', 'google-calendar', 'google-drive', 'nextcloud', 'support', 'approvals', 'msgraph'],
    );
});

// __manual/__schedule stamp the current time into their sample, so compare
// their shape rather than the instant they were built.
function stableOutputs(outputs) {
    const copy = JSON.parse(JSON.stringify(outputs));
    for (const key of ['__manual', '__schedule']) {
        if (!copy[key]) continue;
        copy[key].sample.now = '<now>';
        copy[key].fields = copy[key].fields.map(f => ({ ...f, sample: '<now>' }));
    }
    return copy;
}

test('every pre-existing trigger output contract survived unchanged', () => {
    // A superset check, not equality: integrations declaring new events is the
    // whole point, so the guarantee is that nothing already relied upon moved.
    const actual = stableOutputs(buildTriggerOutputsCatalog());
    const expected = stableOutputs(GOLDEN.outputs);
    for (const [key, contract] of Object.entries(expected)) {
        assert.ok(key in actual, `${key} disappeared — saved automations bind against it`);
        assert.deepStrictEqual(actual[key], contract, `${key} changed shape`);
    }
});

test('events listed but unlisted-yet-resolvable both survive', () => {
    const outputs = buildTriggerOutputsCatalog();
    // msgraph.event.updated is deliberately NOT offered in the dropdown (it
    // duplicates event.changed) but stays valid at runtime and keeps its output
    // contract, so a saved automation using it still binds.
    assert.ok(outputs['msgraph.event.updated'], 'hidden event kept its output contract');
    const msgraph = buildAppEventProviders(FULL_CTX).find(p => p.id === 'msgraph');
    assert.ok(!msgraph.events.some(e => e.id === 'event.updated'), 'hidden event is not offered');
});

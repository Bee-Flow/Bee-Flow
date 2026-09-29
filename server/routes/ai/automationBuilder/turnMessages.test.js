/**
 * composeTurnMessages — the prefix contract between two turns of one session.
 *
 * Everything before the late dynamic system message must be byte-identical
 * from turn 1 to turn 2: same system prompt (the catalogue order is replayed,
 * not re-ranked), same few-shots (kept every turn on the small profile), and
 * turn 1's history is a prefix of turn 2's. Measured before this: the small
 * profile re-read ~25k tokens per user turn on the local box because all three
 * of those moved.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/automationBuilder/turnMessages.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { composeTurnMessages, stablePrefixLength } = require('./turnMessages');
const { applyCatalogOrder, catalogOrderOf } = require('../../../automation/builderPrompt/rankApps');
const { getProfile } = require('../../../automation/builderModelProfiles');
const { systemPrefixFingerprint } = require('../../../core/llm/promptCacheStability');

const app = (id, actions) => ({
    id, label: id, available: true,
    actions: actions.map(n => ({ name: n, description: `${n} does a thing`, sideEffect: false, inputSchema: { type: 'object', properties: { a: {} }, required: ['a'] } })),
});
// Registry order.
const CATALOG = {
    apps: [
        app('memory', ['memory_search', 'memory_write']),
        app('nextcloud', ['nextcloud_list_files', 'nextcloud_read_file']),
        app('nextcloud-tables', ['nextcloud_tables_add_row']),
        app('nextcloud-notifications', ['nextcloud_notifications_send']),
    ],
};
// What rankAppsForMessage produced on turn 1 for "sort invoices" — tables and
// files first. Stand-in for the reranker so no model is called here.
const TURN1_CATALOG = { ...CATALOG, apps: [CATALOG.apps[2], CATALOG.apps[1], CATALOG.apps[0], CATALOG.apps[3]] };

const SMALL = getProfile('small');
const MID = getProfile('mid');
const MODEL = 'qwen3.8-27b';

const PREFS = { userTimezone: 'Europe/Amsterdam', webSearchEnabled: true, disabledMedia: {}, allowedModelTiers: ['auto', 'fast'] };
const user1 = { role: 'user', content: 'sort invoices' };
const assistant1 = { role: 'assistant', content: 'I added a manual trigger and a step that lists /Invoices.' };
const DRAFT_STATE = 'MAIN FLOW:\n  - `trg` trigger:manual\n  - `s1` integration_action nextcloud_list_files';

function turn1(profile = SMALL, over = {}) {
    return composeTurnMessages({
        profile, modelId: MODEL, promptCatalog: TURN1_CATALOG, codeStepEnabled: false,
        history: [], message: 'sort invoices', attachments: [],
        agentDraftState: '', draftIsEmpty: true, canvasScope: undefined, schemaPart: null,
        turnPrefs: PREFS, ...over,
    });
}
function turn2(profile = SMALL, over = {}) {
    // Turn 2 replays the STORED order over the current catalogue — the same
    // path chatStream takes once a builder session exists.
    const replayed = applyCatalogOrder(CATALOG, catalogOrderOf(TURN1_CATALOG));
    return composeTurnMessages({
        profile, modelId: MODEL, promptCatalog: replayed, codeStepEnabled: false,
        history: [user1, assistant1], message: 'use notifications instead', attachments: [],
        agentDraftState: DRAFT_STATE, draftIsEmpty: false, canvasScope: undefined, schemaPart: null,
        turnPrefs: PREFS, ...over,
    });
}

test('(a) the system prompt is byte-identical between turn 1 and turn 2', () => {
    const t1 = turn1(); const t2 = turn2();
    assert.strictEqual(systemPrefixFingerprint(t1.sys), systemPrefixFingerprint(t2.sys));
    assert.strictEqual(t1.sys, t2.sys);
    // …and on a band whose catalog lives in the system prompt (mid) it is the
    // replayed order that makes it so: a re-ranked catalogue (registry order
    // here) would have produced different bytes. On the small band the
    // catalog is in the dynamic message (catalogPlacement 'dynamic', case e),
    // so the system prompt does not even see the order.
    const drift = turn2(MID, { promptCatalog: CATALOG });
    assert.notStrictEqual(drift.sys, turn1(MID).sys, 'control: a different app order IS a different system prompt on mid');
    assert.strictEqual(turn2(SMALL, { promptCatalog: CATALOG }).sys, t1.sys, 'small: the order lives outside the system prompt');
});

test('(b) small profile: few-shots are present on BOTH turns and identical', () => {
    const t1 = turn1(); const t2 = turn2();
    assert.ok(t1.fewShotMessages.length > 0, 'turn 1 has few-shots');
    assert.deepStrictEqual(t2.fewShotMessages, t1.fewShotMessages, 'turn 2 keeps the same cached block');
});

test('(c) turn 2 starts with turn 1 byte for byte up to the dynamic message; history is the windowed pair', () => {
    const t1 = turn1(); const t2 = turn2();
    const p = stablePrefixLength(t1.messages);
    assert.strictEqual(p, 1 + t1.fewShotMessages.length, 'turn 1 prefix = system + few-shots (no history yet)');
    assert.deepStrictEqual(t2.messages.slice(0, p), t1.messages.slice(0, p));
    assert.deepStrictEqual(t2.windowedHistory, [user1, assistant1]);
    assert.deepStrictEqual(t2.messages.slice(p, p + 2), [user1, assistant1], 'history follows the stable prefix');
    assert.strictEqual(stablePrefixLength(t2.messages), p + 2, 'turn 2 prefix grew by exactly the new exchange');
    assert.strictEqual(t2.messages[p + 2].role, 'system', 'then the dynamic message');
    assert.strictEqual(t2.messages.at(-1).role, 'user');
    assert.strictEqual(t2.messages.at(-1).content, 'use notifications instead');
    // Draft state lives in the dynamic message, not in the prefix.
    assert.ok(t2.dynamicContext.includes('Current draft — LIVE state') && t2.dynamicContext.includes('`s1`'));
    assert.ok(!t2.sys.includes('`s1`'));
    for (const m of t2.messages.slice(0, p + 2)) assert.ok(!JSON.stringify(m).includes('LIVE state'));
});

test('(d) flipping a per-turn preference changes only the dynamic message, never the system prompt', () => {
    const on = turn2();
    const off = turn2(SMALL, { turnPrefs: { ...PREFS, webSearchEnabled: false } });
    assert.strictEqual(off.sys, on.sys);
    assert.deepStrictEqual(off.messages.slice(0, stablePrefixLength(on.messages)), on.messages.slice(0, stablePrefixLength(on.messages)));
    assert.notStrictEqual(off.dynamicContext, on.dynamicContext);
    assert.ok(on.dynamicContext.includes('Web search: ENABLED') && off.dynamicContext.includes('Web search: DISABLED'));
    // Timezone, tiers and disabled media likewise.
    const tz = turn2(SMALL, { turnPrefs: { ...PREFS, userTimezone: 'Pacific/Auckland', allowedModelTiers: ['auto'], disabledMedia: { image: true } } });
    assert.strictEqual(tz.sys, on.sys);
    assert.ok(tz.dynamicContext.includes('Pacific/Auckland') && tz.dynamicContext.includes('MUST be one of: auto') && tz.dynamicContext.includes('disabled image generation'));
    assert.ok(!tz.sys.includes('Pacific/Auckland'));
});

test('mid profile: few-shots on the first turn only, system prompt still identical', () => {
    const t1 = turn1(MID); const t2 = turn2(MID);
    assert.ok(t1.fewShotMessages.length > 0, 'mid gets its one worked example on a fresh draft');
    assert.deepStrictEqual(t2.fewShotMessages, [], 'and none once there is history');
    assert.strictEqual(t2.sys, t1.sys);
    // The dynamic message is still last-but-one and the draft state is in it.
    assert.strictEqual(t2.messages.at(-2).role, 'system');
    assert.ok(t2.messages.at(-2).content.includes('LIVE state'));
});

test('Gemini 3.x never gets synthetic few-shots, whatever the profile says', () => {
    const t = turn1(SMALL, { modelId: 'gemini-3.1-flash' });
    assert.deepStrictEqual(t.fewShotMessages, []);
});

test('the history window uses the profile budget and evicts whole blocks from the head', () => {
    // 20 messages of ~2.5k tokens each — far over the small budget of 6000.
    const long = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i} ` + 'x'.repeat(10_000) }));
    const t = turn2(SMALL, { history: long });
    const kept = t.windowedHistory.length;
    assert.ok(kept > 0 && kept < 20);
    assert.strictEqual((20 - kept) % 6, 0, 'a whole number of 6-message blocks was evicted');
    assert.strictEqual(t.windowedHistory[0].role, 'user');
    assert.deepStrictEqual(t.windowedHistory, long.slice(20 - kept), 'the tail of the history, head-evicted');
});

test('validation notes and non-text entries are stripped from history before windowing', () => {
    const { VALIDATION_NOTE_PREFIX } = require('./chatTurnLoop');
    const h = [user1, { role: 'user', content: `${VALIDATION_NOTE_PREFIX}\n[]` }, { role: 'tool', content: 'x' }, assistant1];
    const t = turn2(SMALL, { history: h });
    assert.deepStrictEqual(t.windowedHistory, [user1, assistant1]);
});

test('attachments are described in the user message, not executed and not in the prefix', () => {
    const t = turn2(SMALL, { attachments: [{ name: 'invoices.csv' }, { filename: 'notes.txt' }] });
    assert.ok(t.messages.at(-1).content.includes('[User attached 2 file(s) to this turn: invoices.csv, notes.txt.'));
    assert.ok(!t.sys.includes('invoices.csv') && !t.dynamicContext.includes('invoices.csv'));
});

test('with nothing dynamic to say there is no dynamic message, and the prefix runs to the user message', () => {
    // Mid: the catalog is in the system prompt, so a fresh draft with no
    // preferences has nothing dynamic at all.
    const t = turn1(MID, { turnPrefs: {} });
    assert.strictEqual(t.dynamicContext, '');
    assert.strictEqual(t.messages.filter(m => m.role === 'system').length, 1, 'no empty second system message');
    assert.strictEqual(stablePrefixLength(t.messages), t.messages.length - 1);
    assert.strictEqual(stablePrefixLength([]), 0);
    // Small: the dynamic message always carries the catalog (case e).
    const sm = turn1(SMALL, { turnPrefs: {} });
    assert.ok(sm.dynamicContext.startsWith('## Catalog'), 'the catalog opens the dynamic message');
    assert.strictEqual(sm.messages.filter(m => m.role === 'system').length, 2);
});

// ── (e) ACROSS sessions on the small band ──────────────────────────────────
//
// Two users with different integrations, tables and documents must share
// the system prompt and the few-shots byte for byte: that prefix is what the
// single-slot local runtime keeps in its prompt cache between builds, and
// with the catalog inside it (as it was until 2026-09-17) every new session
// re-read the whole ~27k tokens.
const OTHER_CATALOG = {
    apps: [app('gmail', ['gmail_search', 'gmail_compose']), app('google-drive', ['drive_upload_file'])],
    datatables: [{ id: 'tbl_9f8e7d', key: 'klanten', name: 'Klanten', canWrite: true, columns: [{ key: 'email', name: 'E-mail', type: 'text' }] }],
    documents: [{ id: 'doc_1', name: 'Offerte', docType: 'quote', placeholders: [{ key: 'customer.name', kind: 'value' }] }],
};
const THIS_CATALOG = { ...TURN1_CATALOG, datatables: [], documents: null };

test('(e) small profile: two sessions with different catalogs, datatables and documents share byte-identical system + few-shots', () => {
    const a = turn1(SMALL, { promptCatalog: THIS_CATALOG });
    const b = turn1(SMALL, { promptCatalog: OTHER_CATALOG, message: 'file my invoices in Drive' });
    assert.strictEqual(a.sys, b.sys, 'same system prompt for two users');
    assert.deepStrictEqual(a.fewShotMessages, b.fewShotMessages, 'same few-shots');
    assert.strictEqual(systemPrefixFingerprint(a.sys), systemPrefixFingerprint(b.sys));
    // The system prompt names none of either user's tools or tables… (the
    // static sourceHandle rule names drive_upload_file for everyone, so the
    // catalog LINE — with its description — is the thing to look for)
    for (const s of ['nextcloud_tables_add_row', 'drive_upload_file does a thing', 'tbl_9f8e7d', 'Klanten', 'doc_1']) {
        assert.ok(!a.sys.includes(s) && !b.sys.includes(s), `${s} is not in the system prompt`);
    }
    assert.ok(a.sys.includes('The catalog, your datatables and documents are in the message right before the user\'s'), 'the system prompt points at the dynamic message');
    // …and the dynamic message carries them, catalog first, draft state last.
    assert.ok(b.dynamicContext.startsWith('## Catalog (the ONLY tools you may propose)'));
    for (const s of ['drive_upload_file does a thing', '## Datatables you may use', 'tbl_9f8e7d', '## Documents you may fill', 'doc_1']) {
        assert.ok(b.dynamicContext.includes(s), `${s} is in the dynamic message`);
    }
    assert.ok(a.dynamicContext.includes('nextcloud_tables_add_row') && a.dynamicContext.includes('_(none yet — when the request needs a table'), 'this user\'s catalog and the none line');
    assert.ok(!a.dynamicContext.includes('## Documents you may fill'), 'documents:null renders nothing');
    const t2 = turn2(SMALL, { promptCatalog: applyCatalogOrder(OTHER_CATALOG, catalogOrderOf(OTHER_CATALOG)) });
    assert.ok(t2.dynamicContext.indexOf('## Catalog') < t2.dynamicContext.indexOf('## This turn'), 'catalog before preferences');
    assert.ok(t2.dynamicContext.indexOf('## This turn') < t2.dynamicContext.indexOf('Current draft — LIVE state'), 'draft state last');
    assert.strictEqual(t2.messages.at(-2).role, 'system');
});

test('the mid profile keeps its catalog in the system prompt (Anthropic caches system[0] per session)', () => {
    const a = turn1(MID, { promptCatalog: THIS_CATALOG });
    const b = turn1(MID, { promptCatalog: OTHER_CATALOG });
    assert.notStrictEqual(a.sys, b.sys);
    assert.ok(b.sys.includes('drive_upload_file') && b.sys.includes('tbl_9f8e7d'));
    assert.ok(!b.dynamicContext.includes('## Catalog'));
});

test('(f) the draft-state message opens with the title, or says the draft is untitled', () => {
    const named = turn2(SMALL, { title: 'Facturen inlezen' });
    assert.ok(named.dynamicContext.includes('Title: "Facturen inlezen"'));
    const untitled = turn2(SMALL, { title: 'Untitled automation' });
    assert.ok(untitled.dynamicContext.includes('Title: (untitled — call builder_set_metadata in this reply)'));
    assert.ok(!untitled.sys.includes('Title:'), 'never in the system prompt');
    const none = turn2(SMALL);
    assert.ok(!none.dynamicContext.includes('Title:'), 'a caller that passes no title gets the old bytes');
});

test('(g) the lean prompt is written for the menu the band reads: lean menu on small, full menu on reasoning', () => {
    // Both bands read the lean PROSE (promptVariant 'lean'); only the small
    // band reads the lean MENU. The reasoning band keeps toolset 'full' +
    // schemaVariant 'full', so its prompt must teach the loop container,
    // flowlets, additional triggers, delegation and the batch update its
    // menu serves — and never claim there is no loop container.
    const REASONING = getProfile('reasoning');
    assert.strictEqual(REASONING.promptVariant, 'lean');
    assert.strictEqual(REASONING.toolset, 'full');
    const small = turn1(SMALL).sys;
    const reasoning = turn1(REASONING).sys;
    assert.ok(/There is no loop container on this menu/.test(small), 'small: no loop container');
    assert.ok(!/There is no loop container/.test(reasoning), 'reasoning: the claim is not made');
    for (const n of ['builder_add_loop', 'builder_update_steps', 'builder_add_trigger', 'builder_add_switch', 'builder_create_layer', 'builder_generate_layer', 'builder_add_set', 'builder_add_form_page']) {
        assert.ok(reasoning.includes(n), `reasoning: teaches ${n}`);
        assert.ok(!small.includes(n), `small: never names ${n}`);
    }
    assert.ok(/## Flowlets/.test(reasoning) && /## Additional triggers/.test(reasoning) && /never a second builder_propose_trigger/.test(reasoning), 'reasoning: the full-menu sections');
    assert.ok(!/## Flowlets|## Additional triggers/.test(small), 'small: none of them');
    // The reasoning band keeps its catalog in the system prompt (cloud band).
    assert.ok(reasoning.includes('## Catalog (the ONLY tools you may propose)'));
});

test('deterministic: composing the same turn twice yields identical messages', () => {
    assert.deepStrictEqual(turn2().messages, turn2().messages);
});

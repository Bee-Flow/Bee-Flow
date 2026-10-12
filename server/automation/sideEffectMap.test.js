/**
 * Invariant tests for the side-effect map.
 *
 * The dry-run contract is: READ tools run FOR REAL, side-effect tools are
 * simulated. isSideEffect() is fail-closed (unlisted → side effect), which
 * means a read tool nobody added to READ_ONLY silently gets SIMULATED in
 * dry-runs — the builder then plans against fake sample data. That is how
 * AFAS/NMBRS/n8n/GitHub reads regressed. These tests make the classification
 * exhaustive: every tool in the automation registry must be consciously
 * placed in exactly one of READ_ONLY / SIDE_EFFECTS.
 *
 * De blokken zijn `node:test`-cases en geen kale accolades: sinds deze test
 * over ALL_TOOL_APPS loopt laadt hij ook de inline-apps, en één daarvan
 * (regexGeneratorTools) houdt de event-loop open. `--test-force-exit` ruimt dat
 * op zodra er ECHTE tests in het bestand staan; met alleen top-level code bleef
 * het proces hangen nadat alle asserties waren geslaagd.
 *
 * Run: node --test --test-force-exit automation/sideEffectMap.test.js
 */

const assert = require('assert');
const test = require('node:test');
const { isSideEffect, READ_ONLY, SIDE_EFFECTS } = require('./sideEffectMap');
const { ALL_TOOL_APPS, loadTools } = require('./toolRegistry');

// ── every registry tool is classified in exactly one set ──
//
// Over ALL_TOOL_APPS en niet over TOOL_REGISTRY: sinds A2-1 staan de apps die
// hun tools INLINE injecteren (browser, notebooks, regex-regels) in dezelfde
// gedeelde lijst die de kiezer en de rechtenlaag lezen, en hun effect komt op
// het scherm te staan. Liep deze test alleen over TOOL_REGISTRY, dan vielen
// juist die negen namen buiten de controle die de modulekop belooft — en
// vielen ze stilzwijgend op de fail-closed default.
test('every tool of every app in ALL_TOOL_APPS is classified exactly once', () => {
    const unclassified = [];
    const doubleClassified = [];
    let total = 0;
    for (const entry of ALL_TOOL_APPS) {
        let tools = [];
        try { tools = loadTools(entry); } catch (e) {
            assert.fail(`loadTools failed for app "${entry.app}": ${e.message}`);
        }
        for (const t of tools) {
            const name = t?.function?.name;
            if (!name) continue;
            total++;
            const isRead = READ_ONLY.has(name);
            const isWrite = SIDE_EFFECTS.has(name);
            if (!isRead && !isWrite) unclassified.push(`${entry.app}:${name}`);
            if (isRead && isWrite) doubleClassified.push(`${entry.app}:${name}`);
        }
    }
    assert.ok(total > 100, `sanity: registry yielded ${total} tools`);
    assert.deepStrictEqual(doubleClassified, [], `tools in BOTH sets: ${doubleClassified.join(', ')}`);
    assert.deepStrictEqual(
        unclassified, [],
        `UNCLASSIFIED tools (add each to READ_ONLY or SIDE_EFFECTS in sideEffectMap.js — `
        + `an unlisted read gets silently simulated in dry-runs): ${unclassified.join(', ')}`,
    );
});

// ── fail-closed default is preserved ──
test('the fail-closed default is preserved', () => {
    assert.strictEqual(isSideEffect('some_future_unknown_tool'), true, 'unknown tools stay side-effect');
    assert.strictEqual(isSideEffect(null), true, 'null → side-effect');
    assert.strictEqual(isSideEffect(''), true, 'empty → side-effect');
});

// ── spot checks: the regressions that motivated this test stay fixed ──
test('the regressions that motivated this test stay fixed', () => {
    // De inline-apps: één leesactie en één schrijfactie per app, zodat het
    // uitzetten van de lus hierboven niet ongemerkt kan.
    for (const read of ['notebook_read', 'regex_list_rules', 'regex_test_pattern']) {
        assert.strictEqual(isSideEffect(read), false, `${read} must be read-only (runs live in dry-run)`);
    }
    for (const write of ['browse_web', 'notebook_write', 'notebook_replace', 'notebook_insert',
        'regex_add_rules', 'regex_add_collection']) {
        assert.strictEqual(isSideEffect(write), true, `${write} must stay a simulated side-effect`);
    }
    for (const read of [
        'afas_query', 'afas_list_connectors', 'nmbrs_list_employees', 'nmbrs_get_employee',
        'n8n_workflow_list', 'n8n_execution_get', 'github_get_file', 'github_list_repos',
        'drive_get_content', 'outlook_list_recent', 'onedrive_list_files', 'onedrive_list_recent', 'drive_list_recent',
        'gamma_list_themes', 'signrequest_check_status', 'keep_get',
        'groups_read_conversation', 'youtrack_list_projects', 'nextcloud_talk_list_participants',
        'ms_calendar_search_events', 'fireflies_get_summary', 'transcribe_audio',
    ]) {
        assert.strictEqual(isSideEffect(read), false, `${read} must be read-only (runs live in dry-run)`);
    }
    for (const write of [
        'gmail_compose', 'gmail_create_draft', 'gmail_mark_read', 'youtrack_create_issue',
        'webpage_db_exec', 'nextcloud_talk_send_message', 'n8n_workflow_execute',
        'generate_image', 'elevenlabs_tts', 'knowledge_base_ingest', 'signrequest_send_document',
    ]) {
        assert.strictEqual(isSideEffect(write), true, `${write} must stay a simulated side-effect`);
    }
});

// ── effectOf: the three-way split the agent confirm policy hangs on ──
test('effectOf splits sends out of writes, fail-closed', () => {
    const { SENDS, effectOf, maxEffect, effectRank } = require('./sideEffectMap');

    // SENDS ⊆ SIDE_EFFECTS. A send that the completeness check above cannot
    // see would be a write nobody classified.
    const strays = [...SENDS].filter(n => !SIDE_EFFECTS.has(n));
    assert.deepStrictEqual(strays, [], `SENDS entries missing from SIDE_EFFECTS: ${strays.join(', ')}`);
    const contradictions = [...SENDS].filter(n => READ_ONLY.has(n));
    assert.deepStrictEqual(contradictions, [], `SENDS entries that are also READ_ONLY: ${contradictions.join(', ')}`);

    // Fail-closed: an unknown name is a write, never a read.
    assert.strictEqual(effectOf('some_future_unknown_tool'), 'writes');
    assert.strictEqual(effectOf(null), 'writes');
    assert.strictEqual(effectOf(''), 'writes');
    assert.strictEqual(effectOf(42), 'writes');

    assert.strictEqual(effectOf('gmail_search'), 'reads');
    assert.strictEqual(effectOf('kb_search'), 'reads');
    assert.strictEqual(effectOf('gmail_compose'), 'sends');
    assert.strictEqual(effectOf('linkedin_create_post'), 'sends');
    assert.strictEqual(effectOf('signrequest_send_document'), 'sends');
    assert.strictEqual(effectOf('nextcloud_mail_send'), 'sends');
    assert.strictEqual(effectOf('calendar_create_event'), 'sends');
    // A draft is the opposite of a send — it must stay a plain write, or every
    // "prepare this for me" turn would need a confirmation it already has.
    assert.strictEqual(effectOf('gmail_create_draft'), 'writes');
    assert.strictEqual(effectOf('drive_upload_file'), 'writes');
    assert.strictEqual(effectOf('nextcloud_notes_create'), 'writes');

    assert.strictEqual(maxEffect([]), 'reads');
    assert.strictEqual(maxEffect(['reads', 'reads']), 'reads');
    assert.strictEqual(maxEffect(['reads', 'writes']), 'writes');
    assert.strictEqual(maxEffect(['sends', 'writes', 'reads']), 'sends');
    // An unknown class is normalised to a write — never carried through, never below one.
    assert.strictEqual(maxEffect(['reads', 'nonsense']), 'writes');
    assert.strictEqual(effectRank('nonsense'), effectRank('writes'));
});

/**
 * The Dutch for round 4a of the admin dashboard in the Studio layout (2026-11). A Dutch key
 * without an English counterpart is stored and never read; an English key of
 * this round without Dutch leaves one English word in a Dutch screen.
 *
 * Run: node --test migrations/add-nl-admin-studio-4a-2026-11-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, DATA_SHA256, applyNl } = require('./add-nl-admin-studio-4a-2026-11-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// The keys this round added.
const OWNED_KEYS = new Set([
    'admin_subscriptions.limit_override',
    'admin_subscriptions.limit_override_on',
    'admin_subscriptions.limit_plan_default',
    'admin_subscriptions.limit_unlimited',
    'agent_studio.behavior_allow_copying',
    'agent_studio.behavior_allow_copying_hint',
    'agent_studio.behavior_disable_external_tools',
    'agent_studio.behavior_disable_external_tools_hint',
    'agent_studio.behavior_position_left',
    'agent_studio.behavior_position_right',
    'agent_studio.behavior_web_embed',
    'agent_studio.behavior_web_embed_hint',
    'agent_studio.can_use.mail_reply_all',
    'agent_studio.can_use.mail_reply_all_hint',
    'agent_studio.can_use.mail_reply_draft_hint',
    'agent_studio.can_use.mail_runs',
    'agent_studio.can_use.mail_runs_hint',
    'support.ai_config_asking',
    'support.ai_config_cited',
    'support.ai_config_not_seeded',
    'support.ai_config_save',
    'support.ai_config_saving',
    'support.ai_config_sections',
    'support.ai_config_tab_agent',
    'support.ai_config_tab_behaviour',
    'support.ai_config_tab_insights',
    'support.ai_config_tab_sla',
    'support.ai_config_tab_tags',
    'support.ai_config_tab_templates',
    'support.ai_config_test_reply',
    'support.attach_issue_attach_one',
    'support.attach_issue_attach_other',
    'support.attach_issue_attaching',
    'support.attach_issue_back_to_search',
    'support.attach_issue_create_and_attach',
    'support.attach_issue_creating',
    'support.attach_issue_nothing_matches_create',
    'support.attach_issue_search',
    'support.attach_issue_searching',
    'support.email_remote_blocked',
    'support.email_remote_show',
    'support.connections_default_project',
    'support.connections_default_project_hint',
    'support.connections_event_customer_message',
    'support.connections_event_escalation',
    'support.connections_event_issue_resolved',
    'support.connections_event_sla_breach',
    'support.connections_event_ticket_created',
    'support.connections_provider_generic',
    'support.connections_save_connection',
    'support.connections_saving',
    'support.connections_server_url',
    'support.connections_server_url_current',
    'support.connections_server_url_example',
    'support.connections_token',
    'support.connections_token_hint',
    'support.connections_turn_off',
    'support.connections_turn_on',
    'support.connections_unchanged',
    'support.connections_webhook_hint',
    'support.connections_webhook_url',
    'support.connections_where_to_send',
    'support.drawer_back',
    'support.drawer_send',
    'support.drawer_send_to_bee_flow',
    'support.drawer_sending',
    'support.drawer_status_ai_responding',
    'support.drawer_status_awaiting_agent',
    'support.drawer_status_awaiting_user',
    'support.drawer_status_closed',
    'support.drawer_status_open',
    'support.drawer_status_resolved',
    'support.drawer_subject_and_message_required',
    'support.drawer_you',
    'support.inbox_composer_note_placeholder',
    'support.inbox_composer_reply_placeholder',
    'support.inbox_composer_save_note',
    'support.inbox_composer_send_reply',
    'support.inbox_composer_sending',
    'support.inbox_csat_rated',
    'support.inbox_filter_active',
    'support.inbox_filter_all',
    'support.inbox_filter_awaiting',
    'support.inbox_filter_followup',
    'support.inbox_filter_resolved',
    'support.inbox_filter_sent',
    'support.inbox_mailbox_disconnect',
    'support.inbox_mailbox_disconnecting',
    'support.inbox_priority_high',
    'support.inbox_priority_low',
    'support.inbox_priority_normal',
    'support.inbox_priority_urgent',
    'support.inbox_role_agent_admin',
    'support.inbox_role_agent_editor',
    'support.inbox_role_dpo',
    'support.inbox_role_guest',
    'support.inbox_role_member',
    'support.inbox_role_org_admin',
    'support.inbox_status_ai_responding',
    'support.inbox_status_awaiting_agent',
    'support.inbox_status_awaiting_user',
    'support.inbox_status_closed',
    'support.inbox_status_open',
    'support.inbox_status_resolved',
    'support.inbox_unknown_error',
    'support.insights_ai_resolved',
    'support.insights_csat_30d',
    'support.insights_csat_7d',
    'support.insights_csat_rate',
    'support.insights_median_first_response',
    'support.insights_median_resolution',
    'support.insights_of_threads',
    'support.insights_ratings',
    'support.insights_sla_breaches',
    'support.insights_staff_resolved',
    'support.issue_state_resolved',
    'support.issue_state_unknown',
    'support.linked_issues_attach_existing',
    'support.linked_issues_couldnt_refresh',
    'support.linked_issues_created_here',
    'support.linked_issues_days_ago',
    'support.linked_issues_detach',
    'support.linked_issues_detach_description',
    'support.linked_issues_detach_title',
    'support.linked_issues_escalated',
    'support.linked_issues_hours_ago',
    'support.linked_issues_just_now',
    'support.linked_issues_minutes_ago',
    'support.linked_issues_no_longer_in_youtrack',
    'support.linked_issues_not_connected',
    'support.linked_issues_showing_when',
    'support.linked_issues_someone',
    'support.tabs_delete',
    'support.tabs_save',
    'support.tabs_saving',
    'support.tabs_tag_colour',
]);
const OWNED = (k) => OWNED_KEYS.has(k);

test('every key exists in English, and every key of this round has Dutch (or is declared identical)', () => {
    const keys = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH];
    assert.deepStrictEqual(keys.filter((k) => !(k in GUI_DEFAULTS)), []);
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => OWNED(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('the Dutch is Dutch, placeholders survive, and an identical word is declared, not seeded', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(v.trim(), `${k}: empty`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k}: English copied (list it under sameAsEnglish)`);
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), k);
    }
    for (const k of SAME_AS_ENGLISH) assert.ok(!(k in NL_TRANSLATIONS), `${k}: both seeded and declared identical`);
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.deepStrictEqual(merged, NL_TRANSLATIONS);
    const [first] = Object.keys(NL_TRANSLATIONS);
    const own = applyNl({ [first]: 'Eigen woord' });
    assert.strictEqual(own.merged[first], 'Eigen woord');
    const again = applyNl({ ...merged });
    assert.strictEqual(again.added, 0);
    assert.deepStrictEqual(again.merged, merged);
});

test('no other Dutch catalogue seeds these keys', () => {
    const mine = new Set(Object.keys(NL_TRANSLATIONS));
    const clashes = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^(add|update)-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f === 'add-nl-admin-studio-4a-2026-11-translations.js') continue;
        let other;
        try { other = require(path.join(__dirname, f)).NL_TRANSLATIONS; } catch { continue; }
        if (!other || typeof other !== 'object') continue;
        for (const k of Object.keys(other)) if (mine.has(k)) clashes.push(`${f}: ${k}`);
    }
    assert.deepStrictEqual(clashes, [], 'one key, one owner: boot order would decide the wording');
});

test('the pinned data hash matches the data file, so a data change re-runs the migration', () => {
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'admin-studio-4a-2026-11-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual,
        'data/admin-studio-4a-2026-11-nl.json changed: set DATA_SHA256 in add-nl-admin-studio-4a-2026-11-translations.js to ' + actual);
});

test('the boot ladder runs it', () => {
    const { NL_TRANSLATIONS: ladder } = require('../boot/bootMigrations');
    assert.ok(ladder.includes('add-nl-admin-studio-4a-2026-11-translations'), 'not registered in boot/bootMigrations.js');
});

// @typecheck strict
/**
 * The source → area table is the one thing the Adoption report, the Overview
 * tab's "By app area" and the client split all read; these tests pin it to
 * the writers it describes and to the areas the report lists.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { AREAS, AREA_IDS, OTHER_AREA, SOURCES, INTERACTIVE_SOURCES, areaOf, kindOfArea, isInteractiveSource } = require('./usageAreas');

// The literals the writers in server/ use today (the attribution sweep of
// 2026-11-05) and the ones the metering work adds. A writer that invents a
// new one adds it here AND to SOURCES; this list is what turns red.
const WRITTEN_SOURCES = [
    'agent_chat', 'agent_stream', 'agent_test_chat', 'agent_test_attribution', 'agent_test_grade', 'agent_test_suggest',
    'swarm_orchestrator', 'direct_chat', 'automation', 'pattern_scan', 'form_ai_draft', 'form_ai_style',
    'studio_app_ai', 'studio_app_chat', 'studio_app_action', 'studio_app_public', 'studio_app_browse', 'studio_app_builder',
    'cowork', 'cowork_compose', 'project_task_ai_meeting', 'knowledge_embedding', 'document_ai',
    'project_chat', 'project_chat_auto', 'project_chat_gate', 'project_comment', 'project_comment_auto', 'project_comment_gate',
    'project_task_ai_task', 'webpage_bridge_ai', 'webpage_bridge_ai_agentic', 'public_share_bridge_ai', 'cms_builder',
    'skill_ai_draft', 'skill_ai_improve', 'skill_test', 'skill_test_grade', 'datatable_ai_draft',
    'image_generation', 'video_generation', 'music_generation', 'elevenlabs_music', 'elevenlabs_tts', 'elevenlabs_sfx',
    'learning_coach', 'learning_practice', 'shield_custom_data_assist', 'studio_ai_route', 'unknown',
    // Added by the metering work (surfaces that logged nothing before).
    'chat_title', 'automation_builder', 'meeting_summary', 'meeting_actions', 'kb_summary', 'notebook_chat',
    'notebook_generate', 'voice', 'dictate', 'nextcloud_assistant', 'agent_persona', 'template_chat', 'playbook',
];

test('every written source is in the table, and every table entry names a listed area', () => {
    for (const s of WRITTEN_SOURCES) assert.ok(SOURCES[s], `source "${s}" is not in SOURCES`);
    for (const [s, entry] of Object.entries(SOURCES)) {
        assert.ok(AREA_IDS.includes(entry.area), `source "${s}" names the unknown area "${entry.area}"`);
        assert.ok(/^[a-z][a-z0-9_]*$/.test(s), `source "${s}" is not a plain lower-case identifier`);
    }
});

test('areas are unique, ordered, and end with "other"', () => {
    assert.equal(new Set(AREA_IDS).size, AREA_IDS.length);
    assert.equal(AREA_IDS[AREA_IDS.length - 1], OTHER_AREA);
    assert.equal(AREA_IDS[0], 'agents');
    for (const a of AREAS) assert.ok(a.kind === null || typeof a.kind === 'string');
});

test('areaOf is total: a known source maps, anything else is "other"', () => {
    assert.equal(areaOf('automation'), 'automations');
    assert.equal(areaOf('agent_stream'), 'agents');
    assert.equal(areaOf('studio_app_action'), 'apps');
    assert.equal(areaOf('direct_chat'), 'chat');
    assert.equal(areaOf('meeting_summary'), 'meetings');
    assert.equal(areaOf('unknown'), OTHER_AREA);
    assert.equal(areaOf('something_new'), OTHER_AREA);
    assert.equal(areaOf(null), OTHER_AREA);
    assert.equal(areaOf(undefined), OTHER_AREA);
});

test('kindOfArea links an area to its Studio kind, or null', () => {
    assert.equal(kindOfArea('agents'), 'agent');
    assert.equal(kindOfArea('automations'), 'automation');
    assert.equal(kindOfArea('knowledge'), 'kb');
    assert.equal(kindOfArea('chat'), null);
    assert.equal(kindOfArea('nope'), null);
});

test('interactive sources are a subset of the table and keep the person-typed ones', () => {
    for (const s of INTERACTIVE_SOURCES) assert.ok(SOURCES[s] && SOURCES[s].interactive);
    for (const s of ['direct_chat', 'agent_chat', 'agent_stream']) assert.ok(INTERACTIVE_SOURCES.includes(s), s);
    assert.ok(!INTERACTIVE_SOURCES.includes('automation'));
    assert.ok(!INTERACTIVE_SOURCES.includes('notebook'), 'the dead "notebook" literal is gone');
    assert.ok(!INTERACTIVE_SOURCES.includes('webpage_chat'), 'the dead "webpage_chat" literal is gone');
    assert.equal(isInteractiveSource('direct_chat'), true);
    assert.equal(isInteractiveSource('automation'), false);
    assert.equal(isInteractiveSource(null), false);
});

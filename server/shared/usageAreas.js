// @typecheck strict
/**
 * Where an AI call belongs — SCHEMA OF RECORD.
 *
 * Every row of ai_usage_log carries a `source`: the literal a call site chose
 * when it logged the call. Forty-odd literals grew over the years, and the two
 * dashboards each kept their own eight-entry label map, so an org admin asking
 * "where does the AI go" saw most of the spend as a raw string under "Other".
 *
 * This module is the one table both sides read: the SOURCES a writer may use,
 * the AREA each one rolls up to (what the Adoption report calls "where the AI
 * goes"), the Studio kind an area belongs to when it has one, and which
 * sources mean "a person typed" (the denominator of a client question, see
 * telemetry/requestClient.js).
 *
 * The frontend copy is GENERATED (scripts/shared-mirror.manifest.json, `npm
 * run gen:shared`) and usageAreas.test.js pins every literal: renaming a
 * source on one side turns red instead of silently moving spend to "Other".
 *
 * Plain CommonJS on purpose (no require call, one export object): the mirror's
 * cjs-to-esm transform only rewrites those forms.
 */

'use strict';

/**
 * The areas, in the order the report lists them. `kind` is the Studio kind
 * (components/shared/kindKeys.ts) whose inventory row the area's spend
 * belongs to; null for an area that is not a Studio kind (direct chat, media,
 * the product's own system calls).
 * @type {ReadonlyArray<{ id: string, kind: string | null }>}
 */
const AREAS = Object.freeze([
    { id: 'agents', kind: 'agent' },
    { id: 'chat', kind: null },
    { id: 'automations', kind: 'automation' },
    { id: 'forms', kind: 'form' },
    { id: 'apps', kind: 'app' },
    { id: 'cowork', kind: 'cowork' },
    { id: 'meetings', kind: 'meeting' },
    { id: 'knowledge', kind: 'kb' },
    { id: 'documents', kind: 'document' },
    { id: 'projects', kind: null },
    { id: 'webpages', kind: 'webpage' },
    { id: 'skills', kind: 'skill' },
    { id: 'datatables', kind: 'datatable' },
    { id: 'media', kind: null },
    { id: 'system', kind: null },
    { id: 'other', kind: null },
]);

/** @type {ReadonlyArray<string>} */
const AREA_IDS = Object.freeze(AREAS.map((a) => a.id));

/** The area a source rolls up to when it is not in the table. */
const OTHER_AREA = 'other';

/**
 * Every source a writer may log, with its area and whether it means a person
 * typed (`interactive`). A source missing here still logs — logUsage never
 * refuses a row — but it is reported under "other" with its raw name, and
 * usageAreas.test.js names the writers it knows about so a new literal is
 * added here rather than invented. `test` marks a builder's own test run (a
 * test chat, a grading set): spend, but not adoption.
 * @type {Readonly<Record<string, { area: string, interactive?: boolean, test?: boolean }>>}
 */
const SOURCES = Object.freeze({
    // Agents: a chat with an agent, its tool calls, test chats and the agent
    // test sets; a swarm is agents working together.
    agent_chat: { area: 'agents', interactive: true },
    agent_stream: { area: 'agents', interactive: true },
    agent_test_chat: { area: 'agents', interactive: true, test: true },
    agent_test_attribution: { area: 'agents', test: true },
    agent_test_grade: { area: 'agents', test: true },
    agent_test_suggest: { area: 'agents', test: true },
    agent_persona: { area: 'agents' },
    swarm_orchestrator: { area: 'agents' },
    // Direct chat (no agent) and the title the server writes for it.
    direct_chat: { area: 'chat', interactive: true },
    chat_title: { area: 'chat' },
    // Automations: a run's AI steps, the builder chat, the repeating-work scan.
    automation: { area: 'automations' },
    automation_builder: { area: 'automations', interactive: true },
    pattern_scan: { area: 'automations' },
    // Forms: the AI that drafts and styles a form.
    form_ai_draft: { area: 'forms' },
    form_ai_style: { area: 'forms' },
    // App Studio: the runtime, the public page, the run counter, the builder.
    studio_app_ai: { area: 'apps' },
    studio_app_chat: { area: 'apps', interactive: true },
    studio_app_action: { area: 'apps' },
    studio_app_public: { area: 'apps' },
    studio_app_browse: { area: 'apps' },
    studio_app_builder: { area: 'apps', interactive: true },
    // Cowork: a run of a delegated job, and the composer that drafts one.
    cowork: { area: 'cowork' },
    cowork_compose: { area: 'cowork', interactive: true },
    // Meeting notes: the summary, the action items, the tasks derived from one.
    meeting_summary: { area: 'meetings' },
    meeting_actions: { area: 'meetings' },
    project_task_ai_meeting: { area: 'meetings' },
    // Knowledge: embeddings and the summary extracted at upload.
    knowledge_embedding: { area: 'knowledge' },
    kb_summary: { area: 'knowledge' },
    // Documents and spreadsheets.
    document_ai: { area: 'documents', interactive: true },
    // Projects: chat, comments, AI participation and its relevance gate,
    // notebooks and the tasks derived from a project.
    project_chat: { area: 'projects', interactive: true },
    project_chat_auto: { area: 'projects' },
    project_chat_gate: { area: 'projects' },
    project_comment: { area: 'projects', interactive: true },
    project_comment_auto: { area: 'projects' },
    project_comment_gate: { area: 'projects' },
    project_task_ai_task: { area: 'projects' },
    notebook_chat: { area: 'projects', interactive: true },
    notebook_generate: { area: 'projects' },
    // Webpages: the preview bridge, the public share, the CMS builder.
    webpage_bridge_ai: { area: 'webpages', interactive: true },
    webpage_bridge_ai_agentic: { area: 'webpages', interactive: true },
    public_share_bridge_ai: { area: 'webpages' },
    cms_builder: { area: 'webpages', interactive: true },
    // Skills: drafting, improving and testing one.
    skill_ai_draft: { area: 'skills' },
    skill_ai_improve: { area: 'skills' },
    skill_test: { area: 'skills', test: true },
    skill_test_grade: { area: 'skills', test: true },
    // Datatables.
    datatable_ai_draft: { area: 'datatables' },
    // Media: images, video, music, speech.
    image_generation: { area: 'media' },
    video_generation: { area: 'media' },
    music_generation: { area: 'media' },
    elevenlabs_music: { area: 'media' },
    elevenlabs_tts: { area: 'media' },
    elevenlabs_sfx: { area: 'media' },
    voice: { area: 'media', interactive: true },
    dictate: { area: 'media', interactive: true },
    // The product's own calls: the learning coach, the Studio router, the
    // Shield's custom-data assistant, the Nextcloud assistant, templates,
    // playbooks.
    learning_coach: { area: 'system' },
    learning_practice: { area: 'system' },
    shield_custom_data_assist: { area: 'system' },
    studio_ai_route: { area: 'system' },
    nextcloud_assistant: { area: 'system' },
    template_chat: { area: 'system', interactive: true },
    playbook: { area: 'system' },
    // The default logUsage writes when a caller names nothing.
    unknown: { area: OTHER_AREA },
});

/**
 * The area a source rolls up to; `other` for a source the table does not know.
 * @param {string | null | undefined} source
 * @returns {string}
 */
function areaOf(source) {
    if (typeof source !== 'string') return OTHER_AREA;
    const entry = SOURCES[source];
    return entry ? entry.area : OTHER_AREA;
}

/**
 * The Studio kind an area's spend belongs to, or null.
 * @param {string} areaId
 * @returns {string | null}
 */
function kindOfArea(areaId) {
    const area = AREAS.find((a) => a.id === areaId);
    return area ? area.kind : null;
}

/**
 * Whether a source means a person typed (so the request's client header is a
 * choice, not an accident of where the server happened to run).
 * @param {string | null | undefined} source
 * @returns {boolean}
 */
function isInteractiveSource(source) {
    if (typeof source !== 'string') return false;
    const entry = SOURCES[source];
    return !!(entry && entry.interactive);
}

/** @type {ReadonlyArray<string>} */
const INTERACTIVE_SOURCES = Object.freeze(Object.keys(SOURCES).filter((s) => !!SOURCES[s].interactive));

/**
 * The sources of a builder testing their own work (an agent's test chat and
 * test sets, a skill's test tab): the Adoption report leaves them out, a test
 * is not somebody using the thing.
 * @type {ReadonlyArray<string>}
 */
const TEST_SOURCES = Object.freeze(Object.keys(SOURCES).filter((s) => !!SOURCES[s].test));

/**
 * Whether a source is a builder's own test run.
 * @param {string | null | undefined} source
 * @returns {boolean}
 */
function isTestSource(source) {
    if (typeof source !== 'string') return false;
    const entry = SOURCES[source];
    return !!(entry && entry.test);
}

module.exports = {
    AREAS, AREA_IDS, OTHER_AREA, SOURCES, INTERACTIVE_SOURCES, TEST_SOURCES,
    areaOf, kindOfArea, isInteractiveSource, isTestSource,
};

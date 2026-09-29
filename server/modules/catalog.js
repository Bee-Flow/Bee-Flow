/**
 * Platform-module catalog — PURE DATA.
 *
 * The instance-level module layer sits ABOVE license/plan/org/group
 * entitlements: a module that is not imported behaves as if it doesn't exist
 * on the instance (its capabilities are dropped from the registry projection,
 * admin pickers and /my-entitlements; its routes 404). Everything below the
 * module layer is unchanged. Runtime state lives in the platform_modules
 * table (stores/platformModuleStore.js); the join happens in ./index.js.
 *
 * MUST stay pure data: no requires of DB/registry/runtime code — this file is
 * lazy-required from core/capabilityRegistry.js (moduleId stamping) and from
 * migrateDb.js, so any heavier import would create boot cycles.
 *
 * FUTURE "light build" NOTE: today every module's routes are still mounted
 * unconditionally in server/index.js behind requireModule() gates. A light
 * build must switch those mounts to a catalog-driven conditional loop over
 * MODULES instead of hardcoded app.use lines.
 *
 * GRANDFATHERING CONTRACT: ROW-ABSENT in platform_modules means "catalog
 * default" (defaultImported). Never flip an entry's defaultImported/available
 * without FIRST shipping an idempotent boot seed that materializes explicit
 * 'imported' rows for existing installs (precedent: the setImmediate one-shot
 * in server/index.js ~766 → migrations/mcp-as-integration-2026-06.js) —
 * otherwise the flip silently deactivates the module on every deployment.
 */

// ── Deploy-time edition switch ────────────────────────────────────────────
//
// `available:false` already trumps everything downstream (statusFor →
// 'unavailable', isActive → false, requireModule → 404, capabilities dropped
// from the registry projection), so the edition switch only has to compute
// that one flag. Nothing else in the module runtime needed changing.
//
// Reading process.env keeps this file pure data — no DB/registry/runtime
// requires, so the boot-cycle constraint in the header still holds.
//
//   BEEFLOW_EDITION=core        → every optional surface below is unavailable
//   BEEFLOW_MODULES=a,b,c       → explicit allow-list; wins over EDITION
//   (unset)                     → everything available  ← DEFAULT, unchanged
//
// The default is deliberately "everything on": an existing install that sets
// neither variable behaves exactly as it did before this catalog was filled.
const _EDITION = String(process.env.BEEFLOW_EDITION || 'full').trim().toLowerCase();
const _EXPLICIT = String(process.env.BEEFLOW_MODULES || '')
    .split(',').map(s => s.trim()).filter(Boolean);

function availableByEdition(id) {
    if (_EXPLICIT.length) return _EXPLICIT.includes(id);
    return _EDITION !== 'core';
}

// Built-in product surfaces. Each owns its routes, its workers and its
// capability ids; core (chat, agents, knowledge, integrations, auth, billing,
// privacy) is everything NOT listed here and can never be switched off.
//
// `defaultImported: true` on every entry is the grandfathering contract from
// the header: a row-absent install reads the catalog default, so filling this
// array does not deactivate anything on an existing deployment.
//
// NOT SEPARABLE, deliberately absent from this list (audited 2026-08-26):
//   core/cms/   — componentManager is a hard dependency of the agent runtime,
//                 chat tool stack, executionEngine and routes/execute; and
//                 core/cms/themeSpec is used by BOTH automation (form
//                 triggers) and appStudio (style knobs). The `cms` module
//                 below owns the CMS *product surface* (editor, builder,
//                 public site), never core/cms/.
//   core/voice/ — used by Voice Chat (its own capability) and the chat
//                 transcription tool, not just meeting notes.
const MODULES = [
    {
        id: 'automation',
        name: 'Automations',
        description: 'No-code automation builder, scheduled agent routines and the step runner.',
        category: 'Orchestration',
        capabilityIds: ['automations', 'agent_routines', 'automation_sharing'],
        defaultImported: true,
        available: availableByEdition('automation'),
    },
    {
        id: 'approvals',
        name: 'Approvals',
        description: 'Human-in-the-loop approval steps, stages and the approval inbox.',
        category: 'Orchestration',
        capabilityIds: ['approvals'],
        defaultImported: true,
        available: availableByEdition('approvals'),
    },
    {
        id: 'apps',
        name: 'App Studio',
        description: 'Build internal apps: data model, screens, actions and the runtime.',
        category: 'Build',
        capabilityIds: ['app_studio'],
        defaultImported: true,
        available: availableByEdition('apps'),
    },
    {
        id: 'compliance',
        name: 'Compliance Hub',
        description: 'GDPR, AI Act and ISO 27001 registers, DSR handling and evidence collection — plus the growing framework set (NIS2, CRA, Data Act, product liability, EAA, DORA, Machinery Regulation and custom questionnaires).',
        category: 'Governance',
        // One id per framework; the hub mount stays gated on compliance_hub_gdpr,
        // the others are enforced in-handler by compliance/frameworkPolicy.js.
        capabilityIds: [
            'compliance_hub_gdpr', 'compliance_hub_aia', 'compliance_hub_iso27001',
            'compliance_hub_nis2', 'compliance_hub_cra', 'compliance_hub_data_act', 'compliance_hub_pld',
            'compliance_hub_eaa', 'compliance_hub_dora', 'compliance_hub_machinery', 'compliance_hub_custom',
        ],
        defaultImported: true,
        available: availableByEdition('compliance'),
    },
    {
        id: 'support',
        name: 'Support Inbox',
        description: 'Helpdesk: ticket threads, the AI responder, SLA policies and CSAT.',
        category: 'Operations',
        capabilityIds: ['support_inbox'],
        defaultImported: true,
        available: availableByEdition('support'),
    },
    {
        id: 'webpages',
        name: 'Webpages',
        description: 'AI-generated shareable web pages and their preview/runtime surface.',
        category: 'Build',
        capabilityIds: ['webpages'],
        defaultImported: true,
        available: availableByEdition('webpages'),
    },
    {
        id: 'notebooks',
        name: 'Notebooks',
        description: 'Long-form notebook workspace and its retrieval tooling.',
        category: 'Build',
        capabilityIds: ['notebooks'],
        defaultImported: true,
        available: availableByEdition('notebooks'),
    },
    {
        id: 'meetingNotes',
        name: 'Meeting Notes',
        description: 'Recording intake, transcription, diarisation and meeting summaries.',
        category: 'Productivity',
        capabilityIds: ['meeting_notes'],
        defaultImported: true,
        available: availableByEdition('meetingNotes'),
    },
    {
        id: 'learning',
        name: 'Learning Center',
        description: 'Guided lessons, progress tracking and custom course content.',
        category: 'Productivity',
        capabilityIds: ['learning_center', 'learning_custom_content'],
        defaultImported: true,
        available: availableByEdition('learning'),
    },
    {
        id: 'projects',
        name: 'Solutions',
        description: 'Project workspaces that group agents, knowledge and automations.',
        category: 'Organisation',
        capabilityIds: ['projects', 'blueprint_packaging'],
        defaultImported: true,
        available: availableByEdition('projects'),
    },
];

function listModules() {
    return MODULES;
}

function getModule(id) {
    return MODULES.find(m => m.id === id) || null;
}

/**
 * Deploy-time availability of one built-in surface — synchronous, env-driven,
 * and fixed for the life of the process. Boot code uses THIS (not the async
 * isModuleActive) to decide whether to start a module's schedulers: an edition
 * never changes at runtime, so a core build should not pay to start workers it
 * will never use. Runtime import/remove toggling stays the per-tick
 * isModuleActive() check the module runtime already documents.
 *
 * Unknown ids answer true: core surfaces are not in this catalog and must
 * never be switched off by a typo.
 */
function isModuleAvailable(id) {
    const m = getModule(id);
    return m ? m.available !== false : true;
}

/** Reverse index: capability id → owning module id. */
function capabilityToModuleMap() {
    const map = new Map();
    for (const m of MODULES) {
        for (const capId of m.capabilityIds || []) map.set(capId, m.id);
    }
    return map;
}

module.exports = { MODULES, listModules, getModule, capabilityToModuleMap, availableByEdition, isModuleAvailable };

// @typecheck
'use strict';
/**
 * The skill row shape: the column map updates write through, and the
 * row-to-object mapper every reader shares (../skillStore.js and siblings).
 */

/**
 * The writable columns of a skill. A text facet and its structured twin are
 * always written together — resolveBodyWrite never produces one without the
 * other — so they sit next to each other here too.
 */
const SKILL_COLUMNS = {
    name: 'name',
    description: 'description',
    instructions: 'instructions',
    icon: 'icon',
    workflow: 'workflow',
    steps: { col: 'steps', cast: 'jsonb', transform: v => JSON.stringify(v) },
    rules: 'rules',
    rulesV2: { col: 'rules_v2', cast: 'jsonb', transform: v => JSON.stringify(v) },
    examples: 'examples',
    examplesV2: { col: 'examples_v2', cast: 'jsonb', transform: v => JSON.stringify(v) },
    outputSchema: { col: 'output_schema', cast: 'jsonb', transform: v => (v === null ? null : JSON.stringify(v)) },
    knowledgeBaseIds: { col: 'knowledge_base_ids', cast: 'jsonb', transform: v => JSON.stringify(v) },
    allowedAutomationIds: { col: 'allowed_automation_ids', cast: 'jsonb', transform: v => JSON.stringify(v) },
    isShared: { col: 'is_shared', transform: v => v === true },
    dynamicActivation: { col: 'dynamic_activation', transform: v => v === true },
    sharedGroups: { col: 'shared_groups', transform: v => JSON.stringify(Array.isArray(v) ? v : []) },
    automationId: { col: 'automation_id', transform: v => v || null },
    enabledIntegrations: { col: 'enabled_integrations', transform: v => JSON.stringify(Array.isArray(v) ? v : []) },
};

/**
 * @param {string} v
 */
function _jsonArray(v) {
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined || v === '') return [];
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (_) { return []; } }
    return [];
}

/**
 * @param {string} v
 */
function _jsonObjectOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return null; } }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function mapRow(r) {
    return {
        id: r.id,
        orgId: r.org_id,
        userId: r.user_id,
        name: r.name,
        description: r.description || '',
        instructions: r.instructions || '',
        workflow: r.workflow || '',
        rules: r.rules || '',
        examples: r.examples || '',
        icon: r.icon || '⚡',
        isShared: r.is_shared === true,
        dynamicActivation: r.dynamic_activation === true,
        sharedGroups: _jsonArray(r.shared_groups),
        automationId: r.automation_id || null,
        enabledIntegrations: _jsonArray(r.enabled_integrations),
        // Structured fields (S1). NULL in the DB = not yet parsed; presented as [].
        steps: _jsonArray(r.steps),
        rulesV2: _jsonArray(r.rules_v2),
        examplesV2: _jsonArray(r.examples_v2),
        outputSchema: _jsonObjectOrNull(r.output_schema),
        knowledgeBaseIds: _jsonArray(r.knowledge_base_ids),
        allowedAutomationIds: _jsonArray(r.allowed_automation_ids),
        projectId: r.project_id || null,
        version: Number.isFinite(Number(r.version)) && Number(r.version) > 0 ? Number(r.version) : 1,
        lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

module.exports = { SKILL_COLUMNS, mapRow };

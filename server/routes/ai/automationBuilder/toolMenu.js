// @typecheck
/**
 * Automation Builder — the tools a turn offers the model: the schema set by
 * feature flag and profile, the webpage inspection tools, the work-mode
 * filter, the web-research tools, and the Privacy Shield gate the org tools
 * and the web tools go through. Moved verbatim from ./chatStream.js.
 */

const { TOOL_SCHEMAS } = require('../../../automation/builderTools');
const { CORE_TOOL_NAMES } = require('../../../automation/builderModelProfiles');
const { projectToolSchemas } = require('../../../automation/builderTools/schemaProjection');
const { PLAN_TOOL, QUESTIONS_TOOL, toolAllowed } = require('./workMode');
const { INSPECTION_TOOLS } = require('./inspectionTools');
const { fallback } = require('../../../utils/bestEffort');

async function buildToolMenu(turn) {
    const {
        req, userId, codeStepEnabled, userOrgForTiers, draftWrap, turnMode, bufferedBuild, permissionMode,
        planAllowsRemoval, questionsClosed, modelId, profile, webResearch,
    } = turn;
    // Filter the tool schema set: by feature flag AND by profile.
    // The 'core' subset shrinks the tool menu from 26 to 13 for small
    // models. The five legacy array tools are still listed in full
    // mode so existing chat histories keep validating; core mode
    // hides them in favour of the unified builder_add_array_op.
    let tools = TOOL_SCHEMAS.filter(t => codeStepEnabled || t.function.name !== 'builder_add_code_step');
    if (profile.toolset === 'core') {
        tools = tools.filter(t => CORE_TOOL_NAMES.has(t.function.name));
    }
    // The band's schema variant: 'lean' (small) hands the model the diet
    // in builderTools/schemaProjection.js — shorter texts, shared params
    // once, four tools fewer; 'full' is the identity and keeps the very
    // objects the cloud bands' prompt caches hold.
    tools = projectToolSchemas(tools, { variant: profile.schemaVariant, codeStepEnabled });

    // Inspection tools: if the user has the webpages beta, expose the
    // same surface the direct-chat AI uses (schema/query/exec, file
    // read/write/replace/patch, set metadata, create, list). The builder
    // calls them while designing the automation so it can read the real
    // table columns before drafting an INSERT, etc.
    let webpageInspectorEnabled = false;
    let webpageInspectorCtx = null;
    try {
        const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
        webpageInspectorEnabled = await userHasBetaFeature(userId, 'webpages', req.session);
    } catch (err) { fallback('routes/ai/automationBuilder/toolMenu:buildToolMenu', err); /* default false */ }
    if (webpageInspectorEnabled) {
        const { WEBPAGE_AUTOMATION_TOOLS } = require('../../../integrations/webpageAutomationTools');
        const { resolveUserGroups } = require('../../../auth/audience');
        const { resolveUserOrgIds } = require('../../../auth/permissions');
        const userGroupIds = await resolveUserGroups(userId).catch((e) => fallback('routes/ai/automationBuilder/toolMenu:buildToolMenu#2', e, []));
        const orgIdsSet = await resolveUserOrgIds(req).catch((e) => fallback('routes/ai/automationBuilder/toolMenu:buildToolMenu#3', e, null));
        const userOrgIds = orgIdsSet instanceof Set ? [...orgIdsSet] : [];
        webpageInspectorCtx = {
            userId,
            organizationId: req.session?.user?.organizationId || null,
            userGroupIds,
            userOrgIds,
        };
        // Only for profiles carrying the FULL tool menu. This push happens
        // after the CORE_TOOL_NAMES filter above, so on a small model it
        // silently re-expanded a deliberately reduced menu with six tools
        // the LEAN prompt documents nowhere (the webpage guidance lives
        // only in buildFullSystemPrompt). Given undocumented database
        // tools, a small model uses them: a measured invoice build added
        // `webpages_list`, `webpage_db_schema` and `webpage_db_exec` steps
        // alongside the spreadsheet it had already been asked for.
        if (profile.toolset === 'full') {
            for (const tool of WEBPAGE_AUTOMATION_TOOLS) {
                if (!tools.find(t => t.function.name === tool.function.name)) tools.push(tool);
            }
        } else {
            webpageInspectorEnabled = false;
        }
    }
    if (req.body.workMode) {
        tools = tools.filter(t => toolAllowed(t.function.name, permissionMode, { planAllowsRemoval }) && !(bufferedBuild && t.function.name === 'builder_remove_step'));
        tools.push(...INSPECTION_TOOLS);
        // After the user's answers the plan follows; the card is not offered
        // again (and a hallucinated call is refused at the dispatch).
        if (!questionsClosed) tools.push(QUESTIONS_TOOL);
        if (turnMode === 'plan') tools.push(PLAN_TOOL);
    }
    // After the work-mode filter on purpose: the web tools only read, so
    // every mode may use them (workMode.js READ_TOOLS), and on every model
    // band, because the turn's prompt line documents them.
    for (const tool of webResearch.tools) {
        if (!tools.find(t => t.function.name === tool.function.name)) tools.push(tool);
    }
    // What the model can call this turn, so a hint names a tool it has
    // (a type change is sent as replace_step, or as an update_step patch
    // where the small-model menu has no replace_step).
    draftWrap._offeredTools = new Set(tools.map(t => t.function.name));
    const { isWebpageAutomationTool, executeWebpageAutomationTool } = require('../../../integrations/webpageAutomationTools');
    // The webpage tools above are the org's own tools (the dispatcher's
    // webpage_db_query / webpage_file_read / ...), called here on behalf of
    // the builder's model. The Privacy Shield tool block lists ("Outside
    // tools" / "Own server") hold for them as in direct chat (BFSF-354):
    // the turn's shield, resolved on the first such call only. A failed
    // lookup leaves the lists unapplied, as a missing shield does. The web
    // research tools (agent_search, read_url) go through the same gate.
    const toolPiiGate = require('../../../core/privacy/toolPiiGate');
    let shieldLookup = null; // started by the first webpage or web tool call
    const webpageToolGate = toolPiiGate.toolLoopGate({
        shield: () => (shieldLookup ??= toolPiiGate.resolveToolShield(
            () => require('../../../core/privacy/orgShield').resolveShieldFor({ orgId: userOrgForTiers, userId }), 'AutomationBuilder')),
        tag: 'AutomationBuilder',
        // This turn's attribution, read when the row is written.
        audit: (fields) => require('../../../stores/guardrailEventStore').logGuardrailEvent({
            organization_id: userOrgForTiers, user_id: userId, automation_id: draftWrap.automationId || null,
            ...fields, source: 'automation_builder', model: modelId || null,
        }),
    });

    Object.assign(turn, { tools, webpageInspectorEnabled, webpageInspectorCtx, isWebpageAutomationTool, executeWebpageAutomationTool, webpageToolGate });
}

module.exports = { buildToolMenu };

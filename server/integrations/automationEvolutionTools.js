// @typecheck
/**
 * Automation evolution tools — an automation looks at its own run history, proposes a
 * change to its own definition, and (after a human approved it) applies it.
 *
 * SELF-SCOPE: every tool acts on context.automationId — the automation that is
 * executing the step. There is no parameter to name another automation, and a
 * proposal is only ever applied to the automation it was proposed for. Outside a
 * automation (chat) these tools are not offered at all (availableTo automation_step).
 *
 * DRY RUN: proposing and applying are side effects. When the runner is not in
 * live mode (context.autoSend !== true) they return a simulated result and
 * write nothing, so a dry run of the evolution root never creates proposals.
 */

const { AUTOMATION_EVOLUTION_TOOLS } = require('./automationEvolutionToolDefs');

const NAMES = new Set(AUTOMATION_EVOLUTION_TOOLS.map(t => t.function.name));
function isAutomationEvolutionTool(toolName) { return NAMES.has(toolName); }

function publicRow(row) {
    if (!row) return null;
    return {
        evolutionId: row.id, status: row.status, rationale: row.rationale, expectedEffect: row.expectedEffect, risk: row.risk,
        versionBefore: row.versionBefore, versionAfter: row.versionAfter, canaryRuns: row.canaryRuns, error: row.error, createdAt: row.createdAt, appliedAt: row.appliedAt,
    };
}

function defaultDeps() {
    return {
        svc: require('../automation/evolution'),
        getEvolution: (id) => require('../stores/automationStore').getEvolution(id),
    };
}

async function executeAutomationEvolutionTool(toolName, args = {}, context = {}, deps = defaultDeps()) {
    const { svc, getEvolution } = deps;
    const automationId = context.automationId || null;
    const userId = context.userId || null;
    if (!automationId) return { error: 'This tool only works inside a running automation (no automation in context).' };
    if (!userId) return { error: 'This tool needs the automation owner in context.' };
    const live = context.autoSend === true;

    if (toolName === 'automation_runs_summary') {
        return svc.summariseRuns(automationId, { days: args.days });
    }
    if (toolName === 'automation_propose_evolution') {
        const planErr = svc.validatePlan(args.plan);
        if (planErr) return { error: planErr };
        if (!live) return { simulated: true, status: 'proposed', evolutionId: 'evo_dry_run', message: 'Dry run: the proposal was validated but not stored.' };
        try {
            const row = await svc.proposeEvolution({ automationId, userId, rationale: args.rationale, expectedEffect: args.expectedEffect, risk: args.risk, plan: args.plan, canaryRuns: args.canaryRuns });
            return publicRow(row);
        } catch (e) { return { error: e.message }; }
    }
    if (toolName === 'automation_apply_evolution') {
        const id = String(args.evolutionId || '').trim();
        if (!id) return { error: 'evolutionId is required' };
        if (!live) return { simulated: true, status: 'canary', evolutionId: id, message: 'Dry run: nothing was applied.' };
        try {
            const row = await getEvolution(id);
            if (!row) return { error: 'Evolution not found' };
            if (row.automationId !== automationId) return { error: 'That proposal belongs to a different automation — an automation can only apply its own.' };
            const out = await svc.applyEvolution(id, { userId });
            return publicRow(out);
        } catch (e) { return { error: e.message }; }
    }
    return { error: `Unknown tool: ${toolName}` };
}

module.exports = { AUTOMATION_EVOLUTION_TOOLS, isAutomationEvolutionTool, executeAutomationEvolutionTool };

/**
 * Routine evolution tools — a routine looks at its own run history, proposes a
 * change to its own definition, and (after a human approved it) applies it.
 *
 * SELF-SCOPE: every tool acts on context.automationId — the routine that is
 * executing the step. There is no parameter to name another routine, and a
 * proposal is only ever applied to the routine it was proposed for. Outside a
 * routine (chat) these tools are not offered at all (availableTo routine_step).
 *
 * DRY RUN: proposing and applying are side effects. When the runner is not in
 * live mode (context.autoSend !== true) they return a simulated result and
 * write nothing, so a dry run of the evolution root never creates proposals.
 */

const ROUTINE_EVOLUTION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'routine_runs_summary',
            description: 'How THIS routine has been running: live runs in the last N days by status and error class, handled errors, average duration, and a breakdown per entry point (trigger). Use it to find what fails, what never runs, and where a change would help.',
            parameters: { type: 'object', properties: { days: { type: 'integer', description: 'Window in days (1-365, default 30).' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'routine_propose_evolution',
            description: 'Record a proposal to change THIS routine\'s own definition. Nothing changes yet: a human approves it first, then routine_apply_evolution applies it as a new version with a canary and automatic rollback. The plan is a list of builder calls from a narrow vocabulary: builder_update_step, builder_update_steps, builder_add_notification, builder_wire_error_branch, builder_add_set, builder_add_filter, builder_add_condition, builder_add_note, builder_set_metadata — prompt and threshold edits, an extra guard or notification, an error branch. Never triggers, removals or flowlet changes.',
            parameters: {
                type: 'object',
                properties: {
                    rationale: { type: 'string', description: 'Why, in plain language, with the numbers that justify it.' },
                    expectedEffect: { type: 'string', description: 'What should improve, measurably.' },
                    risk: { type: 'string', description: 'What could go wrong and how the canary would show it.' },
                    plan: { type: 'array', description: 'Ordered builder calls: [{ tool, args }]. args are exactly the tool\'s arguments (stepId, patch, ...). Max 12.', items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool', 'args'] } },
                    canaryRuns: { type: 'integer', description: 'How many live runs to watch before judging (default 20).' },
                },
                required: ['rationale', 'expectedEffect', 'risk', 'plan'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'routine_apply_evolution',
            description: 'Apply a proposal that a human approved, to THIS routine only. Runs the plan through the builder on a copy, validates, saves a new version, and starts the canary. Returns the row with status canary, or failed with the reason.',
            parameters: { type: 'object', properties: { evolutionId: { type: 'string' } }, required: ['evolutionId'] },
        },
    },
];

const NAMES = new Set(ROUTINE_EVOLUTION_TOOLS.map(t => t.function.name));
function isRoutineEvolutionTool(toolName) { return NAMES.has(toolName); }

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

async function executeRoutineEvolutionTool(toolName, args = {}, context = {}, deps = defaultDeps()) {
    const { svc, getEvolution } = deps;
    const automationId = context.automationId || null;
    const userId = context.userId || null;
    if (!automationId) return { error: 'This tool only works inside a running routine (no automation in context).' };
    if (!userId) return { error: 'This tool needs the routine owner in context.' };
    const live = context.autoSend === true;

    if (toolName === 'routine_runs_summary') {
        return svc.summariseRuns(automationId, { days: args.days });
    }
    if (toolName === 'routine_propose_evolution') {
        const planErr = svc.validatePlan(args.plan);
        if (planErr) return { error: planErr };
        if (!live) return { simulated: true, status: 'proposed', evolutionId: 'evo_dry_run', message: 'Dry run: the proposal was validated but not stored.' };
        try {
            const row = await svc.proposeEvolution({ automationId, userId, rationale: args.rationale, expectedEffect: args.expectedEffect, risk: args.risk, plan: args.plan, canaryRuns: args.canaryRuns });
            return publicRow(row);
        } catch (e) { return { error: e.message }; }
    }
    if (toolName === 'routine_apply_evolution') {
        const id = String(args.evolutionId || '').trim();
        if (!id) return { error: 'evolutionId is required' };
        if (!live) return { simulated: true, status: 'canary', evolutionId: id, message: 'Dry run: nothing was applied.' };
        try {
            const row = await getEvolution(id);
            if (!row) return { error: 'Evolution not found' };
            if (row.automationId !== automationId) return { error: 'That proposal belongs to a different routine — a routine can only apply its own.' };
            const out = await svc.applyEvolution(id, { userId });
            return publicRow(out);
        } catch (e) { return { error: e.message }; }
    }
    return { error: `Unknown tool: ${toolName}` };
}

module.exports = { ROUTINE_EVOLUTION_TOOLS, isRoutineEvolutionTool, executeRoutineEvolutionTool };

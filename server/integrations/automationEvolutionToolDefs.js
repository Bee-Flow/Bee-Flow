// @typecheck
/**
 * Schema definitions for the automation evolution tools (data only, no requires).
 * Kept as a leaf so tool-catalogue code can read the schemas without loading the
 * evolution service. Behaviour lives in automationEvolutionTools.js.
 */

const AUTOMATION_EVOLUTION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'automation_runs_summary',
            description: 'How THIS automation has been running: live runs in the last N days by status and error class, handled errors, average duration, and a breakdown per entry point (trigger). Use it to find what fails, what never runs, and where a change would help.',
            parameters: { type: 'object', properties: { days: { type: 'integer', description: 'Window in days (1-365, default 30).' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'automation_propose_evolution',
            description: 'Record a proposal to change THIS automation\'s own definition. Nothing changes yet: a human approves it first, then automation_apply_evolution applies it as a new version with a canary and automatic rollback. The plan is a list of builder calls from a narrow vocabulary: builder_update_step, builder_update_steps, builder_add_notification, builder_wire_error_branch, builder_add_set, builder_add_filter, builder_add_condition, builder_add_note, builder_set_metadata — prompt and threshold edits, an extra guard or notification, an error branch. Never triggers, removals or flowlet changes.',
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
            name: 'automation_apply_evolution',
            description: 'Apply a proposal that a human approved, to THIS automation only. Runs the plan through the builder on a copy, validates, saves a new version, and starts the canary. Returns the row with status canary, or failed with the reason.',
            parameters: { type: 'object', properties: { evolutionId: { type: 'string' } }, required: ['evolutionId'] },
        },
    },
];

module.exports = { AUTOMATION_EVOLUTION_TOOLS };

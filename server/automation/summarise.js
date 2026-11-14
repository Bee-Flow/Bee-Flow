// @typecheck
/**
 * Deterministic plain-English summary of an automation definition.
 *
 * Used by the Builder agent's `summarise_draft` tool and rendered in the
 * UI so the user can read what the automation will do. No LLM call —
 * cheap, predictable, diffable across drafts. Side-effect lines start
 * with **bold** so the user notices what the automation will write.
 */

const { agentCallParams } = require('./agentCallContract');
const { triggerStateLine } = require('./summariseTriggerLine');
// One step in words (the author's line, the model's line, side effect or not).
const { describeStep, stepHasSideEffect, renderStepState } = require('./summariseStep');

function describeTrigger(trigger) {
    if (!trigger) return 'When triggered';
    switch (trigger.kind) {
        case 'schedule': {
            const cron = trigger.schedule?.cron || '';
            const tz = trigger.schedule?.tz || 'Europe/Amsterdam';
            return `On schedule (\`${cron}\`, ${tz})`;
        }
        case 'manual': return 'When run manually';
        case 'webhook': return 'When the webhook URL is called';
        case 'agent_call': {
            const name = trigger.toolName || `automation_${trigger.id || ''}`;
            const args = agentCallParams(trigger).map(p => (p.required ? p.name : `${p.name}?`));
            return `When an AI agent calls it (\`${name}\`${args.length ? `, arguments: ${args.join(', ')}` : ''})`;
        }
        case 'app_event': {
            const provider = trigger.appEvent?.provider || 'app';
            const ev = trigger.appEvent?.event || 'event';
            const f = trigger.appEvent?.filter;
            const filt = f ? ` filtered by ${JSON.stringify(f)}` : '';
            return `When ${provider} emits "${ev}"${filt}`;
        }
        default: return `On trigger (${trigger.kind || 'unknown'})`;
    }
}

/**
 * Produce a markdown plain-English summary of the automation.
 *
 * Returns:
 *   { summary: string, hasSideEffects: boolean }
 */
function summariseDefinition(def) {
    if (!def || typeof def !== 'object') {
        return { summary: '_(empty draft)_', hasSideEffects: false };
    }
    /** @type {string[]} */
    const lines = [];
    lines.push(`**Trigger:** ${describeTrigger(def.trigger)}.`);
    for (const t of (Array.isArray(def.triggers) ? def.triggers : [])) {
        if (!t || typeof t !== 'object') continue;
        lines.push(`**Also starts:** ${describeTrigger(t)} (trigger \`${t.id}\`${t.label ? `, "${t.label}"` : ''}).`);
    }
    lines.push('');
    lines.push('**Steps:**');

    let hasSideEffects = false;
    // Notes (BFSF-411) are canvas annotations, not steps the automation runs —
    // numbering them alongside real steps would misreport what step 4 in the
    // list actually does, and describeStep has no case for 'note' anyway (it
    // would fall through to the raw-type default line).
    const steps = (Array.isArray(def.steps) ? def.steps : []).filter((/** @type {{ type: string; }} */ s) => s?.type !== 'note');
    if (steps.length === 0) {
        lines.push('_(no steps yet)_');
    } else {
        steps.forEach((s, i) => {
            const desc = describeStep(s, i);
            if (stepHasSideEffect(s)) hasSideEffects = true;
            lines.push(desc);
        });
    }

    return { summary: lines.join('\n'), hasSideEffects };
}

// ── Agent-facing structured draft state ──────────────────────────────────
// Unlike summariseDefinition (human prose, root-only, no IDs), this renders a
// compact but COMPLETE view for the builder AGENT: every step's real id, type,
// tool/op, label, key settings AND its input bindings (the mapping between
// steps) — for the main flow AND every inline flowlet, plus the edge wiring.
// The agent reads step IDs + current bindings here instead of asking the user.

/**
 * @param {string[]} out
 * @param {{ codeParams?: (code: string) => Array<object> | null; }} [opts]
 */
function renderGraphState(graph, out, opts = {}) {
    if (graph.trigger) out.push(triggerStateLine(graph.trigger, graph));
    for (const x of (Array.isArray(graph.triggers) ? graph.triggers : [])) {
        if (!x || typeof x !== 'object') continue;
        const detail = x.appEvent ? ` ${x.appEvent.provider}.${x.appEvent.event}` : (x.schedule?.cron ? ` ${x.schedule.cron}` : '');
        out.push(`  - \`${x.id}\` trigger:${x.kind}${detail} [additional entry point${x.label ? `, "${x.label}"` : ''}]`);
    }
    for (const s of (Array.isArray(graph.steps) ? graph.steps : [])) out.push(renderStepState(s, opts));
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    if (edges.length) {
        out.push(`  wiring: ${edges.map(e => `${e.from}→${e.to}${e.label ? `(${e.label})` : ''}`).join(', ')}`);
    }
}

/**
 * @param {import('../core/automationModel/automationGraph').AutomationDefinition} def   the draft definition
 * @param {{ codeParams?: (code: string) => Array<object>|null }} [opts]
 */
function renderAgentDraftState(def, opts = {}) {
    if (!def || typeof def !== 'object') return '_(empty draft)_';
    const out = ['MAIN FLOW:'];
    renderGraphState(def, out, opts);
    const layers = (def.layers && typeof def.layers === 'object' && !Array.isArray(def.layers)) ? def.layers : {};
    for (const [key, g] of Object.entries(layers)) {
        if (!g || typeof g !== 'object') continue;
        out.push('');
        out.push(`FLOWLET \`${key}\`${g.title ? ` — "${g.title}"` : ''}:`);
        renderGraphState(g, out, opts);
    }
    return out.join('\n');
}

module.exports = { summariseDefinition, renderAgentDraftState };

/** @typedef {{ kind?: string, path?: string, value?: unknown } | string | number | boolean | null | undefined} SummaryBinding */

/** @typedef {{ name?: string, required?: boolean, default?: unknown }} CodeParam */

/** @typedef {{ id?: string, type?: string, label?: string } & Record<string, unknown>} SummaryStep */

/**
 * @typedef {{ kind?: string, id?: string, label?: string, toolName?: string, schedule?: { cron?: string, tz?: string },
 *   appEvent?: { provider?: string, event?: string, filter?: unknown }, params?: Array<string|{ name?: string }> }} SummaryTrigger
 */

/**
 * @typedef {{ trigger?: SummaryTrigger, triggers?: SummaryTrigger[], steps?: SummaryStep[],
 *   edges?: Array<{ from?: string, to?: string, label?: string }>, title?: string }} SummaryGraph
 */

/**
 * The closed list of what a Cowork plan may hold.
 *
 * A plan runs unattended, as its owner, on the automation engine. The engine can do far more than a person who
 * typed one sentence should be handed: free web addresses, code, sub-flows, public forms. So a plan is held to a
 * short list, the way an App Studio trigger is (decision 0023): a step type that is not on it is refused when the
 * plan is made, when it is turned on and at every run, by this one file.
 *
 * Every allowed type has the KIND a person reads it as. A type that is refused says why, in a sentence that can be
 * shown as it is.
 */

import type { StepKind } from './planTypes.mts';

const KINDS: Readonly<Record<string, StepKind>> = Object.freeze({
    // An action in a connected app, and the control flow around it.
    integration_action: 'fixed',
    condition: 'fixed',
    switch: 'fixed',
    loop: 'fixed',
    stop_error: 'fixed',
    // Reshaping data inside the run.
    set: 'fixed',
    datetime: 'fixed',
    filter: 'fixed',
    limit: 'fixed',
    dedupe: 'fixed',
    aggregate: 'fixed',
    summarize: 'fixed',
    flatten: 'fixed',
    read_table: 'fixed',
    table: 'fixed',
    // The organisation's own tables and documents.
    datatable: 'fixed',
    generate_document: 'fixed',
    // The Privacy Shield as steps.
    guard: 'fixed',
    tokenize: 'fixed',
    untokenize: 'fixed',
    // A model reads, judges or writes.
    ai_step: 'ai',
    data_extraction: 'ai',
    // A person decides.
    approval: 'ask',
    // The result reaches the owner.
    notification: 'deliver',
});

const REFUSED: Readonly<Record<string, string>> = Object.freeze({
    code: 'A plan cannot run a script yet: scripts arrive with the sandbox that runs outside the server process.',
    http_request: 'A plan reaches the outside world through a connected app, not through a free web address.',
    call_block: 'A plan cannot call a building block: what the block does is not in the plan, so it cannot be shown or approved.',
    call_layer: 'A plan is one list of steps: sub-flows are for Studio automations.',
    layer_output: 'A plan is one list of steps: sub-flows are for Studio automations.',
    parallel: 'A plan runs its steps one after another.',
    wait: 'A plan cannot pause for a set time yet.',
    form_page: 'A plan has no public form.',
    return_to_app: 'A plan is not started by a Studio App.',
    knowledge_write: 'A plan cannot write into a knowledge base: what it stores there is later stated as fact.',
    kb_query_log: 'A plan cannot read or review a knowledge base log.',
    write_table: 'A plan cannot write a table file yet.',
    fill_document: 'A plan cannot fill a designed document yet.',
    slide: 'A plan cannot build a presentation yet.',
    presentation: 'A plan cannot build a presentation yet.',
    parse_json: 'This step type is retired.',
    ai_tool: 'A plan uses an AI step, not a single AI tool call.',
});

/** What may start a plan: the clock, a person, or an event of a connected app (a new mail). */
export const PLAN_TRIGGER_KINDS: readonly string[] = Object.freeze(['schedule', 'manual', 'app_event']);

/** Step types that are part of a definition but not of the work: skipped, never refused. */
const ANNOTATIONS: ReadonlySet<string> = new Set(['note', 'trigger']);

export function isAnnotation(type: unknown): boolean {
    return typeof type === 'string' && ANNOTATIONS.has(type);
}

/** The kind a person reads this step type as, or null when a plan may not hold it. */
export function kindOfStepType(type: unknown): StepKind | null {
    return typeof type === 'string' && Object.prototype.hasOwnProperty.call(KINDS, type) ? KINDS[type] ?? null : null;
}

/** Why a plan may not hold this step type (for a type on neither list: it is simply not known here). */
export function refusalOfStepType(type: unknown): string {
    const name = typeof type === 'string' && type ? type : 'a step without a type';
    if (typeof type === 'string' && Object.prototype.hasOwnProperty.call(REFUSED, type)) return REFUSED[type] ?? '';
    return `A plan cannot hold "${name}": it is not on the list of steps Cowork runs.`;
}

/** Every step type a plan may hold, sorted (the planner is told this list, and tests pin it). */
export function planStepTypes(): string[] {
    return Object.keys(KINDS).sort();
}

/** Every step type with a written refusal, sorted. */
export function refusedStepTypes(): string[] {
    return Object.keys(REFUSED).sort();
}

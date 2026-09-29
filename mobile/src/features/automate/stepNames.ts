/**
 * What a step is CALLED, on a phone.
 *
 * The run timeline printed `step.stepType` straight out of the payload, so a
 * run read "integration_action · 1.2s", "knowledge_write", "stop_error". Those
 * are the engine's own identifiers — the same machine vocabulary the web
 * builder spent a release getting off its canvas — and they are the only
 * description of a step a phone shows at all. Someone checking on a routine
 * from their phone got a column of snake_case tokens where the browser, on the
 * very same run, says "Action", "To knowledge base", "Stop".
 *
 * The names here are WEB'S names, copied deliberately rather than invented:
 * nodeDefs.js `typeLabel` in agent-hub. One run must not read as two different
 * routines depending on which screen you opened it on, and a second
 * vocabulary invented here would be exactly that. stepLockstep.test.ts is what
 * keeps this list answerable to the server's own step-type registry — adding a
 * step type on the server fails that test until a person decides what the
 * phone calls it, which is the whole point: the decision gets made rather than
 * defaulting to a token on a screen.
 *
 * Why a copy and not an import: nodeDefs.js is an ESM module in the web app's
 * build, pulling in i18n and lucide. The server's step-type REGISTRY
 * (automation/builtinStepTools.js) is plain CommonJS with no imports, so the
 * coverage question — "is every type accounted for" — is answered against
 * that, which is the half a copy cannot fake.
 */

/** Step type → the phrase the web builder uses for it. */
export const STEP_TYPE_NAMES: Record<string, string> = {
    trigger: 'Trigger',
    ai_step: 'AI step',
    data_extraction: 'Extract data',
    integration_action: 'Action',
    // All three runtime shapes of the one Condition node in the builder.
    condition: 'Condition',
    switch: 'Condition',
    filter: 'Condition',
    loop: 'Repeat',
    loop_item: 'Each item',
    wait: 'Wait',
    stop_error: 'Stop',
    return_to_app: 'Back to the app',
    notification: 'Notification',
    form_page: 'Form page',
    guard: 'Personal data check',
    tokenize: 'Hide personal data',
    untokenize: 'Show real values',
    set: 'Edit data',
    datetime: 'Date & time',
    http_request: 'Web service call',
    generate_document: 'Make a document',
    slide: 'Slide',
    presentation: 'Presentation',
    fill_document: 'Fill a document',
    parse_json: 'Parse JSON',
    code: 'Code',
    limit: 'Shorten list',
    datatable: 'Datatable',
    knowledge_write: 'To knowledge base',
    dedupe: 'Remove duplicates',
    aggregate: 'Collect one field',
    summarize: 'Add up or count',
    note: 'Note',
    call_layer: 'Flowlet',
    call_block: 'Step',
    layer_output: 'Return',
    approval: 'Approval',
    parallel: 'Parallel',
    ai_tool: 'Tool',
};

/**
 * Step types that are real on the server and deliberately have no name here,
 * with the reason. A decision recorded, not an omission — the third of the
 * three answers stepLockstep.test.ts accepts.
 *
 * There are none today: every type the server can build has a name above.
 * The list stays because the alternative to an empty list is a test that
 * silently accepts a missing name the first time someone adds a step type.
 */
export const UNNAMED_STEP_TYPES: Record<string, string> = {};

/**
 * The phrase for a step type, or the raw type when it is one we have never
 * heard of.
 *
 * The fallback is the raw string ON PURPOSE. A server this phone talks to may
 * be newer than the app — the whole upgrade programme is built on that — and a
 * step type we cannot name is still a step that ran. Printing the identifier
 * is ugly; printing nothing, or "Unknown step", would delete the one clue
 * someone has about what that row in their run actually was.
 */
export function stepTypeName(type: string | null | undefined): string | null {
    if (typeof type !== 'string' || !type.trim()) return null;
    return STEP_TYPE_NAMES[type] ?? type;
}

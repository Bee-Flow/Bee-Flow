/**
 * What a step is CALLED, on a phone.
 *
 * The run timeline printed `step.stepType` straight out of the payload, so a
 * run read "integration_action · 1.2s", "knowledge_write", "stop_error". Those
 * are the engine's own identifiers — the same machine vocabulary the web
 * builder spent a release getting off its canvas — and they are the only
 * description of a step a phone shows at all. Someone checking on an automation
 * from their phone got a column of snake_case tokens where the browser, on the
 * very same run, says "Action", "To knowledge base", "Stop".
 *
 * The names here are WEB'S names, copied deliberately rather than invented:
 * nodeDefs.js `typeLabel` in agent-hub. One run must not read as two different
 * automations depending on which screen you opened it on, and a second
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

import { translate } from '@/core/i18n';

/** Step type → the phrase the web builder uses for it, with the key the web translates it under. */
export const STEP_TYPE_WORDS: Record<string, { i18nKey: string; en: string }> = {
    trigger: { i18nKey: 'automations.node.trigger.typeLabel', en: 'Trigger' },
    ai_step: { i18nKey: 'automations.node.ai_step.typeLabel', en: 'AI step' },
    data_extraction: { i18nKey: 'automations.node.data_extraction.typeLabel', en: 'Extract data' },
    integration_action: { i18nKey: 'automations.node.integration_action.typeLabel', en: 'Action' },
    // All three runtime shapes of the one Condition node in the builder.
    condition: { i18nKey: 'automations.node.condition.typeLabel', en: 'Condition' },
    switch: { i18nKey: 'automations.node.switch.typeLabel', en: 'Condition' },
    filter: { i18nKey: 'automations.node.filter.typeLabel', en: 'Condition' },
    loop: { i18nKey: 'automations.node.loop.typeLabel', en: 'Repeat' },
    loop_item: { i18nKey: 'automations.canvas.loop_each_item', en: 'Each item' },
    wait: { i18nKey: 'automations.node.wait.typeLabel', en: 'Wait' },
    stop_error: { i18nKey: 'automations.node.stop_error.typeLabel', en: 'Stop' },
    return_to_app: { i18nKey: 'automations.node.return_to_app.typeLabel', en: 'Back to the app' },
    notification: { i18nKey: 'automations.node.notification.typeLabel', en: 'Notification' },
    form_page: { i18nKey: 'automations.node.form_page.typeLabel', en: 'Form page' },
    guard: { i18nKey: 'automations.node.guard.typeLabel', en: 'Personal data check' },
    tokenize: { i18nKey: 'automations.node.tokenize.typeLabel', en: 'Hide personal data' },
    untokenize: { i18nKey: 'automations.node.untokenize.typeLabel', en: 'Show real values' },
    set: { i18nKey: 'automations.node.set.typeLabel', en: 'Edit data' },
    datetime: { i18nKey: 'automations.node.datetime.typeLabel', en: 'Date & time' },
    http_request: { i18nKey: 'automations.node.http_request.typeLabel', en: 'Web service call' },
    generate_document: { i18nKey: 'automations.node.generate_document.typeLabel', en: 'Make a document' },
    slide: { i18nKey: 'automations.node.slide.typeLabel', en: 'Slide' },
    presentation: { i18nKey: 'automations.node.presentation.typeLabel', en: 'Presentation' },
    fill_document: { i18nKey: 'automations.node.fill_document.typeLabel', en: 'Fill a document' },
    parse_json: { i18nKey: 'automations.node.parse_json.typeLabel', en: 'Parse JSON' },
    code: { i18nKey: 'automations.node.code.typeLabel', en: 'Code' },
    limit: { i18nKey: 'automations.node.limit.typeLabel', en: 'Shorten list' },
    datatable: { i18nKey: 'automations.node.datatable.typeLabel', en: 'Datatable' },
    read_table: { i18nKey: 'automations.node.read_table.typeLabel', en: 'Read table' },
    table: { i18nKey: 'automations.node.table.typeLabel', en: 'Edit table' },
    knowledge_write: { i18nKey: 'automations.node.knowledge_write.typeLabel', en: 'To knowledge base' },
    dedupe: { i18nKey: 'automations.node.dedupe.typeLabel', en: 'Remove duplicates' },
    aggregate: { i18nKey: 'automations.node.aggregate.typeLabel', en: 'Collect one field' },
    summarize: { i18nKey: 'automations.node.summarize.typeLabel', en: 'Add up or count' },
    flatten: { i18nKey: 'automations.node.flatten.typeLabel', en: 'Flatten a list' },
    note: { i18nKey: 'automations.note_node.note', en: 'Note' },
    call_layer: { i18nKey: 'automations.node.call_layer.typeLabel', en: 'Flowlet' },
    call_block: { i18nKey: 'automations.node.call_block.typeLabel', en: 'Step' },
    layer_output: { i18nKey: 'automations.node.layer_output.typeLabel', en: 'Return' },
    approval: { i18nKey: 'automations.node.approval.typeLabel', en: 'Approval' },
    parallel: { i18nKey: 'automations.node.parallel.typeLabel', en: 'Parallel' },
    ai_tool: { i18nKey: 'mobile.automations.step.ai_tool', en: 'Tool' },
};

/** The English of each name, for the lockstep tests; the screens read STEP_TYPE_WORDS through t(). */
export const STEP_TYPE_NAMES: Record<string, string> = Object.fromEntries(
    Object.entries(STEP_TYPE_WORDS).map(([type, word]) => [type, word.en]),
);

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
export function stepTypeName(type: string | null | undefined, t: (key: string, fallback: string) => string = translate): string | null {
    if (typeof type !== 'string' || !type.trim()) return null;
    const word = stepWord(type);
    return word ? t(word.i18nKey, word.en) : type;
}

/** An own-property read: a type of 'constructor' must not find Object.prototype. */
export function stepWord(type: string): { i18nKey: string; en: string } | undefined {
    return Object.prototype.hasOwnProperty.call(STEP_TYPE_WORDS, type) ? STEP_TYPE_WORDS[type] : undefined;
}

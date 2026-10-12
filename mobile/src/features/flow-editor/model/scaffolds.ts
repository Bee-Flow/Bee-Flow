/**
 * The per-kind defaults a freshly dropped step starts with — the body of the
 * web builder's `buildStepFromPayload` (applyAddNode.js), as a table. Pinned
 * by addNode.lockstep.test.ts, which drops every kind through both.
 *
 * The web's rules, kept: defaults pass the server's draft validation, and a
 * pointer with no honest default (which text, which table, which knowledge
 * base, which list) seeds EMPTY — a guessed one looks configured while doing
 * the wrong thing. Those gaps are completeness codes: they autosave amber and
 * block only activation.
 */

import { defaultFormEndingDeclaration, defaultFormPageDeclaration } from './formDefaults';
import { ROUTE_STEP_NAME } from './stepDisplayName';

/** What the palette hands over when something is dropped. */
export interface StepPayload {
    kind: string;
    label?: string;
    tool?: string;
    appId?: string;
    sideEffect?: boolean | null;
    triggerKind?: string;
    asSecondaryTrigger?: boolean;
    sourceRef?: string;
    mode?: string;
    layerKey?: string;
    blockId?: string;
    icon?: string | null;
    text?: unknown;
    [key: string]: unknown;
}

type Scaffold = (p: StepPayload) => Record<string, unknown>;

/** The names a form page is dropped with, by mode — node names, stored in the definition. */
export const FORM_PAGE_NAMES = Object.freeze({ input: 'Ask for more info', ending: 'Show a summary' } as const);

/** Seed values that become step configuration (the web's, verbatim). */
const SEED = Object.freeze({ notificationTitle: 'Notification', stopReason: 'Halted' });

const CODE_TEMPLATE = '// async function main(inputs, ctx) {\n//   return inputs;\n// }\nreturn inputs;';

const integrationAction: Scaffold = (p) => ({
    tool: p.tool || '',
    label: p.label || p.tool || 'Integration',
    inputs: {},
    ...(p.appId ? { appId: p.appId } : null),
    ...(p.sideEffect != null ? { sideEffect: p.sideEffect } : null),
});

const formPage: Scaffold = (p) => {
    const ending = p.mode === 'ending';
    return {
        mode: ending ? 'ending' : 'input',
        form: ending ? defaultFormEndingDeclaration() : defaultFormPageDeclaration(),
        ...(ending ? null : { waitSeconds: 3600 }),
        label: p.label || (ending ? FORM_PAGE_NAMES.ending : FORM_PAGE_NAMES.input),
    };
};

const SCAFFOLDS: Record<string, Scaffold> = {
    integration_action: integrationAction,
    ai_step: (p) => ({ prompt: 'Describe what the AI should do here.', modelTier: 'auto', allowTools: false, inputs: {}, label: p.label || 'AI step' }),
    data_extraction: (p) => ({ fields: [{ name: '', type: 'string', description: '', required: false }], label: p.label || 'Extract data' }),
    condition: (p) => ({ expr: 'true', label: p.label || 'Condition' }),
    tokenize: (p) => ({ sourceRef: p.sourceRef || '', label: p.label || 'Hide personal data' }),
    untokenize: (p) => ({ sourceRef: p.sourceRef || '', label: p.label || 'Show real values again' }),
    guard: (p) => ({ sourceRef: p.sourceRef || '', label: p.label || 'Check for personal data' }),
    loop: (p) => ({ itemVar: 'item', overRef: '', maxIterations: 100, body: [], label: p.label || 'Loop' }),
    notification: (p) => ({ title: SEED.notificationTitle, body: '', channels: ['notification'], label: p.label || 'Notification' }),
    http_request: (p) => ({
        url: '', method: 'GET', headers: {}, body: '', timeoutMs: 10_000, blockPrivateTargets: true, label: p.label || 'HTTP Request',
    }),
    generate_document: (p) => ({
        content: '', contentFormat: 'markdown', format: 'pdf', title: '', fileName: '', expiresInDays: 7, label: p.label || 'Make a document',
    }),
    slide: (p) => ({ title: '', content: '', notes: '', label: p.label || 'Slide' }),
    presentation: (p) => ({
        slides: '', title: '', subtitle: '', fileName: '', format: 'pptx', houseStyle: true, expiresInDays: 7, label: p.label || 'Presentation',
    }),
    fill_document: (p) => ({ documentId: '', values: {}, fileName: '', expiresInDays: 7, label: p.label || 'Fill a document' }),
    form_page: formPage,
    code: (p) => ({ code: CODE_TEMPLATE, language: 'javascript', label: p.label || 'Code' }),
    set: (p) => ({ fields: {}, label: p.label || 'Edit data' }),
    parse_json: (p) => ({ sourceRef: '', mode: 'paths', fields: [], label: p.label || 'Parse JSON' }),
    datetime: (p) => ({ op: 'now', label: p.label || 'Date & Time' }),
    wait: (p) => ({ seconds: 5, label: p.label || 'Wait' }),
    approval: (p) => ({ prompt: '', approval: { expiresInHours: 168 }, label: p.label || 'Approval' }),
    stop_error: (p) => ({ message: SEED.stopReason, label: p.label || 'Stop and error' }),
    return_to_app: (p) => ({ navigateTo: null, toast: null, refresh: null, onError: 'stay', label: p.label || 'Back to the app' }),
    datatable: (p) => ({ op: 'find_rows', datatableId: '', where: [], values: {}, limit: 50, label: p.label || 'Datatable' }),
    knowledge_write: (p) => ({ knowledgeBaseId: '', title: '', content: '', sourceUri: '', label: p.label || 'To knowledge base' }),
    switch: (p) => ({ expr: 'trigger.output.value', cases: [{ name: 'case1', value: '' }], defaultBranch: null, label: p.label || 'Switch' }),
    filter: (p) => ({ arrayRef: '', expr: 'true', label: p.label || ROUTE_STEP_NAME }),
    limit: (p) => ({ arrayRef: '', count: 10, mode: 'first', label: p.label || 'Limit' }),
    dedupe: (p) => ({ arrayRef: '', label: p.label || 'Remove duplicates' }),
    aggregate: (p) => ({ arrayRef: '', field: '', label: p.label || 'Aggregate' }),
    flatten: (p) => ({ arrayRef: '', keepEmpty: false, label: p.label || 'Flatten a list' }),
    summarize: (p) => ({ arrayRef: '', field: '', op: 'sum', label: p.label || 'Summarize' }),
    call_layer: (p) => ({ layerKey: p.layerKey || '', label: p.label || 'Flowlet', inputs: {} }),
    call_block: (p) => ({ blockId: p.blockId || '', label: p.label || 'Step', ...(p.icon ? { icon: p.icon } : null), inputs: {} }),
    layer_output: (p) => ({ fields: {}, label: p.label || 'Return' }),
    note: (p) => ({ text: typeof p.text === 'string' ? p.text : '', label: p.label || 'Note' }),
};

/** The defaults for a palette kind; an unknown kind gets none (just id, type, position). */
export function scaffoldFor(payload: StepPayload): Record<string, unknown> {
    const make = Object.prototype.hasOwnProperty.call(SCAFFOLDS, payload.kind) ? SCAFFOLDS[payload.kind] : undefined;
    return make ? make(payload) : {};
}

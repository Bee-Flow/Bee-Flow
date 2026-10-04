/**
 * The step picker's static items — a port of the item half of the web
 * builder's flow/stepPalette.js, icons as Lucide names. palette.lockstep.test.ts
 * loads the web module and compares every item: id, icon, label, desc,
 * keywords and payload, in order.
 *
 * A step's NAME and DESCRIPTION come from nodeDefs (translated under
 * `automations.node.*`); the picker owns only the id, icon, search keywords and
 * drop payload. The entries the web words itself — the triggers, the two form
 * pages, the Privacy Shield, "Create flowlet" — carry `labelKey`/`descKey`
 * under `mobile.flow.palette.*` with the web's English as the fallback, and
 * `localised()` translates them. KEYWORDS ARE NOT DECORATION: the ranker
 * matches on them, so every word a node used to be called stays.
 */

import { nodeDefaultLabel, nodeDesc, nodeLabel } from '../nodeDefs';
import { FORM_PAGE_NAMES, type StepPayload } from '../scaffolds';
import { ROUTE_STEP_KEYWORDS, SET_STEP_KEYWORDS } from '../stepDisplayName';
import { defaultTriggerLabel } from '../triggerLabels';
import type { PaletteItem } from './types';

const KEY = 'mobile.flow.palette';

interface Words {
    id: string;
    icon: string;
    labelFallback: string;
    descFallback: string;
    keywords: string;
    payload: StepPayload;
}

/** An entry the picker words itself: English fallbacks under `mobile.flow.palette.<id>`. */
const worded = ({ id, icon, labelFallback, descFallback, keywords, payload }: Words): PaletteItem => ({
    id, icon, label: labelFallback, desc: descFallback, keywords, payload,
    labelKey: `${KEY}.${id.replace(/^_+/, '')}`, descKey: `${KEY}.${id.replace(/^_+/, '')}_desc`,
});

const trigger = (triggerKind: string) => ({ kind: 'trigger', triggerKind, label: defaultTriggerLabel(triggerKind) });
const triggerItem = (id: string, icon: string, [labelFallback, descFallback]: [string, string], keywords: string) =>
    worded({ id, icon, labelFallback, descFallback, keywords, payload: trigger(id) });

export const TRIGGERS: readonly PaletteItem[] = [
    triggerItem('manual', 'MousePointer2', ['Trigger manually', 'Run from a button click'], 'manual click run button start'),
    triggerItem('form', 'ClipboardList', ['On form submission', 'Publish a form; every submission runs this'],
        'form submission survey intake contact request public page fields upload trigger start'),
    triggerItem('schedule', 'Clock', ['On a schedule', 'Run at a fixed time, over and over'],
        'schedule cron time recurring daily hourly weekly timer trigger start'),
    triggerItem('webhook', 'Webhook', ['On webhook call', 'Run when an HTTP request arrives'], 'webhook http post request inbound trigger start'),
    triggerItem('app_event', 'Zap', ['On app event', 'Run when something happens in a connected app'],
        'app event push email calendar drive files tickets support trigger start'),
    triggerItem('agent_call', 'Bot', ['When an agent calls it', 'Expose as a tool an AI agent can call from chat'],
        'agent chat tool function call assistant direct trigger start'),
    triggerItem('app_trigger', 'AppWindow', ['From a Studio App', 'Run when a Studio App action calls it, with typed inputs'],
        'studio app trigger form inputs file upload action start'),
];

/** The kinds `definition.triggers[]` accepts: they ADD an entry point. */
export const CAN_BE_SECONDARY: ReadonlySet<string> = new Set(['webhook', 'app_event', 'schedule']);

export const SECONDARY_TRIGGERS: readonly PaletteItem[] = TRIGGERS.filter((t) => CAN_BE_SECONDARY.has(t.payload.triggerKind as string)).map(
    (t) => ({ ...t, payload: { ...t.payload, asSecondaryTrigger: true } }),
);

/** The triggers as offered beside the steps once an automation has one: add, or replace (and say so). */
export function additionalTriggerItems(): PaletteItem[] {
    return TRIGGERS.map((t) =>
        CAN_BE_SECONDARY.has(t.payload.triggerKind as string)
            ? {
                ...t, desc: 'Adds another way to start this automation', descKey: `${KEY}.trigger_adds_desc`,
                payload: { ...t.payload, asSecondaryTrigger: true },
            }
            : { ...t, desc: 'Replaces the current trigger', descKey: `${KEY}.trigger_replaces_desc` },
    );
}

const stepItem = (kind: string, id: string, icon: string, keywords: string): PaletteItem => ({
    id, icon, keywords,
    label: nodeLabel(kind), desc: nodeDesc(kind),
    payload: { kind, label: nodeDefaultLabel(kind) },
});

export const AI_STEP = stepItem('ai_step', 'ai_step', 'Sparkles', 'ai prompt llm claude reason');
export const DATA_EXTRACTION = stepItem(
    'data_extraction', 'data_extraction', 'ScanText',
    'extract extraction data fields structured parse read pull invoice receipt email e-mail pdf document text ocr '
    + 'amount date total name number scan capture json schema',
);
export const AI_ITEMS: readonly PaletteItem[] = [AI_STEP, DATA_EXTRACTION];

export const EDIT_DATA_ITEM = stepItem('set', 'set', 'Pencil', SET_STEP_KEYWORDS);

export const DATA_ITEMS: readonly PaletteItem[] = [
    stepItem('datatable', 'datatable', 'Table2',
        'datatable data table database store save keep remember persist rows records sheet spreadsheet excel list log append lookup find read write history state memory register ledger crm between runs across runs shared'),
    stepItem('knowledge_write', 'knowledge_write', 'BookOpen',
        'knowledge base kb write save store add article document ingest publish knowledgebase agent answer from search rag ground grounding faq wiki handbook remember teach train article writer feed'),
    EDIT_DATA_ITEM,
    stepItem('datetime', 'datetime', 'Clock', 'date time datetime format parse add days hours minutes diff extract today now'),
    stepItem('generate_document', 'generate_document', 'FileText',
        'document pdf word docx file generate make create render export offer quote report letter invoice download attachment print'),
    stepItem('fill_document', 'fill_document', 'FileSignature',
        'document fill template invoice factuur quote offerte letter brief letterhead briefpapier pdf merge placeholder design studio print send'),
    stepItem('slide', 'slide', 'RectangleHorizontal', 'slide dia page presentation powerpoint pptx deck bullet bullets title notes speaker'),
    stepItem('presentation', 'presentation', 'Presentation',
        'presentation presentatie powerpoint pptx deck slides slide pitch keynote impress export download house style huisstijl'),
];

export const COLLECTION_ITEMS: readonly PaletteItem[] = [
    stepItem('limit', 'limit', 'ChevronsDown', 'limit take first last slice top head tail trim shorten cap fewer'),
    stepItem('dedupe', 'dedupe', 'Copy', 'dedupe duplicates unique distinct same repeated identical once'),
    stepItem('aggregate', 'aggregate', 'Layers', 'aggregate collect pluck pick field values flatten column extract list of'),
    stepItem('summarize', 'summarize', 'Sigma', 'summarize summarise sum count avg average min max statistics aggregate total add up how many'),
];

/** ONE deciding node (If / Switch / Filter); its runtime type follows its rules. */
export const ROUTE_ITEM = stepItem('condition', 'route', 'Split', ROUTE_STEP_KEYWORDS);

/** ONE Privacy Shield entry; the drop seeds the CHECK mode, the only one that changes no data. */
export const PRIVACY_SHIELD_ITEM: PaletteItem = worded({
    id: 'privacy_shield', icon: 'ShieldAlert',
    labelFallback: 'Privacy Shield',
    descFallback: 'Check for personal data, hide it, or show the real values again',
    keywords: 'guard pii privacy personal data find personal data gdpr avg bsn shield detect scan check find sensitive redact mask compliance '
        + 'tokenize tokenise hide anonymise anonymize pseudonymise placeholder protect before ai '
        + 'untokenize detokenize restore reveal real values unmask unhide back original decode',
    payload: { kind: 'guard', label: nodeDefaultLabel('guard') },
});

export const NOTE_ITEM = stepItem('note', 'note', 'StickyNote',
    'note sticky note annotation comment memo remark todo explain documentation label text why context');

export const FLOW_CONTROL_ITEMS: readonly PaletteItem[] = [
    ROUTE_ITEM,
    stepItem('loop', 'loop', 'Repeat', 'loop foreach iterate array items repeat each every for'),
    PRIVACY_SHIELD_ITEM,
    stepItem('stop_error', 'stop_error', 'OctagonX', 'stop error throw halt fail abort guardrail end'),
    stepItem('return_to_app', 'return_to_app', 'AppWindow', 'app studio return back finish screen navigate toast refresh button end done'),
    NOTE_ITEM,
];

/** "People & waiting": every step that suspends the run for a person or a clock. */
export const PEOPLE_ITEMS: readonly PaletteItem[] = [
    worded({
        id: 'form_page', icon: 'ClipboardList',
        labelFallback: 'Form: ask for more info',
        descFallback: 'Pause the run and show another form page on the same link',
        keywords: 'form page ask question extra input wait visitor multi step second page human in the loop',
        payload: { kind: 'form_page', mode: 'input', label: FORM_PAGE_NAMES.input },
    }),
    worded({
        id: 'form_ending', icon: 'CheckCircle2',
        labelFallback: 'Form: closing page',
        descFallback: 'Close the form with a message about what happened',
        keywords: 'form ending summary thanks closing final page result confirmation',
        payload: { kind: 'form_page', mode: 'ending', label: FORM_PAGE_NAMES.ending },
    }),
    stepItem('approval', 'approval', 'ShieldCheck',
        'approval approve reject review sign off sign-off signoff authorise authorize permission gate '
        + 'human in the loop wait for a person decision decide ok confirm check by hand manager'),
    stepItem('wait', 'wait', 'Hourglass', 'wait sleep delay pause timer hold minutes hours'),
    stepItem('notification', 'notification', 'Bell', 'notification notify alert message email tell me'),
];

export const LOGIC_ITEMS: readonly PaletteItem[] = [...FLOW_CONTROL_ITEMS, ...PEOPLE_ITEMS];

export const INTEGRATION_ITEMS: readonly PaletteItem[] = [
    stepItem('http_request', 'http_request', 'Globe',
        'http request webhook api call rest fetch get post put patch delete url endpoint web service'),
];

export const CODE_ITEM = stepItem('code', 'code', 'Code', 'code javascript js script custom');

export const CREATE_LAYER_ITEM: PaletteItem = worded({
    id: '__create_layer', icon: 'Layers',
    labelFallback: 'Create flowlet', descFallback: 'Group steps into a reusable sub-flow',
    keywords: 'flowlet create new subflow sub-automation group reusable', payload: { kind: 'create_layer' },
});

export const LAYER_OUTPUT_ITEM = stepItem('layer_output', '__layer_output', 'LogOut', 'flowlet output return result respond finish end');

/** Every static item, for suggestion lookups. */
export const ALL_STATIC_ITEMS: readonly PaletteItem[] = [
    ...AI_ITEMS, ...DATA_ITEMS, ...COLLECTION_ITEMS, ...LOGIC_ITEMS, ...INTEGRATION_ITEMS, CODE_ITEM,
];

/** Every Lucide name the picker can ask for — for the icon registry. */
export const PALETTE_ICON_NAMES: readonly string[] = [
    ...new Set([...TRIGGERS, ...ALL_STATIC_ITEMS, PRIVACY_SHIELD_ITEM, CREATE_LAYER_ITEM, LAYER_OUTPUT_ITEM].map((i) => i.icon).concat(['Box'])),
].sort();

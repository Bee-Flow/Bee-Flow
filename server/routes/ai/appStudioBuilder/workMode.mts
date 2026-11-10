/**
 * App Studio Builder — the assistant work modes (request field `workMode`).
 *
 * A port of the minimal part of the automation builder's work modes
 * (routes/ai/automationBuilder/workMode.js, modeRules.mts): the question card
 * (app_ask_questions), the per-mode rules, the note that tells the model what
 * became of its last questions, and the discuss-mode gate. No preview/apply
 * proposals, no handover, no datatable questions, no 'approve' mode.
 *
 * Without `workMode` nothing here runs: no tool is offered and no note is added.
 *
 * PROMPT-CACHE DISCIPLINE. The system prompt and the tools array are part of
 * the cached prefix, so a mode never changes them. app_ask_questions is
 * offered in EVERY work mode (one tools array for all four, so switching mode
 * between turns keeps the cache), the mode's directive travels as a machine
 * note in the user message (turnNotes.renderWorkModeNote), and discuss is
 * enforced by REFUSING a call with a clear tool error (gateWorkModeCall), not
 * by removing tools.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);
const { parseAnswersText } = nodeRequire('../../../automation/builderTools/questionAnswers.js') as {
    parseAnswersText: (content: unknown) => { prompt: string; answer: string }[] | null;
};

export const WORK_MODES = ['describe', 'discuss', 'plan', 'build'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export type ReviewQuestion = { id: string; prompt: string; options: string[]; header?: string };
type PriorQuestion = { prompt?: unknown; options?: unknown };

export const MAX_QUESTIONS = 6;
export const MAX_OPTIONS = 4;
export const DESCRIBE_QUESTIONS = 4;

// ── Rules ────────────────────────────────────────────────────────────

// The tool draws a card. A model that also writes the questions in its message
// shows them twice. Said here and in the tool description: a small model reads
// one of the two at best.
export const QUESTIONS_RULE = 'When you call app_ask_questions, do NOT write the questions or their options in your message: the chat shows them as a card. '
    + 'Say at most one short sentence before the call. Keep each question to one short sentence and each option to a few words; no lists or headings inside them, inline markdown (bold, code) only. '
    + 'Before calling app_ask_questions, collect EVERY open question and ask them in that one call. Do not ask what you can read from the draft, the catalog or the documents.';

// A plan written from a thin brief is a guess the user then corrects line by line.
export const ASK_FIRST_RULE = 'On a NEW app (the draft has no real screens or components yet) your first call is app_ask_questions, unless the request already says who uses the app, what data it holds and what people do with it. '
    + 'Ask only about what is missing, each question with 2-4 suggested answers, the most likely first.';

// Build it right away must not stall on a question round.
export const ONE_QUESTION_RULE = 'Ask at most ONE question with app_ask_questions, and only when nothing can be built without its answer; otherwise build on the most likely reading and say what you assumed.';

export const DESCRIBE_RULE = 'DESCRIBE IT: the person describes in their own words what the app should do and has no technical background. '
    + `Ask at most ${DESCRIBE_QUESTIONS} questions. Talk in their language and in everyday words, in your messages and in the plan alike: no ids, tool names, component type names, bindings, field keys or JSON.`;

const DISCUSS_RULE = 'DISCUSS ONLY (just advise). Explain, advise and answer. You may read the draft, the data and the catalog, but the app must stay unchanged: every tool that changes something, proposes a plan or finalizes is refused in this mode. '
    + 'When a change is needed, describe it as a suggestion, say clearly that nothing was changed, and tell the user to switch to a mode that builds. Never say a change is ready, done or applied.';

const modeLimit = (mode: WorkMode): number => (mode === 'describe' ? DESCRIBE_QUESTIONS : mode === 'plan' ? MAX_QUESTIONS : mode === 'build' ? 1 : 0);

/**
 * How many questions one app_ask_questions call may show: 0 when the tool is
 * refused (discuss, or an approved plan is being built), 1 in build, 4 in
 * describe, 6 in plan.
 */
export function questionLimit(mode: WorkMode, approved: boolean): number {
    return approved ? 0 : modeLimit(mode);
}

/** Does this mode ask first and propose a plan before it builds? */
export const asksFirst = (mode: unknown): boolean => mode === 'plan' || mode === 'describe';

export type DirectiveInput = {
    mode: WorkMode;
    /** An approved plan is being built (an approval turn, or a later turn of that build). */
    approved: boolean;
    /** The draft has no real screens or components yet. */
    fresh: boolean;
    /** The question round of this plan is spent. */
    closed: boolean;
};

/** The body of the WORK MODE machine note (turnNotes stamps the prefix). */
export function workModeDirective({ mode, approved, fresh, closed }: DirectiveInput): string {
    const everyday = mode === 'describe' ? ` ${DESCRIBE_RULE}` : '';
    // Discuss first: its gate refuses every write, so "build the approved plan" would contradict it.
    if (mode === 'discuss') return DISCUSS_RULE;
    if (approved) return `The approved plan is being built: build it, do not ask questions.${everyday}`;
    if (asksFirst(mode)) {
        const limit = questionLimit(mode, false);
        const ask = closed
            ? 'Your question round for this plan is spent. Do not ask again: call app_propose_plan now and list what is still open as assumptions in the plan summary.'
            : `${fresh ? `${ASK_FIRST_RULE} ` : ''}If something essential is unclear, ask ALL your questions in ONE app_ask_questions call (at most ${limit}); you get one question round for this plan. Otherwise go straight to app_propose_plan. ${QUESTIONS_RULE}`;
        return `${mode === 'describe' ? 'DESCRIBE IT, plan first' : 'PLAN FIRST'}. Nothing is built in this turn: read the draft and the catalog if needed, then end the turn with exactly one of app_ask_questions or app_propose_plan. ${ask}${everyday}`;
    }
    return closed
        ? 'BUILD. Your question for this plan is spent: build on the most likely reading and say what you assumed.'
        : `BUILD. ${ONE_QUESTION_RULE}`;
}

// ── The tool ─────────────────────────────────────────────────────────

export const ASK_QUESTIONS_TOOL = {
    type: 'function',
    function: {
        name: 'app_ask_questions',
        description: `Ask ALL open questions for this plan in ONE call (at most ${MAX_QUESTIONS}, usually 2-4), each with 2-4 suggested answers. You get one question round per plan. Put the recommended answer first and do not write '(recommended)' in it: the card marks it. Ends the turn and waits for the user. The chat shows the questions as a card, so do NOT repeat them in your message: say at most one short sentence before this call. Each prompt is one short sentence, each option a few words, no lists inside them.`,
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['questions'],
            properties: {
                questions: {
                    type: 'array',
                    maxItems: MAX_QUESTIONS,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['prompt', 'options'],
                        properties: {
                            prompt: { type: 'string' },
                            options: { type: 'array', minItems: 2, maxItems: MAX_OPTIONS, items: { type: 'string' } },
                            header: { type: 'string', description: 'A label of at most three words for this question, shown above it in the card.' },
                        },
                    },
                },
            },
        },
    },
} as const;

// A numbered or bulleted prefix would show twice: the card draws its own numbers.
const LIST_MARKER = /^\s*(?:(?:\d{1,3}[.)]|[-*•])\s+)+/;
// A model marks its own favourite ("Finance (recommended)"); the card does that from the order.
const RECOMMENDED_SUFFIX = /\s*\((?:recommended|suggested|aanbevolen|voorgesteld)\)\s*$/i;

function stripListMarker(line: string): string {
    const stripped = line.replace(LIST_MARKER, '').trim();
    return stripped || line.trim();
}

const cleanOption = (option: string): string => stripListMarker(option.replace(RECOMMENDED_SUFFIX, '')).slice(0, 300);

/**
 * The questions of one app_ask_questions call, as the card gets them. Tolerant
 * on purpose: a call with one bad question, a seventh question or a fifth
 * answer would cost the one round the plan gets if it were rejected whole.
 * Unusable questions are dropped, the rest is cut to the limits. Returns
 * { questions, dropped } (dropped = valid questions cut past `max`), or null
 * when none is usable.
 */
export function writeQuestions(args: unknown, max: number = MAX_QUESTIONS): { questions: ReviewQuestion[]; dropped: number } | null {
    const raw = (args as { questions?: unknown } | null | undefined)?.questions;
    if (!Array.isArray(raw)) return null;
    const seen = new Set<string>();
    const valid: ReviewQuestion[] = [];
    for (const q of raw as Array<Record<string, unknown> | null>) {
        if (!q || typeof q.prompt !== 'string' || !q.prompt.trim()) continue;
        const prompt = stripListMarker(q.prompt).slice(0, 1000);
        const key = prompt.toLowerCase();
        if (seen.has(key)) continue;
        const options = (Array.isArray(q.options) ? q.options : [])
            .filter((o): o is string => typeof o === 'string').map(cleanOption).filter(Boolean).slice(0, MAX_OPTIONS);
        if (options.length < 2) continue;
        seen.add(key);
        const header = typeof q.header === 'string' ? q.header.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
        valid.push({ id: randomUUID(), prompt, options, ...(header ? { header } : {}) });
    }
    if (!valid.length) return null;
    const limit = Math.max(1, Math.min(MAX_QUESTIONS, max));
    return { questions: valid.slice(0, limit), dropped: Math.max(0, valid.length - limit) };
}

export type AskInput = { mode: WorkMode; approved: boolean; closed: boolean };
export type AskOutcome = { error: string } | { questions: ReviewQuestion[]; result: Record<string, unknown> };

/** One app_ask_questions call: the refusal, or the questions to show plus the model-facing result. */
export function askQuestions(args: unknown, { mode, approved, closed }: AskInput): AskOutcome {
    if (mode === 'discuss') return { error: DISCUSS_REFUSAL };
    if (approved) return { error: 'The plan is approved: build it. Do not ask questions; build on the most likely reading and say what you assumed.' };
    if (closed) {
        return { error: asksFirst(mode)
            ? 'You already asked your questions for this plan and the user answered. Do not ask again: call app_propose_plan now and list what is still open as assumptions in the plan summary.'
            : 'You already asked your question for this plan. Do not ask again: build on the most likely reading and say what you assumed.' };
    }
    const limit = questionLimit(mode, approved);
    const written = writeQuestions(args, limit);
    if (!written) return { error: `Provide 1-${limit} questions, each with 2-4 short answers.` };
    return {
        questions: written.questions,
        result: { ok: true, awaitingAnswers: true, ...(written.dropped ? { _note: `${written.dropped} question(s) were not shown (limit ${limit}). Put what they would have settled under assumptions.` } : {}) },
    };
}

// ── Discuss: fail closed ─────────────────────────────────────────────

const DISCUSS_REFUSAL = 'Discuss mode (just advise): the app stays unchanged, so this tool is not available. Answer in text; describe any change as a suggestion and say that nothing was changed.';

// Everything discuss may call: tools that only read. An ALLOW-list: a tool that
// is not named here (a new one, an unknown name) is refused.
export const DISCUSS_READ_TOOLS: ReadonlySet<string> = new Set([
    'app_get_draft', 'app_get_node', 'app_get_action', 'app_find_nodes', 'app_inspect_catalog',
    'app_get_data_model', 'app_query_data', 'app_list_connectors', 'app_list_documents', 'app_list_assets',
    'app_search_documents', 'app_read_document', 'app_list_automations', 'app_inspect_automation',
    'app_list_templates', 'app_dry_run', 'app_screenshot',
]);

/** The refusal for a tool call in `mode`, or null when the call may run. */
export function gateWorkModeCall(name: string, mode: WorkMode): string | null {
    if (mode !== 'discuss') return null;
    return DISCUSS_READ_TOOLS.has(name) ? null : DISCUSS_REFUSAL;
}

// ── The next turn ────────────────────────────────────────────────────

const oneLine = (t: unknown): string => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * What the model is told about the question card it showed on its last turn.
 * `prior` is the questions as saved in the snapshot, `answeredText` the user's
 * message. Answered = the message is the card's "Q: ...\nA: ..." text for at
 * least one of them. Typed instead = anything else: the user ignored the card,
 * so the model takes its own suggestion for what the message does not settle.
 * '' when no questions were open.
 */
export function questionStatusNote({ prior, answeredText, mode, approved }: {
    prior: unknown; answeredText: unknown; mode: WorkMode; approved: boolean;
}): string {
    const asked = (Array.isArray(prior) ? prior : []).filter((q): q is PriorQuestion & { prompt: string } => !!q && typeof q.prompt === 'string');
    if (!asked.length) return '';
    const known = new Set(asked.map((q) => oneLine(q.prompt)));
    const parsed = parseAnswersText(answeredText);
    const matched = parsed ? parsed.filter((p) => known.has(oneLine(p.prompt))).length : 0;
    if (matched > 0) {
        const head = `The user answered the ${matched} question${matched === 1 ? '' : 's'} you asked (Q/A in their message). Do not ask them again.`;
        if (approved) return `${head} Continue with the approved plan.`;
        return asksFirst(mode) ? `${head} Call app_propose_plan now; put anything still open under assumptions in the plan summary.` : head;
    }
    const list = asked.map((q, i) => `${i + 1}) ${q.prompt}${Array.isArray(q.options) && q.options.length ? ` (suggested: ${String(q.options[0])})` : ''}`).join(' ');
    return `Your last turn asked: ${list}. The user wrote a message instead of using the card. Use it; for every question it does not settle, take the suggested answer and list it as an assumption. Do not ask these again.`;
}

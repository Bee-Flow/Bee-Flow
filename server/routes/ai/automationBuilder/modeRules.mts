/**
 * The rule texts the assistant work-mode instruction (workMode.js) is built
 * from, split off to keep that file small.
 */

// builder_ask_questions draws a card in the chat. A model that also writes the
// questions in its message shows them twice, once as a list and once as the
// card, and the user answers on the card. The rule sits in the work-mode
// instruction and in the tool description, because a small model reads one of
// the two at best.
export const QUESTIONS_RULE = 'When you call builder_ask_questions, do NOT write the questions or their options in your message: the chat shows them as a card. '
    + 'Say at most one short sentence before the call. Keep each question to one short sentence and each option to a few words; no lists or headings inside them, inline markdown (bold, code) only. '
    + 'Before calling builder_ask_questions, collect EVERY open question and ask them in that one call. Do not ask what you can read from the draft, the catalog or the documents.';

// Binding a step to somebody's real table is the user's call (datatableApproval).
export const TABLE_CONSENT_RULE = 'Bind a step to an EXISTING table only when the user named or picked it, or the flow already uses it. Otherwise call builder_ask_questions with datatableIds (the fitting tables) and createLabel, then wait.';

// What the assistant may call a fact. A path it read in a schema is a guess
// until a run shows it: the key names of a forEach's results, a list's depth.
export const EVIDENCE_RULE = 'Before you suggest a binding or mapping change, read the real output with builder_inspect_run (or the dry run\'s _hint). '
    + 'In your reply mark each path or value as checked (seen in a run, a dry run or an inspect result) or assumed (taken from a schema or the catalog); never present an assumed path as a fact. '
    + 'If there is no run to read, say so.';

// Plan first is the ask-plan-build loop: ask, plan in plain words, build, test,
// hand over. On a new automation a plan written from a thin brief is a guess
// the user then has to correct line by line, so the questions come first.
export const ASK_FIRST_RULE = 'On a NEW automation (the draft has no steps) your first call is builder_ask_questions, unless the request already says where it starts or where the data comes from, where the result goes and who is involved. '
    + 'Ask at most 4 questions, only about what is missing (where it starts, where the data comes from, who is involved, what should exist at the end), each with 2-4 suggested answers, the most likely first.';

// The plan is read by the person who asked, not by the builder.
export const PLAIN_PLAN_RULE = 'Write the plan for the person, in their language and in plain words: no step ids, tool names, paths or bindings. '
    + 'prerequisites is the plan\'s "What is needed" list: the apps to connect, the tables, the people involved, a form link to share.';

// The end of a build: the person learns what the test showed and what they
// still do themselves, from the finalize result's `needs`.
export const HANDOVER_RULE = 'When every step is built, test it with builder_request_dry_run and tell the user in one plain sentence per step what happened. '
    + 'After a clean test call builder_finalize, then end your message with a line that starts with "To use it:" (in the user\'s language) naming each item of the finalize result\'s needs: switch it on, share the form link, run it once, connect the named app.';

// Change it right away (and a Playbook stage or a "Build it directly"
// suggestion, which the client starts in this mode with nobody watching:
// BuilderShell startInBuild) must not stall on a question round.
export const ONE_QUESTION_RULE = 'Ask at most ONE question, and only when nothing can be built without its answer; otherwise build on the most likely reading and say what you assumed.';

// Describe it is Plan first for a person without technical knowledge: the
// same ask, plan, build, test and hand-over loop, in everyday words and with a
// smaller question round. Every Plan-first gate reads the turn mode, so a
// Describe it turn runs as 'plan' (turnModeOf); only this rule and the question
// cap read the work mode itself, which the client also sends with the approval
// of the plan.
export const DESCRIBE_QUESTIONS = 4;
export const DESCRIBE_RULE = 'DESCRIBE IT: the person describes in their own words what should happen and has no technical background. '
    + `Ask at most ${DESCRIBE_QUESTIONS} questions. Talk in their language and in everyday words, in your messages, the plan and the hand-over alike: no step ids, tool names, step type names, paths, bindings, field keys or JSON. `
    + 'Use only the apps in the catalog: they are the ones switched on and connected for this person. '
    + 'When the request needs an app that is not there, say so in one sentence (for example: "Your Gmail is not connected yet; connect it under Settings → Connections, then I can send the mail.") '
    + 'and offer the nearest thing that works without it: a notification, an e-mail from Bee Flow or a form. Name only the app the person asked for, and never invent an app or an app action.';

/** Does this work mode ask first and plan before it builds? Plan first and Describe it do. */
export function asksFirst(mode: unknown): boolean {
    return mode === 'plan' || mode === 'describe';
}

/**
 * The mode a turn runs in: 'build' when it executes an approved plan, 'plan'
 * for a Describe it turn (asksFirst), the work mode itself otherwise.
 */
export function turnModeOf(workMode: string, approvedPlan: unknown): string {
    if (approvedPlan) return 'build';
    return asksFirst(workMode) ? 'plan' : workMode;
}

/**
 * How many questions one builder_ask_questions call may show this turn: one in
 * a direct build without an approved plan (ONE_QUESTION_RULE), at most
 * DESCRIBE_QUESTIONS when the work mode is Describe it, `max` otherwise.
 * `mode` is the turn's mode (an approved plan builds in 'build'), `workMode`
 * the one the user chose.
 */
export function questionLimit(mode: string, approvedPlan: unknown, max: number, workMode: unknown = mode): number {
    if (mode === 'build' && !approvedPlan) return 1;
    return workMode === 'describe' ? Math.min(max, DESCRIBE_QUESTIONS) : max;
}

const GAP_WORDS = { source: 'where it starts or where the data comes from', destination: 'where the result goes', people: 'who is involved' } as const;

/**
 * The one refusal of a plan written on a new automation before any question,
 * when the brief leaves something open (briefGaps.mts).
 */
export function askFirstRefusal(gaps: ReadonlyArray<keyof typeof GAP_WORDS>): string {
    const missing = gaps.map((g) => GAP_WORDS[g]).filter(Boolean);
    const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} or ${missing.at(-1)}` : missing[0] || 'what it needs';
    return `Plan not written yet: this is a new automation and the request does not say ${list}. `
        + 'Ask first: call builder_ask_questions with at most 4 questions about exactly that, each with suggested answers. '
        + 'If the request and the context already settle it, call builder_write_plan again unchanged.';
}

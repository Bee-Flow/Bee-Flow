import type { IntentResult, IntentField } from './routeIntents.types';
import type { planRouteHandoff, PlacedStep } from './routeHandoff';
import type { SuggestedRule, RouteConfig } from './routeTypes';
import type { TopicsCapability } from '../../mapping/TopicNotice';
import type { Dispatch, SetStateAction, MouseEventHandler } from 'react';

/**
 * "Suggest outputs" — describe the outputs in words, read them back as
 * sentences, and only then accept them.
 *
 * The Condition node cannot be told what you want. Its predicate is a
 * restricted-grammar expression, so "split these files by pdf, word and
 * powerpoint" is five comparisons across three outputs, all of which hinge on
 * an "ends with" operator that sits eight items down an operator menu and that
 * beginners never find. They pick "equals", type `.pdf`, and get an output
 * that matches nothing — silently, because an empty branch is a legal result.
 * This box is the way in for that author.
 *
 * Three things it deliberately is NOT:
 *
 *  - It does not START with a model call. settings/routeIntents.js answers
 *    the common cases offline, so the box works on a self-hosted box with no
 *    LLM configured, costs nothing, cannot drift, and can be pinned by tests.
 *    A model is the FALLBACK, behind an explicit click, for the sentences the
 *    catalogue did not understand — and what it gets is the FIELD NAMES,
 *    never a row and never a sample value. A Condition node in this product
 *    routinely sits over customer records, and personal data does not leave
 *    Bee Flow (CLAUDE.md, BFSF-441). The payload is built here from an
 *    explicit allow-list of three keys rather than by handing over the
 *    editor's own field options, which carry a `sample` value each.
 *    Every expression that comes back is parsed server-side with the
 *    runner's own grammar and dropped unless every path it names was
 *    declared — a model answering `item.customer.email` because the sentence
 *    said "customer" would otherwise re-create, through the fallback, the
 *    silent empty branch this whole feature exists to remove.
 *  - It is not a second "how many outputs" question. The node already asks
 *    that ("One output" / "Several outputs"); accepting a suggestion PRE-FILLS
 *    that chooser through the same route model, so a single suggested rule
 *    still saves as a `filter` and several still save as a `switch`
 *    (flow/routeModel.js, writeRoute).
 *  - It is not a preview of code. Every rule is read back through
 *    `ruleSentence` — the canvas's own describer — so what the author checks
 *    is "any attachment · File type is PDF", never the expression, and a rule
 *    it cannot describe reads "a custom rule". The expression stays where
 *    every other generated expression lives: under Advanced.
 *
 * The match count is the honest part. It is evaluated with the same engine
 * the server runs, against whatever sample rows the editor already has — and
 * when there are none it SAYS there are none. A preview that answers "1 of 1
 * matched" because it invented a row is worse than one that answers nothing:
 * it is the reassurance an author would act on. It is counted the same way
 * for a model suggestion, IN THE BROWSER, against rows the model was never
 * shown: so the number beside an AI-written rule is evidence about the real
 * data rather than a claim the model made about itself.
 */
/**
 * The sentence, what it produced, and where that came from.
 *
 * OFFLINE FIRST IS A RULE, not an ordering accident: a catalogue hit is never
 * replaced by a model's opinion of the same sentence. The catalogue answer is
 * fixed, free, works with no model configured, and is pinned by tests; the
 * model's is none of those. So the model is consulted only for a sentence the
 * catalogue could not answer, only when the author clicks, and its answer is
 * dropped the moment the sentence changes — leaving an answer to the OLD
 * sentence on screen is how someone accepts rules for a question they have
 * already changed their mind about.
 */
/** What the box shows: the offline catalogue's answer, or the model's (which names no field). */
export type Suggestion = Pick<IntentResult, 'rules' | 'problem' | 'understood'> & Partial<IntentResult>;

/** What planRouteHandoff answers: a plan with a step, or a refusal with a `problem`. */
export type HandoffPlan = ReturnType<typeof planRouteHandoff>;

export type HandoffPlanWithStep = Extract<HandoffPlan, { step: object }>;

export interface UseRouteSuggestionArgs {
    fields: IntentField[];
    sampleRows: unknown[] | null;
    element?: unknown;
    itemVar: string;
    unit: string;
    perItem?: boolean;
    topics: boolean;
}

/**
 * The handoff, as a decision and a plan: is it on the table, what would be
 * inserted, and what accepting it does.
 *
 * It is OFFERED only after the MODEL has answered and answered with a
 * `problem`. That is the one state meaning "no field here can answer this",
 * and it is the only state where adding a step is the right next move. The
 * offline catalogue's own problem sentences are about something else
 * entirely ("dates have to be written in full", "say which field holds the
 * number") — offering to insert a step there would answer a question the
 * author did not ask, and bury the one-word fix that actually applies.
 *
 * ACCEPTING puts the step in first and the rules second, and that order is
 * the whole safety of it: the rules name the step's id, so writing them
 * before the step exists would leave the node pointing at nothing for as long
 * as the insert takes — and, if the shell refuses, for good. A refusal
 * therefore changes nothing at all, which is the promise the rest of this box
 * makes too.
 */
export interface UseRouteHandoffArgs {
    text: string;
    answers: string;
    suggestion: Suggestion;
    fromAi: boolean;
    itemVar: string;
    perItem: boolean;
    sourceRef?: string;
    wiredOutputNames: string[];
    onInsertUpstreamStep?: InsertUpstreamStep | null;
    onApplyHandoff?: ((plan: { rules: SuggestedRule[]; source?: string | null }) => void) | null;
}

/** The shell's insert: put a step before this node; `false` means it refused. */
export type InsertUpstreamStep = (step: PlacedStep) => boolean | void;

export interface RouteAssistProps {
    fields?: IntentField[];
    sampleRows?: unknown[] | null;
    sampleRoot?: unknown;
    onInsertUpstreamStep?: InsertUpstreamStep | null;
    topics?: TopicsCapability | null;
    itemSample?: unknown;
    itemVar?: string;
    unit?: string;
    perItem: boolean;
    existingRuleCount?: number;
    wiredOutputNames?: string[];
    onApply: (suggested: SuggestedRule[], extra?: RouteConfig | null) => void;
    sourceRef: string;
    onApplyHandoff: (plan: { rules: SuggestedRule[]; source?: string | null; }) => void;
    onWorkThroughList: ((next: string) => void) | null;
    fanOut: boolean;
    keepRest: boolean;
}

/**
 * The model, offered only where the offline catalogue ran out.
 *
 * Beside the box from the start it would make every sentence a paid
 * round-trip and would make the "nothing leaves this page" line above false
 * for the cases that never needed it. It is a BUTTON and not an automatic
 * retry for the same reason: a request that leaves this page is the author's
 * to make.
 *
 * A box with no model behind it is the NORMAL state on a self-hosted install,
 * which is what this product is, so a refusal is said plainly rather than
 * hidden — the offline half of the feature still works and the author needs
 * to know that is what they are getting.
 */
export interface AskAiRowProps {
    offered: boolean;
    asking: boolean;
    error: string;
    onAsk: () => Promise<void>;
}

/**
 * The follow-up offer: if no field can answer the question, MAKE one.
 *
 * This is where "Suggest outputs" runs out of road honestly. A Condition's
 * predicate compares fields that already exist, so "is this e-mail about a
 * complaint?" has nothing to compare — and the model fallback says so rather
 * than inventing a path, because a rule over a field that does not exist
 * parses, matches nothing forever, and reports no error (routeRules.js,
 * verifyRouteRules). That refusal is correct. What was missing was the next
 * move: one AI step in front of the node answers the question in a single
 * word, declares that word as a field, and the outputs compare against it.
 *
 * IT IS THE ONLY THING IN THIS BOX THAT ADDS A STEP, and it says so in those
 * words, twice — in the explanation and again on the button. Everything else
 * here rewrites the outputs of the node the author already has open; this
 * changes the shape of their automation, and an author who reads "use these 3
 * outputs" and gets a new node on the canvas has been surprised by their own
 * click. It is also why the whole plan — the step's label, what it will be
 * asked, and every rule read back as a sentence — is on screen BEFORE the
 * button exists, and why a plan that cannot be made comes back as a sentence
 * instead of a disabled button with no reason attached.
 *
 * The answers are TYPED, not guessed from the sentence. "Is this about a
 * complaint" could be yes/no, or complaint/question/other, or one of six
 * queues, and a box that picks for you gets the ports wrong in a way nobody
 * notices until records land in the wrong one. Asking costs one line.
 */
export interface HandoffOfferProps {
    plan: HandoffPlan | null;
    offered?: boolean;
    answers: string;
    onAnswers: Dispatch<SetStateAction<string>>;
    named?: string[];
    perItem: boolean;
    unit: string;
    existingRuleCount?: number;
    losingWires?: string[];
    onAccept: () => void;
}

/**
 * What accepting would do, stated before there is anything to click.
 *
 * Read in the order it is written: the step, then every output as a sentence,
 * then what CANNOT be checked here, then what the accept costs on the canvas,
 * and only then the button. The suggestion preview above this makes the same
 * promises in the same order; the two extra lines are the two things that are
 * true only of a handoff — that a step is being added, and that no count
 * exists yet to reassure anyone with.
 */
export interface HandoffPlanPreviewProps {
    plan: HandoffPlanWithStep;
    named: string[];
    perItem: boolean;
    unit: string;
    existingRuleCount: number;
    losingWires: string[];
    onAccept: MouseEventHandler<HTMLButtonElement>;
}

/**
 * The preview: named outputs, each read back as a sentence, with what the
 * sample rows say about it — and an accept button that is the first thing in
 * this box to change anything at all.
 */
export interface SuggestionPreviewProps {
    suggestion: Suggestion;
    fromAi?: boolean;
    counts: { total: number; perRule: { name: string | undefined; matched: number; failed: number; }[]; unmatched: number; } | null;
    unit: string;
    keepRest?: boolean;
    existingRuleCount: number;
    losingWires?: string[];
    onApply: MouseEventHandler<HTMLButtonElement>;
    onReset: () => void;
    topic: { needed: boolean; loading: boolean; error: string; checkedRows: number | null; totalRows: number; check: () => Promise<void>; };
}

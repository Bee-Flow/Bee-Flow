import { singularKey } from '@shared/expr/rules.mjs';
import { Lightbulb, Loader2, Plus, Sparkles } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { cardClass, rowInputClass } from './formPrimitives';
import {
    FilesInsideNote, PRIMARY_BUTTON_CLASS, SuggestProblem, UnmatchedLine, useRuleLine,
} from './RouteAssistParts';
import { parseCategories, planRouteHandoff } from './routeHandoff';
import { suggestOutputs } from './routeIntents';
import { askFailureMessage, askModelForRules } from './routeRulesRequest';
import TopicCheckRow from './TopicCheckRow';
import useTopicPreview from './useTopicPreview';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../../hooks/useTranslation';

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
function useRouteSuggestion({ fields, itemVar, sampleRows, unit, perItem: perItemProp, topics, element }) {
    const api = useAutomationApi();
    // Does this node decide about the whole run, or about one row at a time?
    // It follows from what the editor handed down rather than being asked
    // again, and both the model request and the handoff plan below hinge on
    // it, so it is derived once here.
    // An explicit `perItem` wins: `unit` is the list's own word ("messages").
    const perItem = perItemProp ?? (!!sampleRows || unit === 'items');
    const [text, setText] = useState('');
    const [ai, setAi] = useState(null);        // { rules, problem } once asked
    const [asking, setAsking] = useState(false);
    const [askError, setAskError] = useState('');
    // The answers the author names for the handoff below. It lives here, next
    // to the sentence it belongs to, so `retype` can throw it away with
    // everything else: "complaint, question, other" is an answer to ONE
    // question, and leaving it standing under a changed sentence is the same
    // stale-answer trap the model result above is cleared for.
    const [answers, setAnswers] = useState('');
    const offline = useMemo(() => suggestOutputs(text, { fields, topics, element }), [text, fields, topics, element]);
    const suggestion = offline.rules.length ? offline : (ai || offline);

    const retype = (next) => {
        setText(next);
        if (ai) setAi(null);
        if (askError) setAskError('');
        if (answers) setAnswers('');
    };

    const askAi = async () => {
        setAsking(true);
        setAskError('');
        try {
            setAi(await askModelForRules(api, { description: text, fields, itemVar, perItem }));
        } catch (e) {
            setAskError(askFailureMessage(e));
        } finally {
            setAsking(false);
        }
    };

    return { text, retype, suggestion, fromAi: suggestion === ai, asking, askError, askAi, answers, setAnswers, perItem };
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
function useRouteHandoff({
    text, answers, suggestion, fromAi, itemVar, perItem, sourceRef, wiredOutputNames,
    onInsertUpstreamStep, onApplyHandoff,
}) {
    const offered = typeof onInsertUpstreamStep === 'function'
        && fromAi && !suggestion.rules.length && !!suggestion.problem;
    const named = useMemo(() => parseCategories(answers), [answers]);
    const plan = useMemo(
        () => (offered && named.length
            ? planRouteHandoff({ description: text, categories: named, itemVar, perItem, sourceRef })
            : null),
        [offered, named, text, itemVar, perItem, sourceRef],
    );
    const accept = () => {
        if (!plan?.step) return;
        if (onInsertUpstreamStep(plan.step) === false) return;
        onApplyHandoff?.(plan);
    };
    // The same subtraction the suggestion preview makes, for the same reason:
    // a wired output whose NAME survives keeps its edge, so only the names
    // this plan does not reuse are actually lost.
    const losingWires = useMemo(
        () => (plan ? (wiredOutputNames || []).filter(n => !plan.rules.some(r => r.name === n)) : []),
        [plan, wiredOutputNames],
    );
    return { offered, named, plan, accept, losingWires };
}

/**
 * "Check each attachment instead" removes its own note; focus stays in the
 * box, on the description, which is suggested again against the files.
 */
function useWorkThroughFocus(onWorkThroughList) {
    const inputRef = useRef(null);
    const workThroughList = typeof onWorkThroughList === 'function'
        ? (listPath) => { onWorkThroughList(listPath); inputRef.current?.focus(); }
        : null;
    return { inputRef, workThroughList };
}

function RouteAssist({
    fields = [],
    sampleRows = null,
    sampleRoot = null,
    itemVar = 'item',
    unit = 'records',
    perItem: perItemProp, // works through a list; derived from the rows when absent
    existingRuleCount = 0,
    wiredOutputNames = [],
    // The accept, and the three handoff props beside it — the list this node
    // works through, the shell's insert, and the accept that writes the rules
    // a handoff produced. Absent rather than defaulted, like `onApply`: a
    // missing callback here means "this surface cannot do that", which
    // useRouteHandoff reads directly.
    onApply,
    sourceRef,
    onInsertUpstreamStep,
    onApplyHandoff,
    // `{ available, reason }` for the topic classifier: "is about" outputs can
    // be suggested only when it is available (routeTopicIntent.ts).
    topics = null,
    // One item's sample (is it a file, or does it hold files?) and
    // `(listPath) => void`, which makes the node work through another list.
    // After an accept: does a row matching several outputs go down each
    // (`fanOut`), and does one output send what it does not match to Otherwise?
    itemSample, onWorkThroughList, fanOut, keepRest,
}) {
    const { t } = useTranslation();
    const { text, retype, suggestion, fromAi, asking, askError, askAi, answers, setAnswers, perItem } =
        useRouteSuggestion({ fields, itemVar, sampleRows, unit, perItem: perItemProp, topics: topics?.available === true, element: itemSample });
    const rules = suggestion.rules;
    // "Is about" rules are counted only against rows the classifier scored,
    // after the author asks; every other rule as before (useTopicPreview).
    const { counts, topic } = useTopicPreview({ rules, rows: sampleRows, root: sampleRoot, itemVar });

    const { inputRef, workThroughList } = useWorkThroughFocus(onWorkThroughList);
    const handoff = useRouteHandoff({
        text, answers, suggestion, fromAi, itemVar, perItem, sourceRef, wiredOutputNames,
        onInsertUpstreamStep, onApplyHandoff,
    });

    return (
        <div className={cardClass()}>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                <Lightbulb size={12} /> Suggest outputs
            </div>
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {t('automations.route_assist.describe_the_outputs_in_your_own', 'Describe the outputs in your own words and check them below. Nothing changes until you accept. This runs here in the browser first — no AI, and nothing leaves this page.')}
            </div>
            <input ref={inputRef}
                type="text"
                value={text}
                onChange={(e) => retype(e.target.value)}
                aria-label={t('automations.route_assist.describe_the_outputs_you_want', 'Describe the outputs you want')}
                placeholder={t('automations.route_assist.split_these_files_by_pdf_word', 'split these files by pdf, word and powerpoint')}
                className={rowInputClass('w-full')}
            />

            {!rules.length && <SuggestProblem suggestion={suggestion} />}

            <AskAiRow
                offered={!rules.length && text.trim().length > 2}
                asking={asking}
                error={askError}
                onAsk={askAi}
            />

            <HandoffOffer
                offered={handoff.offered}
                answers={answers}
                onAnswers={setAnswers}
                named={handoff.named}
                plan={handoff.plan}
                perItem={perItem}
                unit={unit}
                existingRuleCount={existingRuleCount}
                losingWires={handoff.losingWires}
                onAccept={handoff.accept}
            />

            {rules.length > 0 && (
                <SuggestionPreview
                    suggestion={suggestion}
                    fromAi={fromAi}
                    counts={counts}
                    unit={unit} keepRest={keepRest}
                    existingRuleCount={existingRuleCount}
                    /* An output that keeps its name keeps its connection —
                       the rule this whole section states out loud — so only
                       the wired names the suggestion does NOT reuse are
                       casualties. */
                    losingWires={(wiredOutputNames || []).filter(n => !rules.some(r => r.name === n))}
                    onApply={() => onApply?.(rules)}
                    onReset={() => retype('')}
                    topic={topic}
                />
            )}
            <FilesInsideNote filesInside={suggestion.filesInside} sourceRef={sourceRef}
                ruleCount={rules.length} fanOut={fanOut} onWorkThroughList={workThroughList} />
        </div>
    );
}

/**
 * Where these rules came from, in one line.
 *
 * The offline catalogue knows WHICH field it matched on and says so; the
 * model was given every field and is not asked to claim one, so an AI answer
 * says where it came from instead of naming a field it may not have used.
 * Presenting a model's rules in the catalogue's confident voice would make
 * the two indistinguishable — and only one of them is a fixed answer that
 * cannot drift between releases.
 */
function previewHeading(suggestion, fromAi, t) {
    const n = suggestion.rules.length;
    if (fromAi) {
        return `Written by the AI — ${n === 1 ? 'one output' : `${n} outputs`}, checked against the fields this step produces:`;
    }
    const outputs = n === 1 ? 'one output, using' : `${n} outputs, using`;
    const fileType = suggestion.kind === 'fileType';
    const understood = fileType ? t('condition_node.suggest.by_file_type', 'Split by file type') : suggestion.understood;
    const label = fileType && suggestion.field?.path?.startsWith('fileType(')
        ? t('condition_node.file_type.label', 'File type')
        : suggestion.field?.label || 'this field';
    return `${understood} — ${outputs} ${label}:`;
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
function AskAiRow({ offered, asking, error, onAsk }) {
    const { t } = useTranslation();
    if (asking) {
        return (
            <div className="inline-flex items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
                <Loader2 size={11} className="animate-spin" /> Asking the AI…
            </div>
        );
    }
    return (
        <>
            {offered && (
                <div className="space-y-1">
                    <button
                        type="button"
                        onClick={onAsk}
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition"
                    >
                        <Sparkles size={11} /> Ask the AI instead
                    </button>
                    {/* Said BEFORE the click, not after: what travels is the
                        shape of the data, never the data. */}
                    <div className="text-[10px] text-[var(--text-tertiary)]">
                        {t('automations.route_assist.this_sends_your_description_and_the', 'This sends your description and the field names — never any rows or values — and every condition that comes back is checked against those fields before you see it.')}
                    </div>
                </div>
            )}
            {error && <div className="text-[10px] text-amber-600 dark:text-amber-400">{error}</div>}
        </>
    );
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
function HandoffOffer({
    offered = false, answers, onAnswers, named = [], plan, perItem, unit,
    existingRuleCount = 0, losingWires = [], onAccept,
}) {
    const { t } = useTranslation();
    if (!offered) return null;
    return (
        <div className="space-y-1.5 rounded border border-[var(--border-default)] p-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                <Plus size={12} /> Have an AI step answer it first
            </div>
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {t('automations.route_assist.an_output_can_only_compare_fields', 'An output can only compare fields that already exist, and none of the fields here holds the answer to that question. An AI step placed before this one can answer it in a single word, and the outputs then check that word. This ADDS A STEP to your automation — it is the only thing in this box that does.')}
            </div>
            <input
                type="text"
                value={answers}
                onChange={(e) => onAnswers(e.target.value)}
                aria-label={t('automations.route_assist.name_the_possible_answers', 'Name the possible answers')}
                placeholder={t('automations.route_assist.complaint_question_something_else', 'complaint, question, something else')}
                className={rowInputClass('w-full')}
            />
            {/* A plan this cannot make says why, in a sentence. A greyed-out
                button with no reason attached is the thing an author stares
                at and then rebuilds by hand. */}
            {plan?.problem && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">{plan.problem}</div>
            )}
            {plan?.step && (
                <HandoffPlanPreview
                    plan={plan}
                    named={named}
                    perItem={perItem}
                    unit={unit}
                    existingRuleCount={existingRuleCount}
                    losingWires={losingWires}
                    onAccept={onAccept}
                />
            )}
        </div>
    );
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
function HandoffPlanPreview({ plan, named, perItem, unit, existingRuleCount, losingWires, onAccept }) {
    const ruleLine = useRuleLine();
    const n = plan.rules.length;
    const one = n === 1;
    const oneWire = losingWires.length === 1;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-[var(--text-tertiary)]">
                One new step, “{plan.step.label}”
                {perItem ? `, run once per ${singularKey(unit)} of the list above,` : ','} answering with
                one of {named.length === 1 ? 'that word' : `those ${named.length} words`} — and {one ? 'one output' : `${n} outputs`} here
                reading it:
            </div>
            <ul className="space-y-1">
                {plan.rules.map(r => (
                    <li key={r.name} className="text-[11px] text-[var(--text-secondary)]">
                        <span className="text-[var(--text-primary)] font-medium">{r.name}</span>
                        {' — '}
                        {ruleLine(r.expr)}
                    </li>
                ))}
            </ul>
            {/* The match count that is deliberately absent. Every other preview
                in this box counts against the sample rows the editor already
                has; here the field being compared does not exist yet in any of
                them, so there is nothing to count and "0 of 12 matched" would
                read as a broken rule rather than an unanswered question. */}
            <div className="text-[10px] text-[var(--text-tertiary)]">
                Nothing can be counted against the sample {unit} yet — the answer is written by the new step,
                so it exists only once this has run.
            </div>
            {named.length > n && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                    Only the first {n} answers are used — more outputs than that is a lookup table rather than a
                    routing decision, and every one of them is a port someone has to wire.
                </div>
            )}
            {existingRuleCount > 0 && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                    Accepting replaces the {existingRuleCount === 1 ? 'output' : `${existingRuleCount} outputs`} already
                    set up below.
                </div>
            )}
            {losingWires.length > 0 && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                    {losingWires.join(', ')} {oneWire ? 'is' : 'are'} wired on the canvas and
                    {oneWire ? ' is' : ' are'} not in this plan, so
                    {oneWire ? ' its connection goes' : ' their connections go'} too.
                </div>
            )}
            <button
                type="button"
                onClick={onAccept}
                className={PRIMARY_BUTTON_CLASS}
            >
                Add the step and use {one ? 'this output' : `these ${n} outputs`}
            </button>
        </div>
    );
}

/**
 * The preview: named outputs, each read back as a sentence, with what the
 * sample rows say about it — and an accept button that is the first thing in
 * this box to change anything at all.
 */
function SuggestionPreview({ suggestion, fromAi = false, counts, unit, keepRest = false, existingRuleCount, losingWires = [], onApply, onReset, topic }) {
    const { t } = useTranslation();
    const ruleLine = useRuleLine();
    const rules = suggestion.rules;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {previewHeading(suggestion, fromAi, t)}
            </div>
            <ul className="space-y-1">
                {rules.map((r, i) => (
                    <li key={r.name} className="text-[11px] text-[var(--text-secondary)]">
                        <span className="text-[var(--text-primary)] font-medium">{r.name}</span>
                        {' — '}
                        {ruleLine(r.expr)}
                        {counts && (
                            <span className="text-[var(--text-tertiary)]">
                                {' · '}{counts.perRule[i].matched} of {counts.total} sample {unit}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
            <TopicCheckRow unit={unit} topic={topic} />
            {counts
                ? <UnmatchedLine counts={counts} ruleCount={rules.length} keepRest={keepRest} unit={unit} />
                : !topic?.needed && (
                    <div className="text-[10px] text-[var(--text-tertiary)]">
                        There are no sample {unit} here yet, so none of this can be counted — the lines above are
                        what will be checked, not what has matched.
                    </div>
                )}
            {existingRuleCount > 0 && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                    Accepting replaces the {existingRuleCount === 1 ? 'output' : `${existingRuleCount} outputs`} already
                    set up below.
                </div>
            )}
            {/* Naming the canvas cost BEFORE the click, because an accept
                renames every output at once and this section has already
                promised that an output which disappears takes its connection
                with it. Going back to one output stops and asks; the trash
                icon says so in its tooltip; this said nothing at all, and the
                outputs it silently unwired did not even have to be configured
                — a named-but-blank output is a real port with a real edge
                (routeModel.js, usableRules), so the "already set up" count
                above cannot see it. That is the silent-loss shape BFSF-356 is
                about, arriving through a new door. */}
            {losingWires.length > 0 && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                    {losingWires.join(', ')} {losingWires.length === 1 ? 'is' : 'are'} wired on the canvas and
                    {losingWires.length === 1 ? ' is' : ' are'} not in this suggestion, so
                    {losingWires.length === 1 ? ' its connection goes' : ' their connections go'} too.
                </div>
            )}
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onApply}
                    className={PRIMARY_BUTTON_CLASS}
                >
                    {rules.length === 1 ? 'Use this output' : `Use these ${rules.length} outputs`}
                </button>
                <button
                    type="button"
                    onClick={onReset}
                    className="text-[10px] text-[var(--text-tertiary)] hover:underline"
                >
                    {t('automations.route_assist.start_over', 'Start over')}
                </button>
            </div>
            {suggestion.truncated && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                    Only the first {rules.length} are shown — more outputs than that is a lookup table rather than a
                    routing decision, and every one of them is a port someone has to wire.
                </div>
            )}
        </div>
    );
}

export default RouteAssist;

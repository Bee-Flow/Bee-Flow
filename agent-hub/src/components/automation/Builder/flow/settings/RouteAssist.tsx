import { Lightbulb, Loader2, Sparkles } from 'lucide-react';
import { useMemo, useRef, useState, type SetStateAction, type Dispatch, type MouseEventHandler } from 'react';
import { cardClass, rowInputClass } from './formPrimitives';
import {
    FilesInsideNote, PRIMARY_BUTTON_CLASS, SuggestProblem, UnmatchedLine, useRuleLine,
} from './RouteAssistParts';
import { parseCategories, planRouteHandoff, type PlacedStep } from './routeHandoff';
import { suggestOutputs } from './routeIntents';
import { askFailureMessage, askModelForRules } from './routeRulesRequest';
import TopicCheckRow from './TopicCheckRow';
import useTopicPreview from './useTopicPreview';
import useAutomationApi from '@/hooks/useAutomationApi';
import { useTranslation, type TranslateParams } from '@/hooks/useTranslation';
import type { IntentField, IntentResult } from './routeIntents.types';
import type { TopicsCapability } from '../../mapping/TopicNotice';
import type { SuggestedRule, RouteConfig } from './routeTypes';
import type { Suggestion, HandoffPlan, HandoffPlanWithStep, UseRouteSuggestionArgs, UseRouteHandoffArgs, InsertUpstreamStep, RouteAssistProps, AskAiRowProps, SuggestionPreviewProps } from './RouteAssist.types';
import { HandoffOffer } from './HandoffOffer';

function useRouteSuggestion({ fields, itemVar, sampleRows, unit, perItem: perItemProp, topics, element }: UseRouteSuggestionArgs) {
    const api = useAutomationApi();
    // Does this node decide about the whole run, or about one row at a time?
    // It follows from what the editor handed down rather than being asked
    // again, and both the model request and the handoff plan below hinge on
    // it, so it is derived once here.
    // An explicit `perItem` wins: `unit` is the list's own word ("messages").
    const perItem = perItemProp ?? (!!sampleRows || unit === 'items');
    const [text, setText] = useState('');
    const [ai, setAi] = useState<Suggestion | null>(null);        // { rules, problem } once asked
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

    const retype = (next: SetStateAction<string>) => {
        setText(next);
        if (ai) setAi(null);
        if (askError) setAskError('');
        if (answers) setAnswers('');
    };

    const askAi = async () => {
        setAsking(true);
        setAskError('');
        try {
            setAi(await askModelForRules(api, { description: text, fields, itemVar, perItem }) as Suggestion);
        } catch (e) {
            setAskError(askFailureMessage(e as { status?: number }));
        } finally {
            setAsking(false);
        }
    };

    return { text, retype, suggestion, fromAi: suggestion === ai, asking, askError, askAi, answers, setAnswers, perItem };
}

function useRouteHandoff({
    text, answers, suggestion, fromAi, itemVar, perItem, sourceRef, wiredOutputNames,
    onInsertUpstreamStep, onApplyHandoff,
}: UseRouteHandoffArgs) {
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
        if ((onInsertUpstreamStep as InsertUpstreamStep)(plan.step) === false) return;
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
function useWorkThroughFocus(onWorkThroughList: ((next: string) => void) | null) {
    const inputRef = useRef<HTMLInputElement>(null);
    const workThroughList = typeof onWorkThroughList === 'function'
        ? (listPath: string) => { onWorkThroughList(listPath); inputRef.current?.focus(); }
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
}: RouteAssistProps) {
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
                <Lightbulb size={12} /> {t('automations.route_assist.suggest_outputs', 'Suggest outputs')}
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
function previewHeading(suggestion: Suggestion, fromAi: boolean, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
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

function AskAiRow({ offered, asking, error, onAsk }: AskAiRowProps) {
    const { t } = useTranslation();
    if (asking) {
        return (
            <div className="inline-flex items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
                <Loader2 size={11} className="animate-spin" /> {t('automations.route_assist.asking_the_ai', 'Asking the AI…')}
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
                        <Sparkles size={11} /> {t('automations.route_assist.ask_the_ai_instead', 'Ask the AI instead')}
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

function SuggestionPreview({ suggestion, fromAi = false, counts, unit, keepRest = false, existingRuleCount, losingWires = [], onApply, onReset, topic }: SuggestionPreviewProps) {
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
                                {' · '}{t('automations.route_assist.matched_of_total', '{matched} of {total} sample {unit}', { matched: counts.perRule[i].matched, total: counts.total, unit })}
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
                        {t('automations.route_assist.no_sample_yet', 'There are no sample {unit} here yet, so none of this can be counted. The lines above are what will be checked, not what has matched.', { unit })}
                    </div>
                )}
            {existingRuleCount > 0 && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                    {existingRuleCount === 1
                        ? t('automations.route_assist.accept_replaces_one', 'Accepting replaces the output already set up below.')
                        : t('automations.route_assist.accept_replaces_many', 'Accepting replaces the {count} outputs already set up below.', { count: existingRuleCount })}
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
                    {losingWires.length === 1
                        ? t('automations.route_assist.suggestion_wire_lost_one', '{names} is wired on the canvas and is not in this suggestion, so its connection goes too.', { names: losingWires.join(', ') })
                        : t('automations.route_assist.suggestion_wire_lost_many', '{names} are wired on the canvas and are not in this suggestion, so their connections go too.', { names: losingWires.join(', ') })}
                </div>
            )}
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onApply}
                    className={PRIMARY_BUTTON_CLASS}
                >
                    {rules.length === 1
                        ? t('automations.route_assist.use_one', 'Use this output')
                        : t('automations.route_assist.use_many', 'Use these {count} outputs', { count: rules.length })}
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
                    {t('automations.route_assist.only_first_shown', 'Only the first {count} are shown. More outputs than that is a lookup table rather than a routing decision, and every one of them is a port someone has to wire.', { count: rules.length })}
                </div>
            )}
        </div>
    );
}

export default RouteAssist;

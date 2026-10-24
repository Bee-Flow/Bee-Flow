import { AlertCircle, ArrowUpRight, Loader2, Plus, RefreshCw, Sparkles, Workflow } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nOf } from '../../../components/admin/Studio/KnowledgeStudio/plural';
import { buildMessageFromSuggestion } from '../../../components/automation/taskFormatters';
import { cardRadius, kindColorVar, kindTileStyle, kindTint } from '../../../components/shared/kindColors';
import useAutomationApi from '../../../hooks/useAutomationApi';
import useTranslation from '../../../hooks/useTranslation';
import { automation as automationStatus } from '../../../components/shared/statusOf';
import {
    RULE_TRIGGER_PROVIDER,
    composerSeed,
    consequencesOf,
    facetsReadable,
    newRuleDefinition,
    openability,
    ruleHref,
    runCountOf,
    triggerConditionOf,
} from '../lib/meetingRules';
import type { TranslateFn, RuleRow, RuleIdea, SuggestDone, RulesState, RunFacets, RunsState, RunFacetsBody, IdeasState, CreatedAutomation, RunLabelInput, RuleFooterProps, RuleCardProps, ComposerProps, RulesPanelProps, TriggerCondition, Consequences } from './RulesPanel.types';
import { describeError, errorCode, errorMessage, errorStatus, messageOf } from '../../../utils/caughtError';
import { logger } from '../../../utils/logger';

/**
 * "Rules" — the automations that run on a COMPLETED meeting note, as readable sentences (M5, part D).
 *
 * One card per automation with an `app_event` trigger on provider `meeting-notes`: "When <tag filter> is finished → <consequences>". What is true is stated in ../lib/meetingRules.js; this file turns it into sentences.
 *
 * The source is `GET /api/automation?triggerProvider=meeting-notes` (M2, routes/automation/crud.js) — a list that by contract contains ONLY the reader's own automations (`getAutomationsForUser` is `WHERE user_id = $1`). That is also stated on screen: a colleague who opens the same meeting does not see the same rules, and "no rules" would otherwise be a lie.
 *
 * ── THE CONSEQUENCE SENTENCE COMES FROM THE STEP TYPES ──────────────
 * Not from a second, hand-maintained list beside the definition: `consequencesOf` reads `definition.steps` (including loop bodies, parallel branches, switch cases and inline layers). Three types get a sentence; everything this card does not know is COUNTED, and the sentence says that more happens than is stated — never silence. The same holds for the trigger filter: every key beside `tags` and `reprocessed` makes the rule narrower than the sentence says, and then the card says that.
 *
 * ── THE RUN COUNT IS PER USER, AND THE SENTENCE SAYS SO ─────────────
 * `/_runs/facets` counts `r.user_id = <me>` — MY runs, not those of the organisation; the org variant is a DIFFERENT endpoint with its own permission check (`/_runs/org/facets`, `manage_automations`). A card that says "ran 3 times" while it is "3 of your runs" is exactly the count that would concern someone else's runs. That is why "of yours" is in the sentence and not in a footnote.
 *
 * And: a FAILED facets read shows NOTHING — not 0. Zero and unreadable are different answers; the panel says once at the top that the counts could not be read. If the read DID succeed and this automation is not in it, that is a real zero over a real range, and that sentence is explicit about both ("no runs of yours in the last 24 hours").
 *
 * ── NO LINK THAT ENDS IN A 403 ──────────────────────────────────────
 * `GET /api/automation/:id` refuses with 403 as soon as `a.userId !== me`. The card therefore links only when `openability(row, me) === 'ok'`, in other words only if the ownership is POSITIVELY established.
 */

// The window of the run count. Same choice as AutomationTile: a ROLLING
// window of 24 hours, and the sentence says "in the last 24 hours" and not
// "today" — a calendar day is a different number.
const RANGE_HOURS = 24;

// How many ideas the composer shows. The server supplies at most six
// (SUGGEST_MAX_SUGGESTIONS); in a 300px rail three are enough.
const MAX_IDEAS = 3;
const list = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

/**
 * The licence gate speaks in MACHINE TOKENS, not in English sentences.
 *
 * All of `/api/automation` sits behind `requireLicenseFeature('automations')`, and that middleware answers `{error:'feature_locked'}` (or `'tier_required'` on a 201 path). `safeText` in useAutomationApi returns `j.error` from that, so `err.message` IS that token — and `err.status` is not there, because `send` does not attach it to the Error. A test on /403|forbidden|licen/ was therefore always false: the customer got the bare string `feature_locked` in the red banner, and the key `rules_not_licensed` was unreachable.
 */
const LICENCE_TOKENS = new Set(['feature_locked', 'tier_required', 'license_required', 'licence_required']);

/** True for any object, which is where `retryAfter` can be read; a primitive has none. */
function hasRetryAfter(v: unknown): v is { retryAfter?: unknown } {
    return typeof v === 'object' && v !== null;
}

export function licenceMessage(err: unknown, t: TranslateFn): string | null {
    const message = String(errorMessage(err) || err || '').trim(); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- word-bounded literal alternatives: linear
    const locked = LICENCE_TOKENS.has(message)
        || errorCode(err) === 'feature_locked' || errorCode(err) === 'tier_required'
        || errorStatus(err) === 402 || errorStatus(err) === 403
        || /\blicen[cs]e\b|\bforbidden\b/i.test(message);
    return locked
        ? t('meetings.rules_not_licensed', 'Automations are not part of this plan, so a rule cannot be made here.')
        : null;
}

/* ── zinnen ──────────────────────────────────────────────────────────── */

/**
 * "When a meeting tagged sales, support is finished" — the WHEN half.
 *
 * "… is finished" is the sentence of `meeting.processed`, and that appears only when THAT is the event. `meetingTriggersOf` deliberately filters on the PROVIDER and not on the event, so that a later `meeting.scheduled` automatically lands in the list — but then this sentence would tell the story of `meeting.processed` about every future event. Also reachable today: an unknown app_event event is a WARNING for the validator, not an error, so such a definition is saved, appears here, and never fires.
 */
export function conditionSentence(condition: TriggerCondition, t: TranslateFn): string | null {
    if (!condition) return null;
    const tags = list(condition.tags);
    if (!condition.onlyProcessed) {
        const events = list(condition.events).filter(Boolean);
        return events.length
            ? t('meetings.rules_when_event', 'When meeting notes fire {event}', { event: events.join(', ') })
            : t('meetings.rules_when_event_unknown', 'When meeting notes fire an event this card cannot name');
    }
    if (!tags.length) return t('meetings.rules_when_any', 'When any meeting note is finished');
    return nOf(
        t, 'meetings.rules_when_tagged', tags.length,
        'When a meeting tagged {tags} is finished',
        'When a meeting tagged any of {tags} is finished',
        { tags: tags.join(', ') },
    );
}

/**
 * The THEN half, as separate pieces (the card places ` · ` between them).
 *
 * Separate pieces and not a ready-made sentence: a list with "and" between is different in every language, and the separator here is the same character that the rest of this product places between facts (AutomationTile).
 */
export function consequenceParts(consequences: Consequences, t: TranslateFn): string[] {
    if (!consequences || consequences.readable === false) {
        return [t('meetings.rules_steps_unreadable', 'its steps could not be read')];
    }
    const parts: string[] = [];
    if (consequences.kb) parts.push(t('meetings.rules_does_kb', 'files it in a knowledge base'));
    if (consequences.notify) parts.push(t('meetings.rules_does_notify', 'sends a notification'));
    if (consequences.table) parts.push(t('meetings.rules_does_table', 'writes a row to a datatable'));
    if (consequences.other > 0) {
        parts.push(nOf(
            t, 'meetings.rules_does_other', consequences.other,
            '{count} more step this card cannot describe',
            '{count} more steps this card cannot describe',
        ));
    }
    if (!parts.length) {
        // "No steps" and "steps present, but none that this card counts as a
        // consequence" are different answers. Showing them together as "has no
        // steps" makes an author think his work was not saved.
        parts.push(consequences.steps > 0
            ? nOf(
                t, 'meetings.rules_does_internal', consequences.steps,
                '{count} step that only prepares data — nothing leaves the run',
                '{count} steps that only prepare data — nothing leaves the run',
            )
            : t('meetings.rules_does_nothing', 'nothing yet — this rule has no steps'));
    }
    return parts;
}

/**
 * The run line of one card, or NULL if there is nothing to say.
 *
 * NULL for a failed or still-running read — never a 0, because that would be a claim about runs we could not count. If the read succeeded and the automation is not in the facets, that is a real zero over a real range, and the sentence says so.
 */
export function runLabel({ facets, facetsError, automationId, hours }: RunLabelInput, t: TranslateFn): string | null {
    if (facetsError || !facets) return null;
    const n = runCountOf(facets, automationId);
    // NULL here means "nobody has counted" (no automationId map in the answer),
    // not "zero runs". Those were two different things with the same answer, and
    // the card made "no runs of yours" of it.
    if (n === null) return null;
    if (n === 0) {
        return t('meetings.rules_runs_none', 'no runs of yours in the last {hours} hours', { hours });
    }
    return nOf(
        t, 'meetings.rules_runs_mine', n,
        '{count} run of yours in the last {hours} hours',
        '{count} runs of yours in the last {hours} hours',
        { hours },
    );
}

/* ── presentatie ─────────────────────────────────────────────────────── */

const ERROR_BANNER = {
    background: 'color-mix(in srgb, var(--error) 8%, var(--bg-secondary))',
    borderColor: 'var(--error)',
    color: 'var(--text-primary)',
};
const WARN_BANNER = {
    background: 'color-mix(in srgb, var(--warning) 8%, var(--bg-secondary))',
    borderColor: 'var(--warning)',
    color: 'var(--text-primary)',
};

const smallButton = 'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium border disabled:opacity-50 flex-shrink-0';

/**
 * Active / paused / DRAFT — the shared three-state word list (`components/shared/statusOf.automation`, where `isDraft` beats `isActive`). Two states was a real error here: every rule that the "+ Rule" button of this panel creates comes out of the store as `is_active=FALSE, is_draft=TRUE`, and therefore got the word "Paused" — the same word as a finished rule that you deliberately switched off. The trigger bus skips a draft for a DIFFERENT reason (`dispatch.js` looks at `!isActive` AND at `isDraft`), and `crud.js` computes for the same reason `live = isActive && !isDraft`.
 */
function StateChip({ row, t }: { row: RuleRow; t: TranslateFn }) {
    // `undefined` is not "off": a row without these columns gets no chip.
    if (typeof row?.isActive !== 'boolean' && typeof row?.isDraft !== 'boolean') return null;
    const status = automationStatus(row);
    const style = status === 'live'
        ? { background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: 'var(--success-ink)' }
        : status === 'draft'
            ? { background: 'color-mix(in srgb, var(--warning) 14%, transparent)', color: 'var(--warning-ink)' }
            : { background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' };
    const label = status === 'live'
        ? t('meetings.rules_active', 'Active')
        : status === 'draft'
            ? t('meetings.rules_draft', 'Draft')
            : t('meetings.rules_paused', 'Paused');
    return (
        <span
            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0"
            style={style}
            title={status === 'draft' ? t('meetings.rules_draft_hint', 'Still a draft, so it does not run yet — open it and activate it.') : undefined}
        >
            {label}
        </span>
    );
}

/** The line under the sentence: whose runs they are, and whether the rule can be opened. */
function RuleFooter({ row, runs, open, onOpen, t }: RuleFooterProps) {
    return (
        <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[11px] truncate text-[var(--text-tertiary)]" data-testid="rule-runs">
                {runs || ''}
            </span>
            {open === 'ok' && typeof onOpen === 'function' ? (
                <button
                    type="button"
                    onClick={() => onOpen(row.id)}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium flex-shrink-0 text-[var(--accent-primary)]"
                    data-testid="rule-open"
                >
                    {t('meetings.rules_open', 'Open automation')}
                    <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                </button>
            ) : open === 'foreign' ? (
                <span className="text-[11px] flex-shrink-0 text-[var(--text-tertiary)]" data-testid="rule-foreign">
                    {t('meetings.rules_someone_elses', 'Someone else’s rule')}
                </span>
            ) : null}
        </div>
    );
}

export function RuleCard({ row, facets, facetsError, hours, currentUserId, onOpen, t }: RuleCardProps) {
    const condition = triggerConditionOf(row?.definition);
    const parts = consequenceParts(consequencesOf(row?.definition), t);
    const runs = runLabel({ facets, facetsError, automationId: row?.id, hours }, t);

    const reprocessed = condition?.reprocessed === true
        ? t('meetings.trigger_reprocessed_again', 'Only a reprocess or a new summary')
        : (condition?.reprocessed === false ? t('meetings.trigger_reprocessed_first', 'Only a brand-new note') : null);
    const narrowing = [
        reprocessed,
        condition?.extra ? t('meetings.rules_extra_conditions', 'narrowed further by conditions this card cannot show') : null,
    ].filter(Boolean);

    const tile = kindTileStyle('automation', 28);

    return (
        <div
            className="flex flex-col gap-1.5 p-2.5 mb-1 border"
            style={{ borderRadius: cardRadius('automation'), borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
            data-testid="rule-card"
        >
            <div className="flex items-start gap-2 min-w-0">
                <span style={tile.tile} aria-hidden="true"><Workflow style={tile.glyph} /></span>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[13px] font-medium truncate text-[var(--text-primary)]">
                            {row?.title || t('meetings.rules_untitled', 'Untitled rule')}
                        </span>
                        <StateChip row={row} t={t} />
                    </div>
                    <p className="text-[11px] leading-snug text-[var(--text-secondary)]" data-testid="rule-sentence">
                        {conditionSentence(condition, t) || t('meetings.rules_when_unknown', 'This rule no longer starts on a meeting note')}
                        {' → '}
                        {parts.join(' · ')}
                    </p>
                    {narrowing.length > 0 && (
                        <p className="text-[11px] leading-snug text-[var(--text-tertiary)]" data-testid="rule-narrowing">
                            {narrowing.join(' · ')}
                        </p>
                    )}
                </div>
            </div>
            <RuleFooter row={row} runs={runs} open={openability(row, currentUserId)} onOpen={onOpen} t={t} />
        </div>
    );
}

/* ── de composer ─────────────────────────────────────────────────────── */

function Composer({ text, onText, ideas, onRun, onUseIdea, creating, t }: ComposerProps) {
    return (
        <div className="mx-3 mb-2 px-2.5 py-2 rounded-lg border flex flex-col gap-1.5 border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <label className="text-[11px] text-[var(--text-tertiary)]" htmlFor="meeting-rules-composer">
                {t('meetings.rules_ai_hint', 'Say what should happen after a meeting; the ideas stay inside meeting notes.')}
            </label>
            <input
                id="meeting-rules-composer"
                type="text"
                value={text}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => onText(e.target.value)}
                placeholder={t('meetings.rules_ai_placeholder', 'put the decisions in the sales knowledge base')}
                className="w-full px-2 py-1 rounded-md border text-[12px] [border-color:var(--border-default)] [background:var(--bg-card)] [color:var(--text-primary)]!"
            />
            <button
                type="button" onClick={onRun} disabled={ideas.busy}
                className={`${smallButton} self-start [border-color:var(--accent-primary)] [color:var(--accent-primary)]`}
                data-testid="rules-composer-run"
            >
                {ideas.busy
                    ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                    : <Sparkles className="w-3 h-3" aria-hidden="true" />}
                {ideas.busy ? t('meetings.rules_ai_busy_label', 'Looking…') : t('meetings.rules_ai_go', 'Get ideas')}
            </button>

            {ideas.error && (
                <div className="px-2 py-1.5 rounded-md border text-[11px]" style={ERROR_BANNER} role="status" data-testid="rules-ai-error">
                    {ideas.error}
                </div>
            )}
            {!ideas.busy && ideas.ran && !ideas.error && ideas.items.length === 0 && (
                <div className="px-2 py-1.5 rounded-md border text-[11px]" style={WARN_BANNER} data-testid="rules-ai-reason">
                    {ideas.reason === 'no_integrations'
                        ? t('meetings.rules_ai_no_apps', 'No connected apps to look at yet, so there is nothing to base an idea on.')
                        : ideas.reason === 'no_patterns'
                            ? t('meetings.rules_ai_no_patterns', 'The scan ran and found nothing worth turning into a rule yet.')
                            : t('meetings.rules_ai_empty', 'The scan ran and came back with nothing.')}
                </div>
            )}
            {ideas.items.map((idea: RuleIdea, i: number) => (
                <div key={idea?.id ?? `idea-${i}`} className="px-2 py-1.5 rounded-md border flex flex-col gap-1 border-[var(--border-subtle)] bg-[var(--bg-card)]" data-testid="rules-idea">
                    <span className="text-[12px] font-medium text-[var(--text-primary)]">{idea?.title}</span>
                    {idea?.description && (
                        <span className="text-[11px] leading-snug text-[var(--text-tertiary)]">{idea.description}</span>
                    )}
                    <button
                        type="button" onClick={() => onUseIdea(idea)} disabled={creating}
                        className={`${smallButton} self-start [border-color:var(--border-default)] [color:var(--text-secondary)]`}
                    >
                        {t('meetings.rules_idea_build', 'Start this rule')}
                    </button>
                </div>
            ))}
        </div>
    );
}

/* ── het paneel ──────────────────────────────────────────────────────── */

export default function RulesPanel({
    currentUserId = null,
    onNavigate = null,
    onComposeRule = null,
    onRulesChange = null,
}: RulesPanelProps) {
    const { t } = useTranslation();
    const api = useAutomationApi();

    const [rules, setRules] = useState<RulesState>({ loading: true, error: null, rows: null });
    const [runs, setRuns] = useState<RunsState>({ loading: true, error: null, facets: null, hours: RANGE_HOURS });
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    const [composerOpen, setComposerOpen] = useState(false);
    const [composerText, setComposerText] = useState('');
    // `ran` separates "not yet asked" from "asked and got nothing" — the banner
    // below is only about the second.
    const [ideas, setIdeas] = useState<IdeasState>({ busy: false, ran: false, error: null, reason: null, items: [] });
    const abortRef = useRef<AbortController | null>(null);

    const loadRules = useCallback(async () => {
        setRules((s: RulesState) => ({ ...s, loading: true, error: null }));
        try {
            const body = await api.listAutomations<{ automations?: RuleRow[] }>({ triggerProvider: RULE_TRIGGER_PROVIDER });
            setRules({ loading: false, error: null, rows: list(body?.automations) });
        } catch (err) {
            // No empty list on an error: "no rules" and "I could not read it" are
            // different answers.
            setRules({ loading: false, error: err, rows: null });
        }
    }, [api]);

    const loadRuns = useCallback(async () => {
        setRuns((s: RunsState) => ({ ...s, loading: true, error: null }));
        try {
            // `mode: 'live'` — a DRY-RUN is not a run that runs by itself, and the heading
            // of this panel says exactly that ("What runs by itself once a meeting note
            // is ready"). Without mode, `parseRunFilters` counts all modes, while the
            // store helper that answers the same question elsewhere does choose
            // `mode = 'live'` as its default.
            const body = (await api.getRunFacets({ range: RANGE_HOURS, mode: 'live' })) as RunFacetsBody;
            // The server clamps `range` to [1,720] and can therefore report a DIFFERENT
            // window than requested; the sentence names that number, so it comes from
            // the answer and not from the constant.
            const hours = Number.isFinite(body?.rangeHours) ? (body.rangeHours as number) : RANGE_HOURS;
            setRuns({ loading: false, error: null, facets: body?.facets ?? null, hours });
        } catch (err) {
            setRuns({ loading: false, error: err, facets: null, hours: RANGE_HOURS });
        }
    }, [api]);

    const load = useCallback(() => { setCreateError(null); loadRules(); loadRuns(); }, [loadRules, loadRuns]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => () => { try { abortRef.current?.abort(); } catch (err) { logger.debug('al gesloten', err); } }, []);

    // Unreadable is not zero. A 200 with a body without an `automationId` map is
    // not "no runs" but "nobody has counted"; that landed silently as a zero on
    // every card while the banner stayed away.
    const runsUnreadable = !runs.loading && (!!runs.error || !facetsReadable(runs.facets));

    const rows = rules.rows;
    // Report only once the list is really there; during loading and after an error
    // the segment carries no number, instead of a 0 that reads as "none".
    const ruleCount = rows ? rows.length : null;
    useEffect(() => { onRulesChange?.(ruleCount); }, [ruleCount, onRulesChange]);

    const openRule = useCallback((id: string) => {
        const href = ruleHref(id);
        if (href && typeof onNavigate === 'function') onNavigate(href);
    }, [onNavigate]);

    const createRule = useCallback(async ({ title, description }: { title?: string; description?: string } = {}) => {
        setCreating(true);
        setCreateError(null);
        try {
            const created = await api.createAutomation<CreatedAutomation>({
                title: title || 'New meeting rule',
                description: description || 'Runs when a meeting note is ready.',
                triggerType: 'app_event',
                definition: newRuleDefinition(),
            });
            const id = created?.automation?.id || created?.id || null;
            await loadRules();
            if (id) openRule(id);
        } catch (err) {
            setCreateError(licenceMessage(err, t) || describeError(err));
        } finally {
            setCreating(false);
        }
    }, [api, loadRules, openRule, t]);

    const askAi = useCallback(async () => {
        try { abortRef.current?.abort(); } catch (err) { logger.debug('geen lopende scan', err); }
        const controller = new AbortController();
        abortRef.current = controller;
        setIdeas({ busy: true, ran: false, error: null, reason: null, items: [] });
        let done = null as SuggestDone | null;
        try {
            await api.suggestAutomationsStream(
                // No integration choice: empty means server-side "everything this user has",
                // and the scope sits in the seed.
                // Ideas mode: the model proposes rules; the default pattern
                // scan only reports work the user already repeats.
                { mode: 'ideas', integrationIds: [], focus: composerSeed(composerText) },
                (event: string, data: unknown) => {
                    if (event === 'done') done = data as SuggestDone;
                    else if (event === 'error') setIdeas((s: IdeasState) => ({ ...s, error: (data as { error?: string })?.error || null }));
                },
                controller.signal,
            );
            const items = list(done?.suggestions).slice(0, MAX_IDEAS);
            setIdeas((s: IdeasState) => ({
                busy: false,
                ran: true,
                error: s.error
                    // A STREAM THAT ENDS WITHOUT `done` IS NOT AN EMPTY RESULT.
                    // A truncated connection or a crash after the headers gave
                    // 0 cards, no banner, and a button that stood back on "Get
                    // ideas": "unknown" and "nothing found" became the same screen.
                    || (done ? null : t('meetings.rules_ai_cut_off', 'The scan stopped before it finished, so this is not an answer — try again.')),
                reason: done?.reason || null,
                items,
            }));
        } catch (err) {
            if (controller.signal.aborted) return;
            const retry = Number(hasRetryAfter(err) ? err.retryAfter : undefined);
            setIdeas({
                busy: false,
                ran: true,
                reason: null,
                items: [],
                error: errorStatus(err) === 429 || Number.isFinite(retry)
                    ? t('meetings.rules_ai_busy', 'Too many scans just now — try again in a moment.')
                    : messageOf(err, t('meetings.rules_ai_failed', 'Could not come up with ideas right now.')),
            });
        }
    }, [api, composerText, t]);

    const startIdea = useCallback((suggestion: RuleIdea) => {
        // The composer DELIVERS a spec, it builds nothing: the caller may hand it to
        // the build assistant. If that cannot, something usable remains — a draft
        // with the right trigger, the title and the description of the idea. The
        // prompt itself never goes into `description`: that field is a sentence for
        // people, not an instruction for a model.
        if (typeof onComposeRule === 'function') {
            onComposeRule(buildMessageFromSuggestion(suggestion), suggestion);
            return;
        }
        createRule({ title: suggestion?.title, description: suggestion?.description });
    }, [onComposeRule, createRule]);

    const loading = rules.loading;
    const busy = creating || ideas.busy;
    const emptyRules = useMemo(() => Array.isArray(rows) && rows.length === 0, [rows]);

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="text-[11px] text-[var(--text-tertiary)]">
                    {t('meetings.rules_intro', 'What runs by itself once a meeting note is ready. These are your own rules — a colleague sees theirs.')}
                </span>
                <button
                    type="button" onClick={load} disabled={loading}
                    className={smallButton}
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                >
                    <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
                    {t('meetings.rules_refresh', 'Refresh')}
                </button>
            </div>

            <div className="flex items-center gap-1.5 px-3 pb-2">
                <button
                    type="button" onClick={() => createRule()} disabled={busy}
                    className={smallButton}
                    style={{ borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }}
                    data-testid="rules-new"
                >
                    <Plus className="w-3 h-3" aria-hidden="true" />
                    {creating ? t('meetings.rules_new_busy', 'Making it…') : t('meetings.rules_new', 'Rule')}
                </button>
                <button
                    type="button" onClick={() => setComposerOpen((v: boolean) => !v)} disabled={creating}
                    aria-expanded={composerOpen}
                    className={smallButton}
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                    data-testid="rules-composer-toggle"
                >
                    <Sparkles className="w-3 h-3" aria-hidden="true" />
                    {t('meetings.rules_ai', 'Suggest a rule')}
                </button>
            </div>

            {createError && (
                <div className="mx-3 mb-2 px-3 py-2 rounded-lg border text-[11px]" style={ERROR_BANNER} role="status" data-testid="rules-create-error">
                    {createError}
                </div>
            )}
            {composerOpen && (
                <Composer
                    text={composerText} onText={setComposerText}
                    ideas={ideas} onRun={askAi} onUseIdea={startIdea}
                    creating={creating} t={t}
                />
            )}
            <div className="flex-1 overflow-y-auto px-3 pb-3">
                {loading && (
                    <div className="flex items-center gap-2 px-3 py-6 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin text-[var(--text-tertiary)]" aria-hidden="true" />
                        <span className="text-xs text-[var(--text-secondary)]">{t('meetings.rules_loading', 'Loading rules…')}</span>
                    </div>
                )}
                {!loading && Boolean(rules.error) && (
                    <div className="flex flex-col gap-1 px-3 py-2.5 rounded-lg border text-[11px] mb-1" style={ERROR_BANNER} data-testid="rules-error">
                        <div className="font-semibold">{t('meetings.rules_failed', 'Couldn’t load the rules for meeting notes')}</div>
                        <div className="text-[var(--text-secondary)]">
                            {licenceMessage(rules.error, t) || errorMessage(rules.error)}
                        </div>
                    </div>
                )}
                {/* Once at the top, not per card: the counts are all missing for the same
                    reason, and a 0 per card would be a claim about runs that nobody
                    could count. */}
                {!loading && !rules.error && !runs.loading && runsUnreadable && (
                    <div className="flex items-start gap-2 px-3 py-2 mb-1 rounded-lg border text-[11px]" style={WARN_BANNER} data-testid="rules-runs-error">
                        <AlertCircle className="w-4 h-4 flex-shrink-0 [color:var(--warning)]" aria-hidden="true" />
                        <span>{t('meetings.rules_runs_unreadable', 'Couldn’t read how often these ran, so no rule shows a count.')}</span>
                    </div>
                )}
                {!loading && !rules.error && emptyRules && (
                    <div className="flex flex-col items-center gap-2 px-3 py-8 text-center" data-testid="rules-empty">
                        <div className="w-12 h-12 rounded-2xl grid place-items-center"
                            style={{ background: kindTint('automation', 12), color: kindColorVar('automation') }} aria-hidden="true">
                            <Workflow className="w-6 h-6" />
                        </div>
                        <div className="text-sm font-semibold text-[var(--text-primary)]">{t('meetings.rules_empty_title', 'No rules yet')}</div>
                        <div className="text-[11px] max-w-xs text-[var(--text-tertiary)]">
                            {t('meetings.rules_empty_desc', 'A rule picks up a meeting note the moment it is ready — files it, passes it on, or tells someone.')}
                        </div>
                    </div>
                )}
                {list(rows).map((row: RuleRow) => (
                    <RuleCard
                        key={row.id}
                        row={row}
                        facets={runs.facets}
                        facetsError={runsUnreadable}
                        hours={runs.hours}
                        currentUserId={currentUserId}
                        onOpen={openRule}
                        t={t}
                    />
                ))}
            </div>
        </div>
    );
}

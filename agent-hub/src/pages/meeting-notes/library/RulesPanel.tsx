import { AlertCircle, Loader2, Plus, RefreshCw, Sparkles, Workflow } from 'lucide-react';
import { SetStateAction, Dispatch, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildMessageFromSuggestion } from '../../../components/automation/taskFormatters';
import { kindColorVar, kindTint } from '../../../components/shared/kindColors';
import useAutomationApi from '../../../hooks/useAutomationApi';
import useTranslation, { TranslateParams } from '../../../hooks/useTranslation';
import { RULE_TRIGGER_PROVIDER, composerSeed, facetsReadable, newRuleDefinition, ruleHref } from '../lib/meetingRules';
import type { TranslateFn, RuleRow, RuleIdea, SuggestDone, RulesState, RunFacets, RunsState, RunFacetsBody, IdeasState, CreatedAutomation, RulesPanelProps } from './RulesPanel.types';
import { describeError, errorCode, errorMessage, errorStatus, messageOf } from '../../../utils/caughtError';
import { logger } from '../../../utils/logger';
import { list, RuleCard } from './RuleCard';
import { ERROR_BANNER, WARN_BANNER, smallButton, Composer } from './Composer';
export { conditionSentence, consequenceParts, runLabel, RuleCard } from './RuleCard';

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

/* ── presentatie ─────────────────────────────────────────────────────── */

/* ── de composer ─────────────────────────────────────────────────────── */

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

            <RulesPanelSection2 createRule={createRule} busy={busy} creating={creating} t={t} setComposerOpen={setComposerOpen} composerOpen={composerOpen} />

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
            <RulesPanelSection loading={loading} t={t} rules={rules} runs={runs} runsUnreadable={runsUnreadable} emptyRules={emptyRules} rows={rows} currentUserId={currentUserId} openRule={openRule} />
        </div>
    );
}

function RulesPanelSection2({ createRule, busy, creating, t, setComposerOpen, composerOpen }: { createRule: ({ title, description }?: { title?: string; description?: string; }) => Promise<void>; busy: boolean; creating: boolean; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; setComposerOpen: Dispatch<SetStateAction<boolean>>; composerOpen: boolean; }) {
    return <div className="flex items-center gap-1.5 px-3 pb-2">
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
    </div>;
}

function RulesPanelSection({ loading, t, rules, runs, runsUnreadable, emptyRules, rows, currentUserId, openRule }: { loading: boolean; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; rules: RulesState; runs: RunsState; runsUnreadable: boolean; emptyRules: boolean; rows: RuleRow[] | null; currentUserId: string | null; openRule: (id: string) => void; }) {
    return <div className="flex-1 overflow-y-auto px-3 pb-3">
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
                t={t} />
        ))}
    </div>;
}

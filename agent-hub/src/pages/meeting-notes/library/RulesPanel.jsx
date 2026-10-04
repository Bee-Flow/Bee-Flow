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

/**
 * "Rules" (Regels) — de automations die op een AFGERONDE vergadernotitie
 * draaien, als leesbare zinnen (M5, deel D).
 *
 * Eén kaart per automatisering met een `app_event`-trigger op provider
 * `meeting-notes`: "Als <tagfilter> is afgerond → <consequenties>". Wat waar
 * is staat in ../lib/meetingRules.js; dit bestand maakt er zinnen van.
 *
 * De bron is `GET /api/automation?triggerProvider=meeting-notes` (M2,
 * routes/automation/crud.js) — een lijst die per contract ALLEEN de eigen
 * automatiseringen van de lezer bevat (`getAutomationsForUser` is `WHERE user_id =
 * $1`). Dat staat ook op het scherm: een collega die dezelfde vergadering
 * opent ziet niet dezelfde regels, en "geen regels" zou anders een leugen zijn.
 *
 * ── DE CONSEQUENTIE-ZIN KOMT UIT DE STAPSOORTEN ──────────────────────
 * Niet uit een tweede, met de hand bijgehouden lijst naast de definitie:
 * `consequencesOf` leest `definition.steps` (inclusief loop-bodies,
 * parallelle takken, switch-cases en inline layers). Drie soorten krijgen een
 * zin, alles wat deze kaart niet kent wordt GETELD en de zin zegt dat er meer
 * gebeurt dan er staat — nooit stilte. Datzelfde geldt voor de trigger-filter:
 * elke sleutel naast `tags` en `reprocessed` maakt de regel smaller dan de zin
 * zegt, en dan zegt de kaart dát.
 *
 * ── DE RUN-TELLING IS PER GEBRUIKER, EN DE ZIN ZEGT HET ──────────────
 * `/_runs/facets` telt `r.user_id = <ik>` — MIJN runs, niet die van de
 * organisatie; de org-variant is een ANDER endpoint met een eigen
 * permissiecheck (`/_runs/org/facets`, `manage_automations`). Een kaart die "3
 * keer gedraaid" zegt terwijl het "3 van jouw runs" is, is precies de telling
 * die over andermans runs zou gaan. Daarom staat "of yours" in de zin en niet
 * in een voetnoot.
 *
 * En: een MISLUKTE facetten-lees toont NIETS — geen 0. Nul en onleesbaar zijn
 * verschillende antwoorden; het paneel zegt één keer bovenaan dat de tellingen
 * niet gelezen konden worden. Is de lees WEL gelukt en staat deze automatisering er
 * niet in, dan is dat een echte nul over een echt bereik, en die zin is
 * expliciet over allebei ("no runs of yours in the last 24 hours").
 *
 * ── GEEN LINK DIE OP EEN 403 UITKOMT ────────────────────────────────
 * `GET /api/automation/:id` weigert met 403 zodra `a.userId !== ik`. De kaart
 * linkt daarom alleen bij `openability(row, ik) === 'ok'`, oftewel alleen als
 * het eigendom POSITIEF vastgesteld is.
 */

// Het venster van de run-telling. Zelfde keuze als AutomationTile: een
// ROLLEND venster van 24 uur, en de zin zegt "in the last 24 hours" en niet
// "today" — een kalenderdag is een ander getal.
const RANGE_HOURS = 24;

// Hoeveel ideeën de composer toont. De server levert er hoogstens zes
// (SUGGEST_MAX_SUGGESTIONS); in een rail van 300px zijn er drie genoeg.
const MAX_IDEAS = 3;

const list = (v) => (Array.isArray(v) ? v : []);

/**
 * De licentiepoort spreekt in MACHINETOKENS, niet in Engelse zinnen.
 *
 * Heel `/api/automation` hangt achter `requireLicenseFeature('automations')`
 * en die middleware antwoordt `{error:'feature_locked'}` (of `'tier_required'`
 * op een 201-pad). `safeText` in useAutomationApi geeft daarvan `j.error`
 * terug, dus `err.message` IS dat token — en `err.status` is er niet, want
 * `send` hangt hem niet aan de Error. Een test op /403|forbidden|licen/ was
 * dus altijd onwaar: de klant kreeg de kale string `feature_locked` in de
 * rode banner en de sleutel `rules_not_licensed` was onbereikbaar.
 */
const LICENCE_TOKENS = new Set(['feature_locked', 'tier_required', 'license_required', 'licence_required']);

export function licenceMessage(err, t) {
    const message = String(err?.message || err || '').trim();
    const locked = LICENCE_TOKENS.has(message)
        || err?.code === 'feature_locked' || err?.code === 'tier_required'
        || err?.status === 402 || err?.status === 403
        || /\blicen[cs]e\b|\bforbidden\b/i.test(message);
    return locked
        ? t('meetings.rules_not_licensed', 'Automations are not part of this plan, so a rule cannot be made here.')
        : null;
}

/* ── zinnen ──────────────────────────────────────────────────────────── */

/**
 * "When a meeting tagged sales, support is finished" — de ALS-helft.
 *
 * "… is finished" is de zin van `meeting.processed`, en die staat er alleen
 * als dát het event is. `meetingTriggersOf` filtert bewust op de PROVIDER en
 * niet op het event, zodat een later `meeting.scheduled` vanzelf in de lijst
 * komt — maar dan zou deze zin over elk toekomstig event het verhaal van
 * `meeting.processed` vertellen. Ook vandaag al bereikbaar: een onbekend
 * app_event-event is voor de validator een WARNING, geen error, dus zo'n
 * definitie slaat op, verschijnt hier, en vuurt nooit.
 */
export function conditionSentence(condition, t) {
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
 * De DAN-helft, als losse stukken (de kaart zet er ` · ` tussen).
 *
 * Losse stukken en geen kant-en-klare zin: een opsomming met "and" ertussen
 * is per taal anders, en de scheider is hier hetzelfde teken dat de rest van
 * dit product tussen feiten zet (AutomationTile).
 */
export function consequenceParts(consequences, t) {
    if (!consequences || consequences.readable === false) {
        return [t('meetings.rules_steps_unreadable', 'its steps could not be read')];
    }
    const parts = [];
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
        // "Geen stappen" en "wel stappen, maar niets wat deze kaart als een
        // gevolg telt" zijn verschillende antwoorden. Ze samen als "has no
        // steps" tonen laat een auteur denken dat zijn werk niet is opgeslagen.
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
 * De run-regel van één kaart, of NULL als er niets te zeggen valt.
 *
 * NULL bij een mislukte of nog lopende lees — nooit een 0, want die zou een
 * bewering zijn over runs die we niet hebben kunnen tellen. Is de lees gelukt
 * en staat de automatisering niet in de facetten, dan is dat een echte nul over een
 * echt bereik en zegt de zin dat óók met zoveel woorden.
 */
export function runLabel({ facets, facetsError, automationId, hours }, t) {
    if (facetsError || !facets) return null;
    const n = runCountOf(facets, automationId);
    // NULL is hier "niemand heeft geteld" (geen automationId-map in het
    // antwoord), niet "nul runs". Dat waren twee verschillende dingen met
    // hetzelfde antwoord, en de kaart maakte er "no runs of yours" van.
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
 * Actief / gepauzeerd / CONCEPT — de gedeelde drie-toestandenwoordenlijst
 * (`components/shared/statusOf.automation`, waar `isDraft` van `isActive`
 * wint). Twee toestanden was hier een echte fout: élke regel die de knop
 * "+ Rule" van dit paneel maakt komt als `is_active=FALSE, is_draft=TRUE` uit
 * de store, en kreeg dus het woord "Paused" — hetzelfde woord als een
 * afgemaakte regel die je bewust hebt uitgezet. De trigger-bus slaat een
 * concept om een ANDERE reden over (`dispatch.js` kijkt naar `!isActive` én
 * naar `isDraft`), en `crud.js` rekent om dezelfde reden `live = isActive &&
 * !isDraft`.
 */
function StateChip({ row, t }) {
    // `undefined` is geen "uit": een rij zonder deze kolommen krijgt geen chip.
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

/** De regel onder de zin: wiens runs het zijn, en of hij te openen is. */
function RuleFooter({ row, runs, open, onOpen, t }) {
    return (
        <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }} data-testid="rule-runs">
                {runs || ''}
            </span>
            {open === 'ok' && typeof onOpen === 'function' ? (
                <button
                    type="button"
                    onClick={() => onOpen(row.id)}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium flex-shrink-0"
                    style={{ color: 'var(--accent-primary)' }}
                    data-testid="rule-open"
                >
                    {t('meetings.rules_open', 'Open automation')}
                    <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                </button>
            ) : open === 'foreign' ? (
                <span className="text-[11px] flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} data-testid="rule-foreign">
                    {t('meetings.rules_someone_elses', 'Someone else’s rule')}
                </span>
            ) : null}
        </div>
    );
}

export function RuleCard({ row, facets, facetsError, hours, currentUserId, onOpen, t }) {
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
                        <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                            {row?.title || t('meetings.rules_untitled', 'Untitled rule')}
                        </span>
                        <StateChip row={row} t={t} />
                    </div>
                    <p className="text-[11px] leading-snug" style={{ color: 'var(--text-secondary)' }} data-testid="rule-sentence">
                        {conditionSentence(condition, t) || t('meetings.rules_when_unknown', 'This rule no longer starts on a meeting note')}
                        {' → '}
                        {parts.join(' · ')}
                    </p>
                    {narrowing.length > 0 && (
                        <p className="text-[11px] leading-snug" style={{ color: 'var(--text-tertiary)' }} data-testid="rule-narrowing">
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

function Composer({ text, onText, ideas, onRun, onUseIdea, creating, t }) {
    return (
        <div className="mx-3 mb-2 px-2.5 py-2 rounded-lg border flex flex-col gap-1.5"
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}>
            <label className="text-[11px]" style={{ color: 'var(--text-tertiary)' }} htmlFor="meeting-rules-composer">
                {t('meetings.rules_ai_hint', 'Say what should happen after a meeting; the ideas stay inside meeting notes.')}
            </label>
            <input
                id="meeting-rules-composer"
                type="text"
                value={text}
                onChange={(e) => onText(e.target.value)}
                placeholder={t('meetings.rules_ai_placeholder', 'put the decisions in the sales knowledge base')}
                className="w-full px-2 py-1 rounded-md border text-[12px]"
                style={{ borderColor: 'var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
            />
            <button
                type="button" onClick={onRun} disabled={ideas.busy}
                className={`${smallButton} self-start`}
                style={{ borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }}
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
            {ideas.items.map((idea, i) => (
                <div key={idea?.id ?? `idea-${i}`} className="px-2 py-1.5 rounded-md border flex flex-col gap-1"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }} data-testid="rules-idea">
                    <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{idea?.title}</span>
                    {idea?.description && (
                        <span className="text-[11px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>{idea.description}</span>
                    )}
                    <button
                        type="button" onClick={() => onUseIdea(idea)} disabled={creating}
                        className={`${smallButton} self-start`}
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
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
}) {
    const { t } = useTranslation();
    const api = useAutomationApi();

    const [rules, setRules] = useState({ loading: true, error: null, rows: null });
    const [runs, setRuns] = useState({ loading: true, error: null, facets: null, hours: RANGE_HOURS });
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState(null);

    const [composerOpen, setComposerOpen] = useState(false);
    const [composerText, setComposerText] = useState('');
    // `ran` scheidt "nog niet gevraagd" van "gevraagd en niets gekregen" — de
    // banner hieronder gaat alleen over dat tweede.
    const [ideas, setIdeas] = useState({ busy: false, ran: false, error: null, reason: null, items: [] });
    const abortRef = useRef(null);

    const loadRules = useCallback(async () => {
        setRules(s => ({ ...s, loading: true, error: null }));
        try {
            const body = await api.listAutomations({ triggerProvider: RULE_TRIGGER_PROVIDER });
            setRules({ loading: false, error: null, rows: list(body?.automations) });
        } catch (err) {
            // Geen lege lijst bij een fout: "geen regels" en "ik kon het niet
            // lezen" zijn verschillende antwoorden.
            setRules({ loading: false, error: err, rows: null });
        }
    }, [api]);

    const loadRuns = useCallback(async () => {
        setRuns(s => ({ ...s, loading: true, error: null }));
        try {
            // `mode: 'live'` — een DRY-RUN is geen run die vanzelf draait, en de
            // kop van dit paneel zegt precies dat ("What runs by itself once a
            // meeting note is ready"). Zonder mode telt `parseRunFilters` alle
            // modi mee, terwijl de store-helper die dezelfde vraag elders
            // beantwoordt wél `mode = 'live'` als default kiest.
            const body = await api.getRunFacets({ range: RANGE_HOURS, mode: 'live' });
            // De server klemt `range` op [1,720] en kan dus een ANDER venster
            // terugmelden dan gevraagd; de zin noemt dat getal, dus hij komt uit
            // het antwoord en niet uit de constante.
            const hours = Number.isFinite(body?.rangeHours) ? body.rangeHours : RANGE_HOURS;
            setRuns({ loading: false, error: null, facets: body?.facets ?? null, hours });
        } catch (err) {
            setRuns({ loading: false, error: err, facets: null, hours: RANGE_HOURS });
        }
    }, [api]);

    const load = useCallback(() => { setCreateError(null); loadRules(); loadRuns(); }, [loadRules, loadRuns]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => () => { try { abortRef.current?.abort(); } catch { /* al gesloten */ } }, []);

    // Onleesbaar is niet nul. Een 200 met een body zonder `automationId`-map is
    // geen "geen runs" maar "niemand heeft geteld"; die landde stilzwijgend als
    // een nul op elke kaart terwijl de banner uitbleef.
    const runsUnreadable = !runs.loading && (!!runs.error || !facetsReadable(runs.facets));

    const rows = rules.rows;
    // Pas melden als de lijst er echt is; tijdens het laden en na een fout
    // draagt het segment geen getal in plaats van een 0 die "geen" leest.
    const ruleCount = rows ? rows.length : null;
    useEffect(() => { onRulesChange?.(ruleCount); }, [ruleCount, onRulesChange]);

    const openRule = useCallback((id) => {
        const href = ruleHref(id);
        if (href && typeof onNavigate === 'function') onNavigate(href);
    }, [onNavigate]);

    const createRule = useCallback(async ({ title, description } = {}) => {
        setCreating(true);
        setCreateError(null);
        try {
            const created = await api.createAutomation({
                title: title || 'New meeting rule',
                description: description || 'Runs when a meeting note is ready.',
                triggerType: 'app_event',
                definition: newRuleDefinition(),
            });
            const id = created?.automation?.id || created?.id || null;
            await loadRules();
            if (id) openRule(id);
        } catch (err) {
            setCreateError(licenceMessage(err, t) || String(err?.message || err));
        } finally {
            setCreating(false);
        }
    }, [api, loadRules, openRule, t]);

    const askAi = useCallback(async () => {
        try { abortRef.current?.abort(); } catch { /* geen lopende scan */ }
        const controller = new AbortController();
        abortRef.current = controller;
        setIdeas({ busy: true, ran: false, error: null, reason: null, items: [] });
        let done = null;
        try {
            await api.suggestAutomationsStream(
                // Geen integratiekeuze: leeg betekent server-side "alles wat
                // deze gebruiker heeft", en de scope zit in de seed.
                // Ideas mode: the model proposes rules; the default pattern
                // scan only reports work the user already repeats.
                { mode: 'ideas', integrationIds: [], focus: composerSeed(composerText) },
                (event, data) => {
                    if (event === 'done') done = data;
                    else if (event === 'error') setIdeas(s => ({ ...s, error: data?.error || null }));
                },
                controller.signal,
            );
            const items = list(done?.suggestions).slice(0, MAX_IDEAS);
            setIdeas(s => ({
                busy: false,
                ran: true,
                error: s.error
                    // EEN STREAM DIE ZONDER `done` EINDIGT IS GEEN LEGE UITSLAG.
                    // Een afgekapte verbinding of een crash na de headers gaf
                    // 0 kaarten, geen banner en een knop die weer op "Get
                    // ideas" stond: "onbekend" en "niets gevonden" werden
                    // hetzelfde scherm.
                    || (done ? null : t('meetings.rules_ai_cut_off', 'The scan stopped before it finished, so this is not an answer — try again.')),
                reason: done?.reason || null,
                items,
            }));
        } catch (err) {
            if (controller.signal.aborted) return;
            const retry = Number(err?.retryAfter);
            setIdeas({
                busy: false,
                ran: true,
                reason: null,
                items: [],
                error: err?.status === 429 || Number.isFinite(retry)
                    ? t('meetings.rules_ai_busy', 'Too many scans just now — try again in a moment.')
                    : (err?.message || t('meetings.rules_ai_failed', 'Could not come up with ideas right now.')),
            });
        }
    }, [api, composerText, t]);

    const startIdea = useCallback((suggestion) => {
        // De composer LEVERT een spec, hij bouwt niets: de aanroeper mag hem in
        // de bouw-assistent laten vallen. Kan die dat niet, dan blijft er iets
        // bruikbaars over — een concept met de juiste trigger, de titel en de
        // omschrijving van het idee. De prompt zelf gaat nooit in `description`:
        // dat veld is een zin voor mensen, geen opdracht voor een model.
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
                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
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
                    type="button" onClick={() => setComposerOpen(v => !v)} disabled={creating}
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
                        <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('meetings.rules_loading', 'Loading rules…')}</span>
                    </div>
                )}

                {!loading && rules.error && (
                    <div className="flex flex-col gap-1 px-3 py-2.5 rounded-lg border text-[11px] mb-1" style={ERROR_BANNER} data-testid="rules-error">
                        <div className="font-semibold">{t('meetings.rules_failed', 'Couldn’t load the rules for meeting notes')}</div>
                        <div style={{ color: 'var(--text-secondary)' }}>
                            {licenceMessage(rules.error, t) || rules.error.message}
                        </div>
                    </div>
                )}

                {/* Eén keer bovenaan, niet per kaart: de tellingen ontbreken
                    allemaal om dezelfde reden, en een 0 per kaart zou een
                    bewering zijn over runs die niemand heeft kunnen tellen. */}
                {!loading && !rules.error && !runs.loading && runsUnreadable && (
                    <div className="flex items-start gap-2 px-3 py-2 mb-1 rounded-lg border text-[11px]" style={WARN_BANNER} data-testid="rules-runs-error">
                        <AlertCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
                        <span>{t('meetings.rules_runs_unreadable', 'Couldn’t read how often these ran, so no rule shows a count.')}</span>
                    </div>
                )}

                {!loading && !rules.error && emptyRules && (
                    <div className="flex flex-col items-center gap-2 px-3 py-8 text-center" data-testid="rules-empty">
                        <div className="w-12 h-12 rounded-2xl grid place-items-center"
                            style={{ background: kindTint('automation', 12), color: kindColorVar('automation') }} aria-hidden="true">
                            <Workflow className="w-6 h-6" />
                        </div>
                        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('meetings.rules_empty_title', 'No rules yet')}</div>
                        <div className="text-[11px] max-w-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {t('meetings.rules_empty_desc', 'A rule picks up a meeting note the moment it is ready — files it, passes it on, or tells someone.')}
                        </div>
                    </div>
                )}

                {list(rows).map((row) => (
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

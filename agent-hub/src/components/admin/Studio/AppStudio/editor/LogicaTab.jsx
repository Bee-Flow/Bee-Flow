import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ExternalLink, Plus, Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAutomationRows } from './automationTitles';
import logicRows, { assignNotices, collectBoundTableIds, routineRows } from './logicRows';
import { toSaveNotices } from './saveNotices';
import useTranslation from '../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import { kindColorVar } from '../../../../shared/kindColors';
import { nOf } from '../../KnowledgeStudio/plural';
import { automationHref } from '../inspector/AutomationTile';
import RoutinePicker from '../inspector/RoutinePicker';
import { getComponentEntry } from '../runtime/componentRegistry';
import { setAction } from '../state/definitionOps';

/**
 * De Logica-tab — Wanneer · Gebeurt · Status · ↗, over alle schermen heen.
 *
 * Vervangt LogicView, die alleen bedrade NODE_EVENTS opsomde. Wat die weg liet
 * vallen (onbedrade slots, de vier lijst-oppervlakken, acties waar niets naar
 * wijst) staat in editor/logicRows.js beschreven; dit bestand tekent het en
 * haalt de twee dingen op die de definitie NIET weet — hoe vaak er gedraaid is
 * en hoeveel beslissingen er wachten.
 *
 * ── De statuskolom mag niets beweren ──────────────────────────────────────
 * Beide tellingen zijn KIJKERGESCOOPT, en dat is geen detail:
 *
 *   runs      GET /api/automation/_runs/facets telt de runs van de INGELOGDE
 *             gebruiker over een ROLLEND venster van 24 uur (runs.js: "Always
 *             scoped to the requesting user — no admin-wide endpoint"). Het is
 *             dus niet "38 vandaag": niet vandaag (een kalenderdag is een
 *             ander getal) en niet van iedereen. De zin zegt allebei hardop.
 *             De org-brede tweeling (/_runs/org/facets) wordt hier BEWUST niet
 *             gebruikt — die zou een getal tonen over runs van collega's die
 *             de lezer nergens kan openen.
 *   approvals GET /api/automation/approvals/facets?scope=mine telt alleen de
 *             beslissingen waar de kijker zelf een zetel in heeft. De
 *             app-brede teller die de server óók heeft
 *             (countPendingApprovalsForApp) is een quotumrem zonder enige
 *             kijkerscoping: dat getal tonen betekent "1 wacht" naast een
 *             lijst die leeg blijft als je hem opent.
 *
 * En: onbekend is geen nul. Approvals zit achter een licentie- én modulepoort
 * (approvals.js), dus 403/404 is een normaal antwoord op een gezonde
 * installatie. Een mislukte lezing schrijft "Not available" — niet "0", want
 * "er wacht niets" en "ik mocht niet kijken" zijn verschillende dingen en het
 * verschil is precies wat iemand moet weten.
 *
 * NB voor wie hier een test omheen zet: dit is de eerste editor-VIEW die
 * react-query gebruikt (de Data-view deed het al via TablesManager, maar pas
 * ná een klik). De app-shell heeft zijn QueryClientProvider in main.jsx, dus
 * in productie is er niets te regelen; een test die deze tab mount heeft er
 * zelf een nodig.
 */

const RANGE_HOURS = 24;

/** De facets van de EIGEN runs over het venster, of null als het niet gelezen kon worden. */
async function fetchRunFacets() {
    const res = await authFetch(`${API_BASE}/api/automation/_runs/facets?range=${RANGE_HOURS}`);
    if (!res.ok) return null;
    try { return (await res.json())?.facets ?? null; } catch { return null; }
}

/** De approval-facets voor deze app, kijkergescoopt, of null bij een weigering. */
async function fetchApprovalFacets(appId) {
    const res = await authFetch(
        `${API_BASE}/api/automation/approvals/facets?scope=mine&appId=${encodeURIComponent(appId)}`,
    );
    if (!res.ok) return null;
    try { return (await res.json())?.facets ?? null; } catch { return null; }
}

/**
 * Runs voor één routine. `null` = niet gelezen; een getal = gelezen.
 *
 * getRunFacetsScoped geeft de vier maps ALTIJD terug, ook leeg — een routine
 * die niet in `automationId` staat heeft dus echt nul runs gehad in het
 * venster, en dat is een gelezen antwoord. Ontbreekt de map zelf, dan is de
 * vorm onbekend en is er niets gelezen.
 */
export function runCountOf(facets, automationId) {
    if (!facets || typeof facets !== 'object') return null;
    const byId = facets.automationId;
    if (!byId || typeof byId !== 'object') return null;
    const n = byId[automationId];
    return Number.isFinite(n) ? n : 0;
}

/** Wachtende beslissingen voor de kijker. `null` = niet gelezen. */
export function pendingCountOf(facets) {
    if (!facets || typeof facets !== 'object') return null;
    const status = facets.status;
    if (!status || typeof status !== 'object') return null;
    const n = status.pending;
    return Number.isFinite(n) ? n : 0;
}

/** De kleur van een rij: een routine draagt de automation-familie, de rest die van de app. */
function rowColor(row) {
    return row.actionKind === 'run_automation' ? kindColorVar('automation') : kindColorVar('app');
}

export default function LogicaTab({
    app,
    definition,
    onCommit,
    onReveal,
    saveNotices = null,
    disabled = false,
}) {
    const { t } = useTranslation();
    const [pickerOpen, setPickerOpen] = useState(false);

    // Eén gedeeld verzoek per sessie (module-cache in automationTitles.js) —
    // de kolom "Gebeurt" naamt er routines mee en de sectie hieronder leest er
    // projectId en stappen uit.
    const automationRows = useAutomationRows(true);
    const titleFor = useMemo(
        () => (id) => (automationRows && automationRows[id]?.title) || null,
        [automationRows],
    );

    const rows = useMemo(() => logicRows(definition, { titleFor, t }), [definition, titleFor, t]);
    const boundTableIds = useMemo(() => collectBoundTableIds(definition?.screens), [definition]);
    const wiredAutomationIds = useMemo(
        () => new Set(rows.map((r) => r.automationId).filter(Boolean)),
        [rows],
    );
    const routines = useMemo(
        () => routineRows({ app, automationRows, boundTableIds, wiredAutomationIds, t }),
        [app, automationRows, boundTableIds, wiredAutomationIds, t],
    );

    const notices = useMemo(() => toSaveNotices(saveNotices), [saveNotices]);
    const noticesByRow = useMemo(() => assignNotices(rows, notices), [rows, notices]);

    const automationIds = useMemo(
        () => new Set([...rows, ...routines].map((r) => r.automationId).filter(Boolean)),
        [rows, routines],
    );
    const needsRuns = automationIds.size > 0;
    const needsApprovals = useMemo(() => rows.some((r) => r.nodeType === 'approval_list'), [rows]);

    const runsQuery = useQuery({
        queryKey: ['studio-app-logic-runs', app?.id || null],
        queryFn: fetchRunFacets,
        enabled: needsRuns,
        staleTime: 30_000,
        retry: false,
    });
    const approvalsQuery = useQuery({
        queryKey: ['studio-app-logic-approvals', app?.id || null],
        queryFn: () => fetchApprovalFacets(app.id),
        enabled: needsApprovals && !!app?.id,
        staleTime: 30_000,
        retry: false,
    });

    /**
     * Wat er in de statuskolom staat. Vier toestanden, en drie ervan tekenen
     * bewust NIETS of het woord "onbekend" — nooit een getal dat we niet
     * hebben.
     */
    const statusOf = (row) => {
        if (row.automationId) {
            if (!needsRuns || runsQuery.isPending) return { state: 'loading' };
            const n = runCountOf(runsQuery.data, row.automationId);
            if (n === null) return { state: 'unknown' };
            return {
                state: 'known',
                text: nOf(
                    t, 'app_studio.logic.status_runs', n,
                    '{count} run by you in the last 24 hours',
                    '{count} runs by you in the last 24 hours',
                ),
            };
        }
        if (row.nodeType === 'approval_list') {
            if (!needsApprovals || !app?.id || approvalsQuery.isPending) return { state: 'loading' };
            const n = pendingCountOf(approvalsQuery.data);
            if (n === null) return { state: 'unknown' };
            return {
                state: 'known',
                text: nOf(
                    t, 'app_studio.logic.status_waiting', n,
                    '{count} decision waiting for you',
                    '{count} decisions waiting for you',
                ),
            };
        }
        return { state: 'none' };
    };

    const addRoutine = (automation) => {
        setPickerOpen(false);
        if (!automation?.id || typeof onCommit !== 'function') return;
        // De actie komt binnen zonder dat er iets naar wijst. Dat is precies
        // wat er is gebeurd, dus verschijnt hij als onbedrade rij ("Nothing
        // starts this yet") in plaats van hem stilletjes ergens aan te hangen.
        const { def } = setAction(definition, null, { kind: 'run_automation', automationId: automation.id });
        onCommit(def);
    };

    const byScreen = useMemo(() => {
        const groups = [];
        const index = new Map();
        for (const row of rows) {
            const key = row.screenId || '__app__';
            if (!index.has(key)) {
                const group = { key, name: row.screenName || '', rows: [] };
                index.set(key, group);
                groups.push(group);
            }
            index.get(key).rows.push(row);
        }
        return groups;
    }, [rows]);

    const empty = rows.length === 0 && routines.length === 0;

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-editor-view="logic">
            <div className="mx-auto w-full max-w-5xl p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {t('app_studio.views.logic_title', 'What happens in this app')}
                        </h2>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {t('app_studio.views.logic_desc', 'Every component that does something, by screen. Select one to change it.')}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setPickerOpen(true)}
                        disabled={disabled}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                    >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('app_studio.logic.add_automation', 'Add an automation')}
                    </button>
                </div>

                {empty ? (
                    <p
                        className="rounded-lg border border-dashed px-4 py-6 text-center text-xs"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
                    >
                        {t('app_studio.views.logic_empty', 'Nothing is wired yet — select a button on the canvas and choose what it should do.')}
                    </p>
                ) : (
                    <LogicTable
                        groups={byScreen}
                        routines={routines}
                        statusOf={statusOf}
                        noticesByRow={noticesByRow}
                        onReveal={onReveal}
                        t={t}
                    />
                )}
            </div>

            <RoutinePicker
                open={pickerOpen}
                onClose={() => setPickerOpen(false)}
                onPick={addRoutine}
            />
        </div>
    );
}

/** Eén regel van de tabel. Onbedraad = gestippeld, nooit weggelaten. */
function LogicRow({ row, status, notices, onReveal, t }) {
    const entry = row.nodeType ? getComponentEntry(row.nodeType) : null;
    const Icon = entry?.icon || Workflow;

    return (
        <tr
            data-logic-row={row.kind}
            data-logic-wired={row.wired ? 'true' : 'false'}
            className="align-top"
            style={{ color: 'var(--text-primary)' }}
        >
            <td className="px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                    <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: rowColor(row) }} aria-hidden="true" />
                    <span className="min-w-0">
                        <span className="block">{row.when}</span>
                        {row.nodeType || row.surfaceLabel ? (
                            <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                {[entry?.label || row.nodeType, row.surfaceLabel].filter(Boolean).join(' · ')}
                            </span>
                        ) : null}
                    </span>
                </span>
            </td>

            <td className="px-3 py-2">
                {row.wired ? (
                    <span style={{ color: rowColor(row) }}>{row.what}</span>
                ) : (
                    <span
                        className="inline-block rounded border border-dashed px-1.5 py-0.5"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
                    >
                        {row.what}
                    </span>
                )}
                {notices.map((n, i) => (
                    <span
                        key={`${n.code}-${i}`}
                        className="mt-1 block text-[11px]"
                        data-logic-notice={n.kind}
                        style={{ color: n.kind === 'error' ? 'var(--error)' : 'var(--text-secondary)' }}
                    >
                        {n.message}
                    </span>
                ))}
            </td>

            <StatusCell status={status} t={t} />

            <JumpCell row={row} onReveal={onReveal} t={t} />
        </tr>
    );
}

/**
 * De statuskolom. Drie van de vier toestanden tekenen geen getal, en dat is de
 * hele bedoeling: "loading" heeft nog geen antwoord, "none" hoort geen
 * telling te hebben, en "unknown" is een lezing die NIET gelukt is. Alleen
 * "known" zet er een getal neer.
 */
function StatusCell({ status, t }) {
    return (
        <td className="px-3 py-2" data-logic-status={status.state}>
            {status.state === 'known' ? (
                <span style={{ color: 'var(--text-secondary)' }}>{status.text}</span>
            ) : null}
            {status.state === 'unknown' ? (
                // Geen streepje en geen nul: het woord zelf, want het verschil
                // met "er is niets" is de hele mededeling.
                <span style={{ color: 'var(--text-tertiary)' }}>
                    {t('app_studio.logic.status_unknown', 'Not available')}
                </span>
            ) : null}
        </td>
    );
}

/**
 * ↗ betekent overal "breng me erheen". Voor een rij die op een component zit is
 * dat het canvas — ook als er een routine achter hangt, want de bedrading
 * verander je bij de knop. Alleen een rij zónder component (een routine van
 * deze oplossing, een actie waar niets naar wijst) heeft geen plek op het
 * canvas en linkt naar de Automations-builder.
 */
function JumpCell({ row, onReveal, t }) {
    const canReveal = typeof onReveal === 'function' && !!row.screenId;
    const href = row.automationId ? automationHref(row.automationId) : null;
    return (
        <td className="px-3 py-2 text-right">
            {canReveal ? (
                <button
                    type="button"
                    onClick={() => onReveal({ screenId: row.screenId, nodeId: row.nodeId })}
                    className="inline-flex items-center rounded p-0.5 hover:bg-[var(--bg-tertiary)]"
                    aria-label={t('app_studio.logic.show_me', 'Show me')}
                >
                    <ArrowUpRight className="h-3.5 w-3.5" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                </button>
            ) : href ? (
                <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center rounded p-0.5 hover:bg-[var(--bg-tertiary)]"
                    aria-label={t('app_studio.inspector.tile_open', 'Open')}
                >
                    <ExternalLink className="h-3.5 w-3.5" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                </a>
            ) : null}
        </td>
    );
}

/** De kop van een groep rijen — een scherm, of de routinesectie. */
function GroupHeading({ title, hint = null }) {
    return (
        <tr>
            <th
                scope="colgroup"
                colSpan={4}
                className="border-t px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
            >
                {title}
                {hint ? (
                    <span className="block text-[11px] font-normal normal-case tracking-normal" style={{ color: 'var(--text-tertiary)' }}>
                        {hint}
                    </span>
                ) : null}
            </th>
        </tr>
    );
}

/** Wanneer · Gebeurt · Status · ↗, per scherm gegroepeerd, routines onderaan. */
function LogicTable({ groups, routines, statusOf, noticesByRow, onReveal, t }) {
    return (
        <table className="w-full border-collapse text-left text-xs" data-logic-table>
            <thead>
                <tr style={{ color: 'var(--text-tertiary)' }}>
                    <th scope="col" className="w-[26%] px-3 py-1.5 font-medium">
                        {t('app_studio.logic.col_when', 'When')}
                    </th>
                    <th scope="col" className="px-3 py-1.5 font-medium">
                        {t('app_studio.logic.col_happens', 'What happens')}
                    </th>
                    <th scope="col" className="w-[24%] px-3 py-1.5 font-medium">
                        {t('app_studio.logic.col_status', 'Status')}
                    </th>
                    <th scope="col" className="w-8 px-3 py-1.5 font-medium">
                        <span className="sr-only">{t('app_studio.logic.col_open', 'Open')}</span>
                    </th>
                </tr>
            </thead>

            {groups.map((group) => (
                <tbody key={group.key}>
                    <GroupHeading title={group.name || t('app_studio.logic.group_app', 'This app')} />
                    {group.rows.map((row) => (
                        <LogicRow
                            key={row.key}
                            row={row}
                            status={statusOf(row)}
                            notices={noticesByRow.get(row.key) || []}
                            onReveal={onReveal}
                            t={t}
                        />
                    ))}
                </tbody>
            ))}

            {routines.length ? (
                <tbody data-logic-routines>
                    {/* "Jouw" staat in de kop omdat de lijst het zegt. De rijen
                        komen uit GET /api/automation → getAutomationsForUser
                        (`WHERE user_id = $1`), dus dit zijn de routines die de
                        KIJKER bezit. De nachtelijke routine van een collega, in
                        dezelfde oplossing en op dezelfde tabel, staat er niet —
                        en een lege sectie is niet te onderscheiden van "die zijn
                        er niet". Versmallen mag; er stilzwijgend "Routines in
                        this solution" boven zetten niet. */}
                    <GroupHeading
                        title={t('app_studio.logic.routines_title', 'Your routines in this solution')}
                        hint={t(
                            'app_studio.logic.routines_desc',
                            'Routines you own, filed in the same solution and working on the tables this app is bound to. They are not wired to a button — they run on their own. Routines owned by someone else are not listed here.',
                        )}
                    />
                    {routines.map((row) => (
                        <LogicRow key={row.key} row={row} status={statusOf(row)} notices={[]} onReveal={onReveal} t={t} />
                    ))}
                </tbody>
            ) : null}
        </table>
    );
}

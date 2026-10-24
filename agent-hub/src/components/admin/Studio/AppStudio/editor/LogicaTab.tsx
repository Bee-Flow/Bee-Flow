import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ExternalLink, Plus, Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAutomationRows } from './automationTitles';
import logicRows, { assignNotices, collectBoundTableIds, derivedAutomationRows } from './logicRows';
import { toSaveNotices, type SavePayload, type SaveNotice } from './saveNotices';
import useTranslation from '../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import { kindColorVar } from '../../../../shared/kindColors';
import { nOf } from '../../KnowledgeStudio/plural';
import { automationHref } from '../inspector/AutomationTile';
import AutomationPicker from '../inspector/AutomationPicker';
import { getComponentEntry } from '../runtime/componentRegistry';
import { setAction } from '../state/definitionOps';
import type { AppDefinition } from '../inspector/appDefinition';
import type { WiredAutomation } from '../inspector/useEventWiring';
import type { TranslateParams } from '../../../../../hooks/useTranslation';
import type { TFn, LogicTableRow, RowStatus, RevealFn, LogicaTabProps, LogicRowProps, StatusCellProps, GroupHeadingProps, LogicTableProps } from './LogicaTab.types';

/**
 * The Logic tab — When · Happens · Status · ↗, across all screens.
 *
 * Replaces LogicView, which listed only wired NODE_EVENTS. What that one dropped (unwired slots, the four
 * list surfaces, actions that nothing points to) is described in editor/logicRows.js; this file draws it and
 * fetches the two things the definition does NOT know — how often it has run and how many decisions are waiting.
 *
 * ── The status column may not claim anything ──────────────────────────────
 * Both counts are VIEWER-SCOPED, and that is no detail:
 *
 *   runs      GET /api/automation/_runs/facets counts the runs of the LOGGED-IN user over a ROLLING window of
 *             24 hours (runs.js: "Always scoped to the requesting user — no admin-wide endpoint"). So it is not
 *             "38 today": not today (a calendar day is a different number) and not of everyone. The sentence says
 *             both out loud. The org-wide twin (/_runs/org/facets) is deliberately NOT used here — it would show
 *             a number over runs of colleagues that the reader cannot open anywhere.
 *   approvals GET /api/automation/approvals/facets?scope=mine counts only the decisions in which the viewer
 *             themselves has a seat. The app-wide count that the server ALSO has (countPendingApprovalsForApp) is
 *             a quota brake with no viewer scoping at all: showing that number means "1 waiting" next to a list
 *             that stays empty when you open it.
 *
 * And: unknown is not zero. Approvals sits behind a licence AND module gate (approvals.js), so 403/404 is a
 * normal answer on a healthy installation. A failed reading writes "Not available" — not "0", because "nothing is
 * waiting" and "I was not allowed to look" are different things, and the difference is precisely what someone
 * needs to know.
 *
 * NB for anyone wrapping a test around this: this is the first editor VIEW that uses react-query (the Data
 * view did already via TablesManager, but only after a click). The app shell has its QueryClientProvider in
 * main.jsx, so in production there is nothing to arrange; a test that mounts this tab must supply one itself.
 */

const RANGE_HOURS = 24;

/** The facets of the OWN runs over the window, or null if they could not be read. */
async function fetchRunFacets() {
    const res = await authFetch(`${API_BASE}/api/automation/_runs/facets?range=${RANGE_HOURS}`);
    if (!res.ok) return null;
    try { return (await res.json())?.facets ?? null; } catch { return null; }
}

/** The approval facets for this app, viewer-scoped, or null on a refusal. */
async function fetchApprovalFacets(appId: string) {
    const res = await authFetch(
        `${API_BASE}/api/automation/approvals/facets?scope=mine&appId=${encodeURIComponent(appId)}`,
    );
    if (!res.ok) return null;
    try { return (await res.json())?.facets ?? null; } catch { return null; }
}

/**
 * Runs for one automation. `null` = not read; a number = read.
 *
 * getRunFacetsScoped always returns the four maps, even when empty — so an automation that is not in
 * `automationId` really had zero runs in the window, and that is a read answer. If the map itself is
 * missing, the shape is unknown and nothing was read.
 */
export function runCountOf(facets: { automationId?: Record<string, number> } | null, automationId: string) {
    if (!facets || typeof facets !== 'object') return null;
    const byId = facets.automationId;
    if (!byId || typeof byId !== 'object') return null;
    const n = byId[automationId];
    return Number.isFinite(n) ? n : 0;
}

/** Wachtende beslissingen voor de kijker. `null` = niet gelezen. */
export function pendingCountOf(facets: { status?: { pending?: number } } | null) {
    if (!facets || typeof facets !== 'object') return null;
    const status = facets.status;
    if (!status || typeof status !== 'object') return null;
    const n = status.pending;
    return Number.isFinite(n) ? n : 0;
}

/** De kleur van een rij: een automatisering draagt de automation-familie, de rest die van de app. */
function rowColor(row: { actionKind: string | null }) {
    return row.actionKind === 'run_automation' ? kindColorVar('automation') : kindColorVar('app');
}

export default function LogicaTab({
    app,
    definition,
    onCommit,
    onReveal,
    saveNotices = null,
    disabled = false,
}: LogicaTabProps) {
    const { t } = useTranslation();
    const [pickerOpen, setPickerOpen] = useState(false);

    // Eén gedeeld verzoek per sessie (module-cache in automationTitles.js) —
    // de kolom "Gebeurt" naamt er automatiseringen mee en de sectie hieronder leest er
    // projectId en stappen uit.
    const automationRows = useAutomationRows(true);
    const titleFor = useMemo(
        () => (id?: string | null) => (automationRows && automationRows[id ?? '']?.title) || null,
        [automationRows],
    );

    const rows = useMemo(() => logicRows(definition, { titleFor, t }), [definition, titleFor, t]);
    const boundTableIds = useMemo(() => collectBoundTableIds(definition?.screens), [definition]);
    const wiredAutomationIds = useMemo(
        () => new Set(rows.map((r) => r.automationId).filter((id): id is string => !!id)),
        [rows],
    );
    const automations = useMemo(
        () => derivedAutomationRows({ app, automationRows, boundTableIds, wiredAutomationIds, t }),
        [app, automationRows, boundTableIds, wiredAutomationIds, t],
    );

    const notices = useMemo(() => toSaveNotices(saveNotices), [saveNotices]);
    const noticesByRow = useMemo(() => assignNotices(rows, notices), [rows, notices]);

    const automationIds = useMemo(
        () => new Set([...rows, ...automations].map((r) => r.automationId).filter(Boolean)),
        [rows, automations],
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
     * What goes in the status column. Four states, and three of them deliberately draw NOTHING or the word
     * "unknown" — never a number we do not have.
     */
    const statusOf = (row: { automationId: string | null; nodeType: string | null }): RowStatus => {
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

    const addAutomation = (automation: WiredAutomation) => {
        setPickerOpen(false);
        if (!automation?.id || typeof onCommit !== 'function') return;
        // De actie komt binnen zonder dat er iets naar wijst. Dat is precies
        // wat er is gebeurd, dus verschijnt hij als onbedrade rij ("Nothing
        // starts this yet") in plaats van hem stilletjes ergens aan te hangen.
        const { def } = setAction(definition, null, { kind: 'run_automation', automationId: automation.id });
        onCommit(def);
    };

    const byScreen = useMemo(() => {
        const groups: { key: string; name: string; rows: LogicTableRow[] }[] = [];
        const index = new Map<string, { key: string; name: string; rows: LogicTableRow[] }>();
        for (const row of rows) {
            const key = row.screenId || '__app__';
            if (!index.has(key)) {
                const group = { key, name: row.screenName || '', rows: [] };
                index.set(key, group);
                groups.push(group);
            }
            index.get(key)?.rows.push(row);
        }
        return groups;
    }, [rows]);

    const empty = rows.length === 0 && automations.length === 0;

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-editor-view="logic">
            <div className="mx-auto w-full max-w-5xl p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                            {t('app_studio.views.logic_title', 'What happens in this app')}
                        </h2>
                        <p className="text-xs text-[var(--text-tertiary)]">
                            {t('app_studio.views.logic_desc', 'Every component that does something, by screen. Select one to change it.')}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setPickerOpen(true)}
                        disabled={disabled}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
                    >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('app_studio.logic.add_automation', 'Add an automation')}
                    </button>
                </div>

                {empty ? (
                    <p
                        className="rounded-lg border border-dashed px-4 py-6 text-center text-xs border-[var(--border-default)] text-[var(--text-tertiary)]"
                    >
                        {t('app_studio.views.logic_empty', 'Nothing is wired yet — select a button on the canvas and choose what it should do.')}
                    </p>
                ) : (
                    <LogicTable
                        groups={byScreen}
                        automations={automations}
                        statusOf={statusOf}
                        noticesByRow={noticesByRow}
                        onReveal={onReveal}
                        t={t}
                    />
                )}
            </div>

            <AutomationPicker
                open={pickerOpen}
                onClose={() => setPickerOpen(false)}
                onPick={addAutomation}
            />
        </div>
    );
}

function LogicRow({ row, status, notices, onReveal, t }: LogicRowProps) {
    const entry = row.nodeType ? getComponentEntry(row.nodeType) : null;
    const Icon = entry?.icon || Workflow;

    return (
        <tr
            data-logic-row={row.kind}
            data-logic-wired={row.wired ? 'true' : 'false'}
            className="align-top text-[var(--text-primary)]"
        >
            <td className="px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                    <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: rowColor(row) }} aria-hidden="true" />
                    <span className="min-w-0">
                        <span className="block">{row.when}</span>
                        {row.nodeType || row.surfaceLabel ? (
                            <span className="block text-[11px] text-[var(--text-tertiary)]">
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
                        className="inline-block rounded border border-dashed px-1.5 py-0.5 border-[var(--border-default)] text-[var(--text-tertiary)]"
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

function StatusCell({ status, t }: StatusCellProps) {
    return (
        <td className="px-3 py-2" data-logic-status={status.state}>
            {status.state === 'known' ? (
                <span className="text-[var(--text-secondary)]">{status.text}</span>
            ) : null}
            {status.state === 'unknown' ? (
                // No dash and no zero: the word itself, because the difference from "there is nothing" is the whole message.
                <span className="text-[var(--text-tertiary)]">
                    {t('app_studio.logic.status_unknown', 'Not available')}
                </span>
            ) : null}
        </td>
    );
}

/**
 * ↗ means "take me there" everywhere. For a row that sits on a component that is the canvas — also when an
 * automation is behind it, because the wiring is changed at the button. Only a row WITHOUT a component (an
 * automation of this solution, an action that nothing points to) has no place on the canvas and links to the
 * Automations builder.
 */
function JumpCell({ row, onReveal, t }: { row: LogicTableRow; onReveal?: RevealFn; t: TFn }) {
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
                    <ArrowUpRight className="h-3.5 w-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                </button>
            ) : href ? (
                <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center rounded p-0.5 hover:bg-[var(--bg-tertiary)]"
                    aria-label={t('app_studio.inspector.tile_open', 'Open')}
                >
                    <ExternalLink className="h-3.5 w-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                </a>
            ) : null}
        </td>
    );
}

function GroupHeading({ title, hint = null }: GroupHeadingProps) {
    return (
        <tr>
            <th
                scope="colgroup"
                colSpan={4}
                className="border-t px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide border-[var(--border-default)] text-[var(--text-secondary)]"
            >
                {title}
                {hint ? (
                    <span className="block text-[11px] font-normal normal-case tracking-normal text-[var(--text-tertiary)]">
                        {hint}
                    </span>
                ) : null}
            </th>
        </tr>
    );
}

function LogicTable({ groups, automations, statusOf, noticesByRow, onReveal, t }: LogicTableProps) {
    return (
        <table className="w-full border-collapse text-left text-xs" data-logic-table>
            <thead>
                <tr className="text-[var(--text-tertiary)]">
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

            {automations.length ? (
                <tbody data-logic-automations>
                    {/* "Yours" is in the heading because the list says so. The rows come from GET /api/automation →
                        getAutomationsForUser (`WHERE user_id = $1`), so these are the automations the VIEWER owns.
                        A colleague's nightly automation, in the same solution and on the same table, is not in it —
                        and an empty section is not distinguishable from "there are none". Narrowing is allowed;
                        silently putting "Automations in this solution" above it is not. */}
                    <GroupHeading
                        title={t('app_studio.logic.automations_title', 'Your automations in this solution')}
                        hint={t(
                            'app_studio.logic.automations_desc',
                            'Automations you own, filed in the same solution and working on the tables this app is bound to. They are not wired to a button — they run on their own. Automations owned by someone else are not listed here.',
                        )}
                    />
                    {automations.map((row) => (
                        <LogicRow key={row.key} row={row} status={statusOf(row)} notices={[]} onReveal={onReveal} t={t} />
                    ))}
                </tbody>
            ) : null}
        </table>
    );
}

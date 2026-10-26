import type { MirrorTable } from '../../../components/admin/Studio/Datatables/sourceMirrors';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { kindColorVar } from '../../../components/shared/kindColors';
import useAutomationApi from '../../../hooks/useAutomationApi';
import { acceptsAdHocRows } from '../../../components/admin/Studio/Datatables/datatableDisplay';
import { datatablesApi } from '../../../components/admin/Studio/Datatables/datatablesApi';
import knowledgeApi from '../../../components/admin/Studio/KnowledgeStudio/knowledgeApi';
import { ACTION_FIELD_IDS, defaultRowMapping, writableColumns } from '../lib/actionDestinations';
import type { DatatableField } from '../lib/actionDestinations';
import type { TranslateFn } from '../../../hooks/useTranslation';
import type { LucideIcon } from 'lucide-react';
import { messageOf } from '../../../utils/caughtError';
import { mayStartRun, runStartRefusal } from '../../../api/queries/automation/runAccess';

type ViewName = typeof VIEW[keyof typeof VIEW];
type BranchKey = keyof typeof BRANCH_KIND;

/** One pickable row of a branch list: an automation (`title`), a table or a knowledge base (`name`). */
interface BranchRow {
    id: string;
    title?: string;
    name?: string;
}

type BranchLists = Record<BranchKey, BranchRow[] | null>;

/** The table picked in the "Row in a table" branch. */
interface PickedTable {
    id: string;
    name?: string;
    fields: DatatableField[];
}

interface AutomationRow {
    id: string;
    title?: string;
    definition?: { trigger?: { kind?: string } };
    /** The server's answer to "may this caller start it?" (a view share may not). */
    canStart?: boolean | null;
}

interface DatatableRow extends MirrorTable {
    id: string;
    name?: string;
    key?: string;
    grade: string;
}

interface KnowledgeBaseRow {
    id: string;
    name?: string;
}

/**
 * THE MENU MACHINERY BEHIND "WHERE DOES THIS GO?" — shared by the destination
 * pill on an action card (M3) and the per-line popover in the transcript (M4).
 *
 * Both menus ask the same three questions ("which automation", "which table, and
 * which column", "which knowledge base"), narrow the offer the same way, and
 * have the same one rule underneath: THE WRITE HAPPENS FIRST, the record
 * second. This module exists so that rule, and the narrowing it rests on, has
 * exactly one implementation. A second copy in the transcript would have been
 * a second place to forget that `managedKind` tables are a platform contract,
 * or that a `number` column cannot hold a sentence.
 *
 * ── EVERY LIST IS A CONVENIENCE, NEVER THE PERMISSION ───────────────
 * `POST /api/automation/:id/run` needs the right to start a run (owner, edit or run share); `POST /api/datatables/:id/rows`
 * demands the `editor` grade (and answers 404, not 403, for a table the caller
 * cannot see); `POST /api/kb/:id/sources` needs `manage_knowledge` plus per-KB
 * manage. What is narrowed here is what the menu OFFERS; the gate is always
 * the route's, and a refusal is shown rather than swallowed.
 */

/** Only these two trigger kinds can be started by hand. */
const AUTOMATION_TRIGGERS: readonly (string | undefined)[] = Object.freeze(['manual', 'agent_call']);

export const VIEW = Object.freeze({
    ROOT: 'root', AUTOMATION: 'automation', TABLE: 'table', COLUMNS: 'columns', KB: 'kb',
});

/** kindColors' key per branch — one legend, never a second palette. */
const BRANCH_KIND = Object.freeze({
    [VIEW.AUTOMATION]: 'automation', [VIEW.TABLE]: 'datatable', [VIEW.KB]: 'kb',
});

/** The action's fields, named for the person mapping them onto columns. */
export function fieldLabels(t: TranslateFn): Record<string, string> {
    return {
        text: t('meetings.field_text', 'Action'),
        assignee: t('meetings.field_assignee', 'Owner'),
        due: t('meetings.field_due', 'Due date'),
        timestamp: t('meetings.field_timestamp', 'Timestamp'),
        meeting_title: t('meetings.field_meeting_title', 'Meeting'),
        meeting_date: t('meetings.field_meeting_date', 'Meeting date'),
    };
}

/** Which list a branch loads, and how it narrows what it offers. */
async function loadBranch(branch: BranchKey, api: ReturnType<typeof useAutomationApi>): Promise<BranchRow[]> {
    if (branch === VIEW.AUTOMATION) {
        const res = await api.listAutomations<{ automations?: AutomationRow[] }>();
        // `manual`, `agent_call`, `form` and `app_trigger` can only ever be the
        // PRIMARY trigger, so `definition.trigger` is the whole question — the
        // additional `definition.triggers[]` never holds one of these.
        return (res?.automations || [])
            .filter((a: AutomationRow) => AUTOMATION_TRIGGERS.includes(a?.definition?.trigger?.kind) && mayStartRun(a))
            .map((a: AutomationRow) => ({ id: a.id, title: a.title || a.id }));
    }
    if (branch === VIEW.TABLE) {
        const res = await datatablesApi.list();
        // `grade` rides on every row, so the menu can narrow to the tables a
        // row may actually be added to. A web-service cache's columns are a
        // platform contract, not a place to file a meeting line; a table that
        // mirrors a Nextcloud table or a spreadsheet IS one — its columns are
        // the person's own, and a refusal comes back through the same path —
        // unless the file is read-only here, when the row would have nowhere
        // to go (`acceptsAdHocRows` reads `source.writable` off the row).
        return (res?.datatables || [])
            .filter((d: DatatableRow) => ['editor', 'owner'].includes(d?.grade) && acceptsAdHocRows(d))
            .map((d: DatatableRow) => ({ id: d.id, name: d.name || d.key || d.id }));
    }
    const res = await knowledgeApi.list();
    return (Array.isArray(res) ? res : []).map((kb: KnowledgeBaseRow) => ({ id: kb.id, name: kb.name || kb.id }));
}

/**
 * The state behind the three branches: which view, which lists have been
 * fetched, which table was picked and how its columns are mapped, and the
 * write-then-record ordering.
 *
 * `runWrite(write, onSuccess)` is the rule made mechanical. A record written
 * ahead of the request would claim a run that never started, a row refused for
 * lack of grade, a knowledge source the licence capped — and nothing on the
 * card would ever correct it. So `onSuccess` fires only after `write`
 * resolved, and a failure shows the server's own message inside the menu and
 * records nothing at all.
 */
export function useDestinationBranches({ t }: { t: TranslateFn }) {
    const api = useAutomationApi();
    const alive = useRef<boolean>(true);
    useEffect(() => () => { alive.current = false; }, []);

    const [view, setView] = useState<ViewName>(VIEW.ROOT);
    const [lists, setLists] = useState<BranchLists>({ automation: null, table: null, kb: null });
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string>('');
    const [busy, setBusy] = useState<boolean>(false);
    const [table, setTable] = useState<PickedTable | null>(null);   // { id, name, fields }
    const [mapping, setMapping] = useState<Record<string, string>>({});

    /** Back to the root of the menu, with nothing half-picked left behind. */
    const reset = useCallback(() => {
        setView(VIEW.ROOT); setError(''); setBusy(false); setTable(null);
    }, []);

    const back = useCallback(() => { setView(VIEW.ROOT); setError(''); setTable(null); }, []);

    /**
     * Load ONE branch's list, once, the first time it is opened.
     *
     * Per branch rather than all three up front: this menu is drawn for every
     * action card and every transcript line, so an unopened menu must cost
     * nothing — and picking "Row in a table" must not pay for the automations.
     */
    const openBranch = useCallback(async (branch: BranchKey) => {
        setView(branch); setError('');
        if (lists[branch] !== null) return;
        setLoading(true);
        try {
            const rows = await loadBranch(branch, api);
            if (alive.current) setLists((prev: BranchLists) => ({ ...prev, [branch]: rows }));
        } catch (e) {
            if (alive.current) setError(messageOf(e, t('meetings.dest_lists_failed', 'Could not load the list.')));
        } finally {
            if (alive.current) setLoading(false);
        }
    }, [lists, api, t]);

    const pickTable = useCallback(async (row: BranchRow) => {
        setError(''); setLoading(true);
        try {
            const schema = await datatablesApi.getSchema(row.id);
            if (!alive.current) return;
            setTable({ id: row.id, name: row.name, fields: schema?.fields || [] });
            setMapping(defaultRowMapping(schema?.fields || []));
            setView(VIEW.COLUMNS);
        } catch (e) {
            if (alive.current) setError(messageOf(e, t('meetings.dest_lists_failed', 'Could not load the list.')));
        } finally {
            if (alive.current) setLoading(false);
        }
    }, [t]);

    const runWrite = useCallback(async (write: () => Promise<void>, onSuccess?: () => void) => {
        setBusy(true); setError('');
        try {
            await write();
            if (alive.current) onSuccess?.();
        } catch (e) {
            if (alive.current) {
                setError(runStartRefusal(t, e) || t('meetings.dest_failed', 'Could not send this action: {message}', { message: messageOf(e, 'error') }));
                setBusy(false);
            }
        }
    }, [t]);

    return {
        api, view, lists, loading, error, busy, table, mapping,
        setMapping, setView, reset, back, openBranch, pickTable, runWrite,
    };
}

/** One row of a branch list. */
export function BranchList({ t, view, lists, loading, onBack, onPick }: { t: TranslateFn; view: BranchKey; lists: BranchLists; loading: boolean; onBack: () => void; onPick: (row: BranchRow) => void }) {
    const rows = lists[view];
    const empty = {
        [VIEW.AUTOMATION]: t('meetings.dest_no_automations', 'No automation here can be started by hand.'),
        [VIEW.TABLE]: t('meetings.dest_no_tables', 'No table you can add rows to.'),
        [VIEW.KB]: t('meetings.dest_no_kbs', 'No knowledge base yet.'),
    }[view];
    return (
        <>
            <BackRow t={t} onBack={onBack} />
            {loading && <Note>{t('meetings.dest_loading', 'Loading…')}</Note>}
            {!loading && rows && rows.length === 0 && <Note>{empty}</Note>}
            {!loading && (rows || []).map((row: BranchRow) => (
                <MenuRow key={row.id} kind={BRANCH_KIND[view]} label={row.title || row.name} onClick={() => onPick(row)} />
            ))}
        </>
    );
}

/**
 * Which column gets what. Mapped by hand on purpose: matching by column NAME
 * would sooner or later drop a person's name into a column other people read,
 * and the person filing the row is the only one who knows which column that is.
 *
 * `labels` is the caller's, because the same six fields are called different
 * things depending on where the row comes from — an action card's `text` is
 * "Action", a transcript line's is "Quote".
 */
export function ColumnMapping({ t, table, mapping, labels, onMap, onBack, onAddRow, loading }: { t: TranslateFn; table: PickedTable | null; mapping: Record<string, string>; labels: Record<string, string>; onMap: (column: string, field: string) => void; onBack: () => void; onAddRow: () => void; loading: boolean }) {
    const columns = writableColumns(table?.fields);
    return (
        <>
            <BackRow t={t} onBack={onBack} />
            {loading && <Note>{t('meetings.dest_loading', 'Loading…')}</Note>}
            {!loading && columns.length === 0 && (
                <Note>{t('meetings.dest_no_columns', 'This table has no column that can hold text.')}</Note>
            )}
            {!loading && columns.map((f: DatatableField) => (
                <label key={f.key} className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                    <span className="flex-1 min-w-0 truncate">{f.label || f.key}</span>
                    <select
                        value={mapping[f.key] || ''}
                        onChange={(e) => onMap(f.key, e.target.value)}
                        aria-label={f.label || f.key}
                        className="rounded border text-xs px-1 py-0.5 [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                    >
                        <option value="">{t('meetings.dest_column_none', 'Leave empty')}</option>
                        {ACTION_FIELD_IDS.map((id: string) => <option key={id} value={id}>{labels[id]}</option>)}
                    </select>
                </label>
            ))}
            {!loading && columns.length > 0 && (
                <button
                    type="button"
                    role="menuitem"
                    onClick={onAddRow}
                    className="w-full text-left px-3 py-1.5 text-sm font-semibold hover:bg-[var(--bg-secondary)] text-[var(--accent-primary)]"
                >
                    {t('meetings.dest_add_row', 'Add the row')}
                </button>
            )}
        </>
    );
}

function BackRow({ t, onBack }: { t: TranslateFn; onBack: () => void }) {
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onBack}
            className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)]"
        >
            <ArrowLeft className="w-3 h-3" aria-hidden="true" />
            {t('meetings.dest_back', 'Back')}
        </button>
    );
}

function Note({ children }: { children?: React.ReactNode }) {
    return <div className="px-3 py-2 text-xs text-[var(--text-tertiary)]">{children}</div>;
}

export function MenuRow({ icon: Icon, kind, label, onClick, chevron = false, tone = null }: { icon?: LucideIcon; kind?: string | null; label: React.ReactNode; onClick?: () => void; chevron?: boolean; tone?: string | null }) {
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onClick}
            className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
        >
            {Icon && (
                <Icon
                    className="w-3.5 h-3.5 flex-shrink-0"
                    aria-hidden="true"
                    style={{ color: tone || (kind ? kindColorVar(kind) : 'var(--text-tertiary)') }}
                />
            )}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {chevron && <ChevronRight className="w-3 h-3 flex-shrink-0" aria-hidden="true" />}
        </button>
    );
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { kindColorVar } from '../../../components/shared/kindColors';
import useAutomationApi from '../../../hooks/useAutomationApi';
import { acceptsAdHocRows } from '../../../components/admin/Studio/Datatables/datatableDisplay';
import { datatablesApi } from '../../../components/admin/Studio/Datatables/datatablesApi';
import knowledgeApi from '../../../components/admin/Studio/KnowledgeStudio/knowledgeApi';
import { ACTION_FIELD_IDS, defaultRowMapping, writableColumns } from '../lib/actionDestinations';

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
 * `POST /api/automation/:id/run` is owner-only; `POST /api/datatables/:id/rows`
 * demands the `editor` grade (and answers 404, not 403, for a table the caller
 * cannot see); `POST /api/kb/:id/sources` needs `manage_knowledge` plus per-KB
 * manage. What is narrowed here is what the menu OFFERS; the gate is always
 * the route's, and a refusal is shown rather than swallowed.
 */

/** Only these two trigger kinds can be started by hand. */
const AUTOMATION_TRIGGERS = Object.freeze(['manual', 'agent_call']);

export const VIEW = Object.freeze({
    ROOT: 'root', AUTOMATION: 'automation', TABLE: 'table', COLUMNS: 'columns', KB: 'kb',
});

/** kindColors' key per branch — one legend, never a second palette. */
export const BRANCH_KIND = Object.freeze({
    [VIEW.AUTOMATION]: 'automation', [VIEW.TABLE]: 'datatable', [VIEW.KB]: 'kb',
});

/** The action's fields, named for the person mapping them onto columns. */
export function fieldLabels(t) {
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
export async function loadBranch(branch, api) {
    if (branch === VIEW.AUTOMATION) {
        const res = await api.listAutomations();
        // `manual`, `agent_call`, `form` and `app_trigger` can only ever be the
        // PRIMARY trigger, so `definition.trigger` is the whole question — the
        // additional `definition.triggers[]` never holds one of these.
        return (res?.automations || [])
            .filter((a) => AUTOMATION_TRIGGERS.includes(a?.definition?.trigger?.kind))
            .map((a) => ({ id: a.id, title: a.title || a.id }));
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
            .filter((d) => ['editor', 'owner'].includes(d?.grade) && acceptsAdHocRows(d))
            .map((d) => ({ id: d.id, name: d.name || d.key || d.id }));
    }
    const res = await knowledgeApi.list();
    return (Array.isArray(res) ? res : []).map((kb) => ({ id: kb.id, name: kb.name || kb.id }));
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
export function useDestinationBranches({ t }) {
    const api = useAutomationApi();
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const [view, setView] = useState(VIEW.ROOT);
    const [lists, setLists] = useState({ automation: null, table: null, kb: null });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [table, setTable] = useState(null);   // { id, name, fields }
    const [mapping, setMapping] = useState({});

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
    const openBranch = useCallback(async (branch) => {
        setView(branch); setError('');
        if (lists[branch] !== null) return;
        setLoading(true);
        try {
            const rows = await loadBranch(branch, api);
            if (alive.current) setLists((prev) => ({ ...prev, [branch]: rows }));
        } catch (e) {
            if (alive.current) setError(e?.message || t('meetings.dest_lists_failed', 'Could not load the list.'));
        } finally {
            if (alive.current) setLoading(false);
        }
    }, [lists, api, t]);

    const pickTable = useCallback(async (row) => {
        setError(''); setLoading(true);
        try {
            const schema = await datatablesApi.getSchema(row.id);
            if (!alive.current) return;
            setTable({ id: row.id, name: row.name, fields: schema?.fields || [] });
            setMapping(defaultRowMapping(schema?.fields || []));
            setView(VIEW.COLUMNS);
        } catch (e) {
            if (alive.current) setError(e?.message || t('meetings.dest_lists_failed', 'Could not load the list.'));
        } finally {
            if (alive.current) setLoading(false);
        }
    }, [t]);

    const runWrite = useCallback(async (write, onSuccess) => {
        setBusy(true); setError('');
        try {
            await write();
            if (alive.current) onSuccess?.();
        } catch (e) {
            if (alive.current) {
                setError(t('meetings.dest_failed', 'Could not send this action: {message}', { message: e?.message || 'error' }));
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
export function BranchList({ t, view, lists, loading, onBack, onPick }) {
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
            {!loading && (rows || []).map((row) => (
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
export function ColumnMapping({ t, table, mapping, labels, onMap, onBack, onAddRow, loading }) {
    const columns = writableColumns(table?.fields);
    return (
        <>
            <BackRow t={t} onBack={onBack} />
            {loading && <Note>{t('meetings.dest_loading', 'Loading…')}</Note>}
            {!loading && columns.length === 0 && (
                <Note>{t('meetings.dest_no_columns', 'This table has no column that can hold text.')}</Note>
            )}
            {!loading && columns.map((f) => (
                <label key={f.key} className="flex items-center gap-2 px-3 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <span className="flex-1 min-w-0 truncate">{f.label || f.key}</span>
                    <select
                        value={mapping[f.key] || ''}
                        onChange={(e) => onMap(f.key, e.target.value)}
                        aria-label={f.label || f.key}
                        className="rounded border text-xs px-1 py-0.5"
                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    >
                        <option value="">{t('meetings.dest_column_none', 'Leave empty')}</option>
                        {ACTION_FIELD_IDS.map((id) => <option key={id} value={id}>{labels[id]}</option>)}
                    </select>
                </label>
            ))}
            {!loading && columns.length > 0 && (
                <button
                    type="button"
                    role="menuitem"
                    onClick={onAddRow}
                    className="w-full text-left px-3 py-1.5 text-sm font-semibold hover:bg-[var(--bg-secondary)]"
                    style={{ color: 'var(--accent-primary)' }}
                >
                    {t('meetings.dest_add_row', 'Add the row')}
                </button>
            )}
        </>
    );
}

export function BackRow({ t, onBack }) {
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onBack}
            className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-[var(--bg-secondary)]"
            style={{ color: 'var(--text-tertiary)' }}
        >
            <ArrowLeft className="w-3 h-3" aria-hidden="true" />
            {t('meetings.dest_back', 'Back')}
        </button>
    );
}

export function Note({ children }) {
    return <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>{children}</div>;
}

export function MenuRow({ icon: Icon, kind, label, onClick, chevron = false, tone = null }) {
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onClick}
            className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-[var(--bg-secondary)]"
            style={{ color: 'var(--text-secondary)' }}
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

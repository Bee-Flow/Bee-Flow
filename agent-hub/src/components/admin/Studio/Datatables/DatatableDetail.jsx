import {
    BarChart3, Check, ClipboardList, Columns3, Copy, Download, Ellipsis, ExternalLink, Loader2, Lock, Pencil, Rows3, ShieldAlert, Share2, Stethoscope,
    Tag, Timer, Trash2, Workflow,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCapabilityLock } from './CapabilityLock';
import ColumnDesigner from './ColumnDesigner';
import { GRADE_LABEL, gradeAtLeast, isFormAnswers, isNcMirror, isSourceMirror, keyFromName, sourceKindSpec, sourceNameOf, sourceUrlOf, tableKindOf } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import DatatableSharing from './DatatableSharing';
import RetentionPanel from './RetentionPanel';
import RowBrowser from './RowBrowser';
import { sourceGlyphOf } from './sourceGlyphs';
import SourceMirrorPanel, { SourceSyncStrip } from './SourceMirrorPanel';
import useSourceMirror from './useSourceMirror';
import useCopyToClipboard from '../../../../hooks/useCopyToClipboard';
import useTranslation from '../../../../hooks/useTranslation';
import AnchoredMenu from '../../../shared/AnchoredMenu';
import DangerZone from '../../../shared/DangerZone';
import Modal from '../../../shared/Modal';
import StudioSectionHeader, { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import UsedByTab from '../../../shared/UsedByTab';
import AnswersDashboard from '../Forms/answers/AnswersDashboard';

/**
 * One table: its columns, its rows, what it holds and for how long, who it is
 * shared with, and — the tab that earns its place — what depends on it.
 *
 * "Used by" is not a nicety. Every other tab here can break something that is
 * not open in front of you: removing a column, tightening sharing, deleting
 * the table. This is the only surface that can answer "what would that break",
 * so the destructive actions read it before they ask.
 *
 * ── ONE USAGE FETCH, NOT THREE ──────────────────────────────────────
 * The column designer, the Used-by tab and the delete confirmation all need the
 * same list, and each used to fetch it for itself — three requests on every
 * open, three chances for them to disagree about what depends on this table
 * while somebody is deciding whether to drop a column. It is fetched once here
 * and handed down.
 *
 * ── THE TABS SIT IN THE COMMAND BAR (Ronde 2, 2026-09-14) ───────────
 * The owner's second design round puts the five tabs inside the 48px bar,
 * "like the editor" — StudioSectionHeader's segment strip, the same strip
 * Knowledge, Skills and Solutions already use. The first build kept them on
 * `shared/Tabs` below the bar for the tablist semantics; the design handoff
 * (Datatables.dc.html 2a–2c) overrides that, and consistency with the other
 * sections wins. Content sits in a 960px column in the middle of the main
 * area; the Rows tab alone runs edge to edge (2b). "Delete this table" is an
 * item in the ⋯ menu, not a red line under every tab (2c).
 */
export default function DatatableDetail({
    table, canManage, currentUserId = null, onBack, onChanged, onDeleted, onNavigate = null,
    // The tab the URL asked for (`/app/studio/datatables/<id>/<tab>`) — the
    // Form page links to a table's Retention and Rows this way.
    initialTab = null,
}) {
    const { t } = useTranslation();
    // A mirror — of a Nextcloud table, or of a sheet in a spreadsheet file —
    // opens on its own tab: the first question about a copy is "how fresh is
    // it", not "what are its columns". One tab id for both kinds; the label
    // and the glyph come from the kind's registry entry.
    const mirror = useSourceMirror(table);
    const isMirror = isSourceMirror(table);
    const spec = sourceKindSpec(table);
    const Glyph = sourceGlyphOf(table);
    // A form's answers table opens on its DASHBOARD: what people answered is
    // the first question about it, not what its columns are.
    const answers = isFormAnswers(table);
    const [tab, setTab] = useState(initialTab || (isMirror ? 'source' : answers ? 'dashboard' : 'columns'));
    const lastInitialTab = useRef(initialTab);
    useEffect(() => {
        if (initialTab !== lastInitialTab.current) {
            lastInitialTab.current = initialTab;
            if (initialTab) setTab(initialTab);
        }
    }, [initialTab]);
    // A mirror is live while somebody LOOKS at it: the rows and the source
    // tab pulse the server, which re-checks the source; the other tabs do not.
    useEffect(() => { mirror?.watch(tab === 'rows' || tab === 'source'); }, [mirror, tab]);
    const { usage, error: usageError } = useUsage(table.id);
    const isOwner = table.grade === 'owner';
    // `manage_datatables` is an ORGANISATION permission (org_admin/agent_admin
    // in config/orgRoles.json) and the server asks for it only on an
    // organisation table. Requiring it here too would leave the owner of a
    // personal table able to create one and then unable to add a column to it.
    const canEdit = isOwner && (canManage || table.scopeKind === 'user');
    // The retention tab's column picker, its "counted from" label, and the
    // "{n} columns · {m} rows" line above the content.
    const columns = useColumns(table.id, true);

    const syncStatus = mirror?.sync?.status;
    // The Retention tab stays, locked or not: switching a window off or
    // shortening it is free on every plan. It wears the lock only when there
    // is no window to act on, because then everything on it is the paid part.
    const retentionLocked = !!useCapabilityLock('datatable_retention') && !table.retentionDays;
    const tabs = useMemo(() => [
        ...(answers ? [{ id: 'dashboard', label: t('datatables.frm_tab_dashboard', 'Dashboard'), icon: <BarChart3 className="w-3.5 h-3.5" /> }] : []),
        // A mirror has a source tab and NO Retention tab: its rows are not
        // aged out here (the server refuses a window), and a tab that can only
        // say so is a tab that should not exist.
        ...(isMirror && spec ? [{
            id: 'source',
            label: spec.tabLabel(t),
            count: syncStatus === 'error' ? '!' : undefined,
            icon: Glyph ? React.createElement(Glyph, { className: 'w-3.5 h-3.5' }) : undefined,
        }] : []),
        { id: 'columns', label: t('datatables.tab_columns', 'Columns'), icon: <Columns3 className="w-3.5 h-3.5" /> },
        { id: 'rows', label: t('datatables.tab_rows', 'Rows'), count: table.rowCount ?? undefined, icon: <Rows3 className="w-3.5 h-3.5" /> },
        ...(isMirror ? [] : [{
            id: 'retention',
            label: t('datatables.tab_data', 'Retention'),
            icon: retentionLocked ? <Lock className="w-3.5 h-3.5" /> : <Timer className="w-3.5 h-3.5" />,
        }]),
        { id: 'sharing', label: t('datatables.tab_sharing', 'Sharing'), icon: <Share2 className="w-3.5 h-3.5" /> },
        // Always last: it is the tab the destructive actions send you to.
        { id: 'usage', label: t('datatables.tab_usage', 'Used by'), count: usage ? usage.length : undefined, icon: <Workflow className="w-3.5 h-3.5" /> },
    ], [t, isMirror, answers, spec, Glyph, syncStatus, table.rowCount, usage, retentionLocked]);

    // The ⋯ menu's "Rename table" opens the header's own inline edit.
    const [renameRequest, setRenameRequest] = useState(0);
    const [deleting, setDeleting] = useState(false);
    const rename = canEdit ? async (name) => {
        try {
            await datatablesApi.update(table.id, { name });
            onChanged();
        } catch (e) {
            console.warn('[datatables] rename failed:', e?.message);
        }
    } : undefined;
    // The delete dialog's notice: what deleting THIS table means.
    const deleteNotice = isMirror && spec ? (
        <p className="text-xs px-3 py-2 rounded flex items-start gap-2"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
            {Glyph && React.createElement(Glyph, { className: 'w-3.5 h-3.5 mt-0.5 shrink-0', style: { color: 'var(--type-data)' }, 'aria-hidden': 'true' })}
            <span>{spec.unlinkNotice(t, sourceNameOf(table, mirror?.source))}</span>
        </p>
    ) : answers ? (
        <p className="text-xs px-3 py-2 rounded flex items-start gap-2"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
            <ClipboardList className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--type-pause)' }} aria-hidden="true" />
            <span>{t('datatables.frm_delete_notice', 'This table holds the answers to a form. Deleting it deletes every answer; the form stays and stops collecting.')}</span>
        </p>
    ) : table.managedKind ? (
        <p className="text-xs px-3 py-2 rounded flex items-start gap-2"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
            <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
            {/* A managed table's rows are third-party answers, so the
                consequence of deleting it is not only "the rows go" —
                every automation caching into it starts paying for every
                call again. Say what it holds while it still exists. */}
            <span>{t('datatables.managed_plaintext', 'Rows here hold what a third-party service answered, in plain text, readable and exportable by everyone with access to this table.')}</span>
        </p>
    ) : null;
    const columnCount = columns.length;

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <StudioSectionHeader
                kind={tableKindOf(table)}
                icon={Glyph || undefined}
                title={table.name}
                onRename={rename}
                renameRequest={renameRequest}
                onBack={onBack}
                backLabel={t('datatables.back', 'All datatables')}
                statusChip={gradeLabel(t, table.grade)}
                tabs={tabs}
                activeTab={tab}
                onTab={setTab}
                extras={(
                    <>
                        {answers && table.source?.automationId && (
                            <button type="button" onClick={() => onNavigate && onNavigate(`studio/forms/${table.source.automationId}`)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border hover:bg-[var(--bg-tertiary)]"
                                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} data-testid="open-form">
                                <ClipboardList className="w-3.5 h-3.5" aria-hidden="true" />{t('datatables.frm_open_form', 'Open the form')}
                            </button>
                        )}
                        <TableMenu
                            t={t}
                            table={table}
                            canEdit={canEdit}
                            mirror={mirror}
                            isMirror={isMirror}
                            onRename={rename ? () => setRenameRequest(n => n + 1) : null}
                            onDuplicate={canEdit && !table.managedKind ? async () => {
                                // Columns only — a copy of the shape, never of the rows.
                                const name = t('datatables.duplicate_name', '{name} (copy)', { name: table.name });
                                const body = await datatablesApi.create({
                                    scope: table.scopeKind === 'user' ? 'personal' : 'organisation',
                                    name,
                                    key: keyFromName(name),
                                    description: table.description || '',
                                    fields: columns.map(f => ({ key: f.key, name: f.name, type: f.type, ...(f.options ? { options: f.options } : {}) })),
                                });
                                if (body?.datatable?.id && onNavigate) onNavigate(`studio/datatables/${body.datatable.id}`);
                            } : null}
                            onDelete={canEdit ? () => setDeleting(true) : null}
                        />
                    </>
                )}
            />

            {/* The Rows tab runs edge to edge (2b): a wide table wants the
                whole main area. Every other tab is a 960px column in the
                middle of it (2a, 2c). */}
            {tab === 'rows' ? (
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden" data-testid="table-rows-page">
                    {mirror && <div className="px-4 pt-3"><SourceSyncStrip table={table} mirror={mirror} canWrite={gradeAtLeast(table.grade, 'editor')} /></div>}
                    {/* onChanged, because a row write moves `rowCount` — and that
                        is the number the destructive-column dialog prices an
                        irreversible decision on. */}
                    <RowBrowser table={table} onChanged={onChanged} mirror={mirror}
                        reloadKey={mirror?.dataVersion ?? null} layout="page" />
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto">
                    <div className="mx-auto flex flex-col gap-3.5" style={{ maxWidth: 960, padding: '32px 24px' }}>
                        <div className="flex items-baseline gap-3" data-testid="table-lede">
                            <p className="flex-1 min-w-0 text-sm m-0" style={{ color: 'var(--text-secondary)', lineHeight: '19px' }}>
                                {table.description || ''}
                            </p>
                            <span className="text-xs whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }} data-testid="table-meta">
                                {columnsWord(t, columnCount)} · {rowsWord(t, table.rowCount ?? 0)}
                            </span>
                        </div>

                        {tab === 'dashboard' && answers && (
                            <AnswersDashboard datatableId={table.id} grade={table.grade} mine={table.grade === 'owner'}
                                automationId={table.source?.automationId || null} onNavigate={onNavigate} testId="table-dashboard" />
                        )}
                        {tab === 'source' && mirror && (
                            <SourceMirrorPanel table={table} mirror={mirror} canEdit={canEdit}
                                canWrite={gradeAtLeast(table.grade, 'editor')} onChanged={onChanged} />
                        )}
                        {tab === 'columns' && (
                            <ColumnDesigner table={table} canEdit={canEdit} usage={usage || []} onChanged={onChanged} mirror={mirror} />
                        )}
                        {tab === 'retention' && (
                            <RetentionPanel table={table} canEdit={canEdit} columns={columns} onChanged={onChanged} />
                        )}
                        {tab === 'sharing' && (
                            <DatatableSharing table={table} canEdit={canEdit} onChanged={onChanged} />
                        )}
                        {tab === 'usage' && (
                            <>
                                <UsedByTab
                                    rows={usage}
                                    error={usageError}
                                    currentUserId={currentUserId}
                                    onNavigate={onNavigate}
                                    adapt={adaptRow}
                                    showSummary={false}
                                    emptyText={t('datatables.usage_empty', 'No automation uses this table yet. Add a Datatable step to one and pick this table.')}
                                />
                                {/* Permanent, not an empty-state hint: the answer to
                                    "how do I connect another one" does not stop
                                    being useful once the first one exists. */}
                                <p className="text-xs m-0" style={{ color: 'var(--text-tertiary)' }}>
                                    {t('datatables.usage_hint', 'To connect another automation: add a Datatable step there and pick this table.')}
                                </p>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* The delete-only surface: the ⋯ menu's "Delete this table…"
                hosts the shared DangerZone, already armed — a collapsed link
                inside a dialog opened to ask that question would be a second
                click asking it again. */}
            <Modal
                open={deleting}
                onClose={() => setDeleting(false)}
                size="md"
                title={isMirror ? t('datatables.nc_unlink_open', 'Unlink this table') : t('datatables.delete_open', 'Delete this table')}
            >
                {deleting && (
                    <DangerZone
                        entityName={table.name}
                        usage={usage}
                        adapt={adaptRow}
                        currentUserId={currentUserId}
                        onNavigate={onNavigate}
                        kindLabel={t('datatables.kind_word', 'table')}
                        openLabel={isMirror ? t('datatables.nc_unlink_open', 'Unlink this table') : t('datatables.delete_open', 'Delete this table')}
                        // Unlinking removes a COPY; the wording must not
                        // threaten what does not happen (see DangerZone).
                        question={isMirror ? t('datatables.nc_unlink_question', 'Unlink “{name}” from this workspace?', { name: table.name }) : null}
                        confirmLabel={isMirror ? t('datatables.nc_unlink_confirm', 'Unlink') : null}
                        // A table IS data — its rows go with it — so the
                        // name is typed even when nothing depends on it.
                        requireName
                        defaultArmed
                        onCancel={() => setDeleting(false)}
                        notice={deleteNotice}
                        onDelete={async (confirmedBreaking) => {
                            await datatablesApi.remove(table.id, { confirmBreaking: confirmedBreaking });
                            setDeleting(false);
                            onDeleted();
                        }}
                    />
                )}
            </Modal>
        </div>
    );
}

/** "6 columns" / "1 column". */
function columnsWord(t, n) {
    return n === 1 ? t('datatables.one_column', '1 column') : t('datatables.n_columns', '{n} columns', { n });
}

/** "412 rows" / "1 row", grouped. */
function rowsWord(t, n) {
    const count = Number(n) || 0;
    if (count === 1) return t('datatables.one_row', '1 row');
    return t('datatables.n_rows', '{n} rows', { n: new Intl.NumberFormat().format(count) });
}

function gradeLabel(t, grade) {
    switch (grade) {
        case 'owner': return t('datatables.grade_owner', GRADE_LABEL.owner);
        case 'editor': return t('datatables.grade_editor', GRADE_LABEL.editor);
        case 'viewer': return t('datatables.grade_viewer', GRADE_LABEL.viewer);
        default: return t('datatables.grade_shared', 'Shared with you');
    }
}

/**
 * The datatables usage row → UsedByTab's contract.
 *
 * The index went generic (T3): a row now carries `consumerKind`
 * ('automation' | 'app' | 'webpage'), `stepOrdinal`, `stepType`/`stepOp`,
 * `mode` (which may now be 'readwrite') and `lastRunAt`. The legacy
 * `automation*` aliases are still populated for every kind, so they stay the
 * fallback rather than the source.
 */
export function adaptRow(u) {
    if (!u || typeof u !== 'object') return null;
    const kind = u.consumerKind || 'automation';
    const id = u.consumerId || u.automationId;
    const parts = [];
    if (u.stepOrdinal) parts.push(`step ${u.stepOrdinal}`);
    if (u.stepOp || u.stepType) parts.push(String(u.stepOp || u.stepType).replace(/_/g, ' '));
    const columns = Array.isArray(u.columns) ? u.columns.filter(Boolean) : [];
    if (!parts.length && columns.length) parts.push(columns.join(', '));
    return {
        kind,
        id,
        title: u.consumerTitle || u.automationTitle || null,
        role: u.mode === 'readwrite' ? 'readwrite' : (u.mode === 'write' ? 'write' : 'read'),
        siteLabel: parts.length ? parts.join(' · ') : undefined,
        lastAt: u.lastRunAt || null,
        ownerId: u.consumerOwner ?? u.automationOwner ?? null,
    };
}

/** What depends on this table, and how. Fetched ONCE per open. */
function useUsage(tableId) {
    const [usage, setUsage] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        let alive = true;
        setUsage(null);
        setError(null);
        datatablesApi.listUsage(tableId)
            .then(b => { if (alive) setUsage(Array.isArray(b?.usage) ? b.usage : []); })
            // A failed usage read must not leave the list at null forever: the
            // delete confirmation reads it, and "still loading" and "nothing
            // depends on this" look identical from there.
            .catch(e => { if (alive) { setError(e.message || 'usage'); setUsage([]); } });
        return () => { alive = false; };
    }, [tableId]);
    return { usage, error };
}

/**
 * The column list, for the tab that needs to NAME a column rather than edit
 * one. Lazy: the designer and the row browser load the schema for themselves
 * (each also needs the model version or the rows alongside it), so fetching
 * it here on every open would be a third request nobody asked for.
 */
function useColumns(tableId, enabled) {
    const [columns, setColumns] = useState([]);
    useEffect(() => {
        if (!enabled) return undefined;
        let alive = true;
        datatablesApi.getSchema(tableId)
            .then(s => { if (alive) setColumns(s?.fields || []); })
            // The tab still works without it — the labels fall back to the
            // column key, which is what the server stores anyway.
            .catch(() => { if (alive) setColumns([]); });
        return () => { alive = false; };
    }, [tableId, enabled]);
    return columns;
}

/** Is this SPA running inside Nextcloud's ExApp frame? (LoginPage.jsx's idiom.) */
function isEmbedded() {
    try { return typeof window !== 'undefined' && window.self !== window.top; } catch { return true; }
}

/**
 * Where "Open in {source}" opens. `_top` ONLY when the page is Nextcloud's
 * own — a Tables table, or a file in Nextcloud Files — and the SPA sits in
 * the ExApp frame, where that takes the host to where the person already
 * is. Google Drive and OneDrive are other sites: a `_top` there would
 * replace the whole Nextcloud tab with docs.google.com. They open in a new
 * tab, embedded or not — as the same link on the file card already does.
 */
function sourceTargetOf(table, source) {
    const ncHosted = isNcMirror(table) || source?.provider === 'nextcloud_files';
    return ncHosted && isEmbedded() ? '_top' : '_blank';
}

/**
 * The ⋯ menu: what belongs to the TABLE rather than to a tab (2c's menu —
 * Rename table · Duplicate · Export CSV · ─ · Delete this table…), plus the
 * items the first round put here that still have no other home.
 *
 * "Technical name" stays because the key is what a Datatable step refers to
 * and it used to be shown once, in the create dialog, and never again — the
 * one place a person goes to look a table up could not tell them the
 * identifier they need. It is a copy button, not a chip, so the header stays
 * the artboard's row and the key is still one click from any tab.
 *
 * "Duplicate" copies the SHAPE — name, purpose, columns — never the rows: a
 * second copy of a table's data is a second thing to keep in step, and the
 * person who wants the rows has Export. A managed table (a cache, a mirror,
 * a form's answers) has no shape of its own to copy, so it has no item.
 */
function TableMenu({ t, table, canEdit, mirror = null, isMirror = false, onRename = null, onDuplicate = null, onDelete = null }) {
    const [open, setOpen] = useState(false);
    const [health, setHealth] = useState(false);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const anchorRef = useRef(null);
    const { copy, copied } = useCopyToClipboard();
    const sourceUrl = mirror ? sourceUrlOf(table, mirror.source) : null;

    const duplicate = async () => {
        setOpen(false);
        setBusy(true);
        setError(null);
        try {
            await onDuplicate();
        } catch (e) {
            setError(e?.message || t('datatables.err_duplicate', 'Could not duplicate the table'));
        } finally {
            setBusy(false);
        }
    };

    const exportCsv = async () => {
        setOpen(false);
        try {
            const text = await datatablesApi.exportCsv(table.id);
            // A Blob and a revoked object URL, NEVER an <a href download>
            // pointing at the API: that link carries no auth header, and on
            // this stack a same-origin download navigates the SPA away from
            // itself (the routines library learned it the hard way).
            const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `${table.key || 'datatable'}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError(e.message || t('datatables.err_export', 'Could not export the rows'));
        }
    };

    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('datatables.table_menu', 'More about this table')}
                className="w-8 h-8 grid place-items-center rounded-lg border focus-visible:outline focus-visible:outline-2"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}
            >
                <Ellipsis className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="right"
                width={260}
                role="menu"
                aria-label={t('datatables.table_menu', 'More about this table')}
                className="py-1"
            >
                {onRename && (
                    <button type="button" role="menuitem" onClick={() => { setOpen(false); onRename(); }}
                        className={MENU_ITEM} style={{ color: 'var(--text-primary)' }} data-testid="menu-rename">
                        <Pencil className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                        {t('datatables.menu_rename', 'Rename table')}
                    </button>
                )}
                {onDuplicate && (
                    <button type="button" role="menuitem" onClick={duplicate} disabled={busy}
                        className={MENU_ITEM} style={{ color: 'var(--text-primary)' }} data-testid="menu-duplicate">
                        <Copy className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                        <span className="min-w-0 flex-1 text-left">
                            <span className="block">{t('datatables.menu_duplicate', 'Duplicate')}</span>
                            <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('datatables.menu_duplicate_hint', 'columns only, no rows')}</span>
                        </span>
                    </button>
                )}
                <button type="button" role="menuitem" onClick={exportCsv}
                    className={MENU_ITEM} style={{ color: 'var(--text-primary)' }}>
                    <Download className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                    {t('datatables.export_csv_menu', 'Export (CSV)')}
                </button>
                <button type="button" role="menuitem" onClick={() => copy(table.key)}
                    className={MENU_ITEM} style={{ color: 'var(--text-primary)' }}>
                    <Tag className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-left">
                        <span className="block">{t('datatables.field_key', 'Technical name')}</span>
                        <code className="block text-[11px] font-mono truncate" style={{ color: 'var(--text-tertiary)' }}>{table.key}</code>
                    </span>
                    {copied && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--success)' }} aria-hidden="true" />}
                </button>
                {canEdit && (
                    <button type="button" role="menuitem" onClick={() => { setOpen(false); setHealth(true); }}
                        className={MENU_ITEM} style={{ color: 'var(--text-primary)' }}>
                        <Stethoscope className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                        {t('datatables.check_repair', 'Check & repair')}
                    </button>
                )}
                {sourceUrl && (
                    <a role="menuitem" href={sourceUrl} target={sourceTargetOf(table, mirror.source)} rel="noopener noreferrer"
                        onClick={() => setOpen(false)} className={MENU_ITEM} style={{ color: 'var(--text-primary)' }}>
                        <ExternalLink className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                        {t('datatables.src_open_in', 'Open in {source}', { source: sourceNameOf(table, mirror?.source) })}
                    </a>
                )}
                {onDelete && (
                    <>
                        <div role="separator" className="my-1 mx-2" style={{ height: 1, background: 'var(--border-default)' }} />
                        <button type="button" role="menuitem" onClick={() => { setOpen(false); onDelete(); }}
                            className={MENU_ITEM} style={{ color: 'var(--error)' }} data-testid="menu-delete">
                            <Trash2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                            {isMirror ? t('datatables.menu_unlink', 'Unlink this table…') : t('datatables.menu_delete', 'Delete this table…')}
                        </button>
                    </>
                )}
            </AnchoredMenu>
            <p aria-live="polite" className="sr-only">{error}</p>
            {health && <HealthDialog t={t} table={table} onClose={() => setHealth(false)} />}
        </>
    );
}

const MENU_ITEM = 'w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-[var(--bg-secondary)] transition';

/**
 * Does the physical table still match the model, and put it right if not.
 *
 * Worth a control rather than a support procedure because the repair is
 * add-only by construction — the server diffs this table against ITSELF with
 * no fields, so the plan can only ever be CREATE TABLE and ADD COLUMN, never
 * a drop. Saying that out loud is what makes the button safe to press.
 */
function HealthDialog({ t, table, onClose }) {
    const [state, setState] = useState({ loading: true });
    const [busy, setBusy] = useState(false);

    const check = useCallback(async () => {
        setState({ loading: true });
        try {
            setState({ loading: false, health: await datatablesApi.health(table.id) });
        } catch (e) {
            setState({ loading: false, error: e.message || t('datatables.err_health', 'Could not check this table') });
        }
    }, [table.id, t]);

    useEffect(() => { check(); }, [check]);

    const repair = async () => {
        setBusy(true);
        try {
            const body = await datatablesApi.repair(table.id);
            setState({ loading: false, health: body, repaired: true });
        } catch (e) {
            setState(s => ({ ...s, error: e.message || t('datatables.err_repair', 'Could not repair this table') }));
        } finally {
            setBusy(false);
        }
    };

    const h = state.health;
    return (
        <Modal open onClose={onClose} size="md" title={t('datatables.check_repair', 'Check & repair')}>
            <div className="space-y-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                {state.loading ? (
                    <p className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{t('datatables.loading', 'Loading…')}</p>
                ) : state.error ? (
                    <p style={{ color: 'var(--warning)' }}>{state.error}</p>
                ) : h?.healthy ? (
                    <p>{state.repaired
                        ? t('datatables.health_repaired', 'Put right — the table and its columns are all there now.')
                        : t('datatables.health_ok', 'Everything matches: the table and every column it should have are there.')}</p>
                ) : (
                    <>
                        <p>
                            {!h?.tableExists
                                ? t('datatables.health_missing_table', 'The storage for this table has not been made yet.')
                                : t('datatables.health_missing_columns', '{n} column(s) are in the model but not in the storage: {keys}.', {
                                    n: (h?.missingColumns || []).length, keys: (h?.missingColumns || []).join(', '),
                                })}
                        </p>
                        <p className="text-xs">
                            {t('datatables.health_repair_blurb', 'Repairing re-runs this table’s own “create if missing” statements. It only ever adds — it cannot drop a column or touch a row.')}
                        </p>
                    </>
                )}
                <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={onClose}
                        className="px-3 py-1.5 rounded-[10px] text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        {t('datatables.close', 'Close')}
                    </button>
                    {!state.loading && h && !h.healthy && (
                        <button type="button" onClick={repair} disabled={busy}
                            className="px-3 py-1.5 rounded-[10px] text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                            {t('datatables.repair', 'Repair it')}
                        </button>
                    )}
                </div>
            </div>
        </Modal>
    );
}

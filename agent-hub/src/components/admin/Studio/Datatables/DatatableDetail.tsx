import { BarChart3, ClipboardList, Columns3, Rows3, ShieldAlert, Share2, Timer, Workflow } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import ColumnDesigner from './ColumnDesigner';
import { GRADE_LABEL, gradeAtLeast, isFormAnswers, isSourceMirror, keyFromName, sourceKindSpec, sourceNameOf, tableKindOf } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import DatatableSharing from './DatatableSharing';
import RetentionPanel from './RetentionPanel';
import RowBrowser from './RowBrowser';
import { sourceGlyphOf } from './sourceGlyphs';
import SourceMirrorPanel, { SourceSyncStrip } from './SourceMirrorPanel';
import useSourceMirror from './useSourceMirror';
import useTranslation from '@/hooks/useTranslation';
import DangerZone from '@/components/shared/DangerZone';
import Modal from '@/components/shared/Modal';
import StudioSectionHeader from '@/components/shared/StudioSectionHeader';
import ManagedPartBanner from '@/components/shared/ManagedPartBanner';
import { managedOf } from '@/components/shared/managedPart';
import UsedByTab from '@/components/shared/UsedByTab';
import AnswersDashboard from '../Forms/answers/AnswersDashboard';
import type { TranslateFn, TranslateParams } from '@/hooks/useTranslation';
import type { UsageSourceRow } from '@/components/shared/UsedByTab.types';
import type { MirrorSync } from './sourceMirrors';
import type { DtColumn, DtTable } from './rowBrowser/rowBrowserModel';
import type { SourceMirror } from './useSourceMirror';
import type { DatatableDetailProps, DatatableUsageRow, DetailTable } from './DatatableDetail.types';
import { TableMenu } from './TableMenu';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';

export default function DatatableDetail({
    table, canManage, currentUserId = null, onBack, onChanged, onDeleted, onNavigate = null,
    // The tab the URL asked for (`/app/studio/datatables/<id>/<tab>`) — the
    // Form page links to a table's Retention and Rows this way.
    initialTab = null,
}: DatatableDetailProps) {
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
    useAdjustOnChange([initialTab], () => { if (initialTab) setTab(initialTab); });
    // A mirror is live while somebody LOOKS at it: the rows and the source
    // tab pulse the server, which re-checks the source; the other tabs do not.
    useEffect(() => { mirror?.watch(tab === 'rows' || tab === 'source'); }, [mirror, tab]);
    const { usage, error: usageError } = useUsage(table.id);
    const isOwner = table.grade === 'owner';
    // `manage_datatables` is an ORGANISATION permission (org_admin/agent_admin
    // in config/orgRoles.json) and the server asks for it only on an
    // organisation table. Requiring it here too would leave the owner of a
    // personal table able to create one and then unable to add a column to it.
    // A table a Solution stage manages is read-only for everyone (the stage's
    // deploy writes its columns). `managed` is on the table's own GET, not on the
    // list row the studio hands down, so it is fetched once per table.
    const [managed, setManaged] = useState(() => managedOf(table));
    useEffect(() => {
        let off = false;
        Promise.resolve().then(() => datatablesApi.get(table.id))
            .then((res) => { if (!off) setManaged(managedOf(res) || managedOf(table)); })
            .catch(() => { /* the banner is a refinement; the server still refuses the write */ });
        return () => { off = true; };
    }, [table]);
    const canEdit = isOwner && (canManage || table.scopeKind === 'user') && !managed;
    // The retention tab's column picker, its "counted from" label, and the
    // "{n} columns · {m} rows" line above the content.
    const columns = useColumns(table.id, true);

    const syncStatus = mirror?.sync?.status;
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
        ...(isMirror ? [] : [{ id: 'retention', label: t('datatables.tab_data', 'Retention'), icon: <Timer className="w-3.5 h-3.5" /> }]),
        { id: 'sharing', label: t('datatables.tab_sharing', 'Sharing'), icon: <Share2 className="w-3.5 h-3.5" /> },
        // Always last: it is the tab the destructive actions send you to.
        { id: 'usage', label: t('datatables.tab_usage', 'Used by'), count: usage ? usage.length : undefined, icon: <Workflow className="w-3.5 h-3.5" /> },
    ], [t, isMirror, answers, spec, Glyph, syncStatus, table.rowCount, usage]);

    // The ⋯ menu's "Rename table" opens the header's own inline edit.
    const [renameRequest, setRenameRequest] = useState(0);
    const [deleting, setDeleting] = useState(false);
    const rename = canEdit ? async (name: string) => {
        try {
            await datatablesApi.update(table.id, { name });
            onChanged();
        } catch (e) {
            console.warn('[datatables] rename failed:', (e as Error)?.message);
        }
    } : undefined;
    // The delete dialog's notice: what deleting THIS table means.
    const deleteNotice = isMirror && spec ? (
        <p className="text-xs px-3 py-2 rounded flex items-start gap-2 bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
            {Glyph && React.createElement(Glyph, { className: 'w-3.5 h-3.5 mt-0.5 shrink-0', style: { color: 'var(--type-data)' }, 'aria-hidden': 'true' })}
            <span>{spec.unlinkNotice(t, sourceNameOf(table, mirror?.source))}</span>
        </p>
    ) : answers ? (
        <p className="text-xs px-3 py-2 rounded flex items-start gap-2 bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
            <ClipboardList className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--type-pause)' }} aria-hidden="true" />
            <span>{t('datatables.frm_delete_notice', 'This table holds the answers to a form. Deleting it deletes every answer; the form stays and stops collecting.')}</span>
        </p>
    ) : table.managedKind ? (
        <p className="text-xs px-3 py-2 rounded flex items-start gap-2 bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
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
                            <button type="button" onClick={() => onNavigate && onNavigate(`studio/forms/${table.source?.automationId}`)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border hover:bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--text-secondary)]" data-testid="open-form">
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
                        {managed && <ManagedPartBanner managed={managed} onNavigate={onNavigate} />}
                        <div className="flex items-baseline gap-3" data-testid="table-lede">
                            <p className="flex-1 min-w-0 text-sm m-0" style={{ color: 'var(--text-secondary)', lineHeight: '19px' }}>
                                {table.description || ''}
                            </p>
                            <span className="text-xs whitespace-nowrap text-[var(--text-tertiary)]" data-testid="table-meta">
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
                            <ColumnDesigner table={table} canEdit={canEdit} usage={usage || []} onChanged={onChanged} mirror={mirror}
                                onOpenUsage={() => setTab('usage')} />
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
                                <p className="text-xs m-0 text-[var(--text-tertiary)]">
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
            <DatatableDetailModal deleting={deleting} setDeleting={setDeleting} isMirror={isMirror} t={t} table={table} usage={usage} currentUserId={currentUserId} onNavigate={onNavigate} deleteNotice={deleteNotice} onDeleted={onDeleted} />
        </div>
    );
}

function DatatableDetailModal({ deleting, setDeleting, isMirror, t, table, usage, currentUserId, onNavigate, deleteNotice, onDeleted }: { deleting: boolean; setDeleting: React.Dispatch<React.SetStateAction<boolean>>; isMirror: boolean; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; table: DetailTable; usage: UsageSourceRow[] | null; currentUserId: string | null; onNavigate: ((path: string) => void) | null; deleteNotice: React.JSX.Element | null; onDeleted: () => void; }) {
    return <Modal
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
                onDelete={async (confirmedBreaking: boolean) => {
                    await datatablesApi.remove(table.id, { confirmBreaking: confirmedBreaking });
                    setDeleting(false);
                    onDeleted();
                } } />
        )}
    </Modal>;
}

/** "6 columns" / "1 column". */
function columnsWord(t: TranslateFn, n: number) {
    return n === 1 ? t('datatables.one_column', '1 column') : t('datatables.n_columns', '{n} columns', { n });
}

/** "412 rows" / "1 row", grouped. */
function rowsWord(t: TranslateFn, n: number) {
    const count = Number(n) || 0;
    if (count === 1) return t('datatables.one_row', '1 row');
    return t('datatables.n_rows', '{n} rows', { n: new Intl.NumberFormat().format(count) });
}

function gradeLabel(t: TranslateFn, grade: string | undefined) {
    switch (grade) {
        case 'owner': return t('datatables.grade_owner', GRADE_LABEL.owner);
        case 'editor': return t('datatables.grade_editor', GRADE_LABEL.editor);
        case 'viewer': return t('datatables.grade_viewer', GRADE_LABEL.viewer);
        default: return t('datatables.grade_shared', 'Shared with you');
    }
}

function adaptRow(u: DatatableUsageRow | null | undefined) {
    if (!u || typeof u !== 'object') return null;
    const kind = u.consumerKind || 'automation';
    const id = u.consumerId || u.automationId;
    const parts: string[] = [];
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
function useUsage(tableId: string) {
    const [usage, setUsage] = useState<UsageSourceRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);
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
function useColumns(tableId: string, enabled: boolean) {
    const [columns, setColumns] = useState<DtColumn[]>([]);
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


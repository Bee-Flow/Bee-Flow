import { Loader2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo } from 'react';
import type { ComponentType, Dispatch } from 'react';
import RowsTabJs from './RowsTab';
import TableDetail, { NoTableSelected } from './TableDetail';
import { ManagerTabBar, PeopleTab, TableList } from './TablesManagerParts';
import { tableSourceOf } from './tablesManagerModel';
import type { DataModelState } from './useDataModel';
import type { ModelConnector, ModelTable } from './tablesManagerModel';
import { useDataModel } from './useDataModel';
import useTranslation from '../../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import ConfirmDialog from '../../../../shared/ConfirmDialog';
import Modal from '../../../../shared/Modal';
import toast from '../../../../shared/Toast';
import ConnectorsManagerJs from '../bi/ConnectorsManager';
import useAppTables from '../bi/useAppTables';
import type { AppAction, AppDefinition } from '../inspector/appDefinition';
import type { AppEditorAction } from '../state/appEditorState';
import { collectIds, findScreen, insertNode } from '../state/definitionOps';
import { buildFormForTable as buildFormJs, buildGridForTable as buildGridJs } from '../state/generators';

/**
 * App Studio — the visual data-table designer (a modal).
 *
 * Left: the app's tables (from the owner data model). Right: the selected
 * table's fields (TableDesigner) plus one-click generators that drop a bound
 * form or grid onto the current screen. Structural edits (add/rename/delete
 * table, edit fields) persist to the data model via PUT /:id/schema on Save
 * (useDataModel); a save triggers the server's table migration, so the "Make
 * a form/grid" generators are only offered for tables that already exist
 * server-side (surfaced through useAppTables).
 *
 * The Rows tab edits the table's actual records (RowsTab). It hangs off the
 * same "does this table exist server-side yet" fact: a table that has only ever
 * been drafted here has no storage behind it, so the tab is disabled — and says
 * so — until the model is saved.
 */

// The relationship canvas pulls in ReactFlow and its stylesheet, which nobody
// opening the field designer needs — and which is a lot of code to parse before
// the modal can paint. Loaded when the tab is actually opened.
const RelationshipsTab = lazy(() => import('./RelationshipsTab'));

// Typed views of .js siblings whose branch-shaped returns would otherwise
// mistype what this module passes.
type Generated = { node: unknown; actions?: Record<string, AppAction> };
const buildFormForTable = buildFormJs as unknown as (table: ModelTable, opts: { taken: unknown }) => Generated;
const buildGridForTable = buildGridJs as unknown as (table: ModelTable, opts: { taken: unknown }) => Generated;
// ConnectorsManager speaks the editor's own Connector/SyncTable shapes; the
// model's rows are read looser (an optional kind, a required table key).
const ConnectorsManager = ConnectorsManagerJs as unknown as ComponentType<{
    connectors: ModelConnector[] | undefined;
    onChange: (connectors: ModelConnector[]) => void;
    disabled?: boolean;
    appId?: string | null;
    tables?: ModelTable[];
    onCreateTable: DataModelState['createTableForConnector'];
    saved?: boolean;
    onSave?: (() => Promise<boolean>) | null;
}>;
const RowsTab = RowsTabJs as unknown as ComponentType<{ appId: string; table: ModelTable; tables: ModelTable[]; fieldsUnsaved: boolean }>;

export interface TablesManagerProps {
    open: boolean;
    /** Asks for the modal chrome to be dropped (the Data view). Not read yet. */
    inline?: boolean;
    onClose?: () => void;
    appId: string;
    definition: AppDefinition | null;
    screenId: string | null;
    onCommit?: (definition: AppDefinition) => void;
    dispatch?: Dispatch<AppEditorAction>;
}

interface GenerateInputs extends TablesManagerProps {
    t: TranslateFn;
    data: DataModelState;
    selected: ModelTable | null;
    savedById: Map<string, ModelTable>;
}

/**
 * Drop a generated form/grid onto the current screen (one history commit).
 * The modal closes afterwards, so any unsaved table edits are persisted FIRST
 * — and the form/grid is then built from what was actually saved.
 */
async function generateOnScreen(kind: 'form' | 'grid', { t, data, selected, savedById, definition, screenId, onCommit, dispatch, onClose }: GenerateInputs) {
    if (!definition || !selected) return;
    const wasDirty = data.dirty;
    if (wasDirty && !(await data.save())) return;
    const tableMeta = wasDirty ? selected : (savedById.get(selected.id) || selected);
    const taken = collectIds(definition);
    const built = kind === 'form'
        ? buildFormForTable(tableMeta, { taken })
        : buildGridForTable(tableMeta, { taken });

    let def = definition;
    if (built.actions) def = { ...def, actions: { ...(def.actions || {}), ...built.actions } };
    const screen = findScreen(def, screenId) || def.screens?.[0] || null;
    const sectionId = screen?.sections?.[0]?.id;
    if (!sectionId) { toast.error(t('studio_apps_tables.manager.no_section', 'Add a section to the screen first.')); return; }

    const res = insertNode(def, { parentId: sectionId, node: built.node });
    if (!res.nodeId) return;
    onCommit?.(res.def);
    dispatch?.({ type: 'select_node', nodeId: res.nodeId });
    dispatch?.({ type: 'set_recent_ids', ids: [res.nodeId] });
    toast.success(kind === 'form' ? t('studio_apps_tables.manager.form_added', 'Form added to the screen.') : t('studio_apps_tables.manager.grid_added', 'Grid added to the screen.'));
    onClose?.();
}

function ManagerFooter({ saving, dirty, onClose, onSave }: { saving: boolean; dirty: boolean; onClose?: () => void; onSave: () => void }) {
    const { t } = useTranslation();
    return (
        <>
            <button
                type="button"
                onClick={() => onClose?.()}
                disabled={saving}
                className="rounded-lg bg-white/5 px-4 py-2 text-sm hover:bg-[var(--bg-card-hover)] disabled:opacity-50 text-[var(--text-primary)]"
            >
                {t('studio_apps_tables.manager.close', 'Close')}
            </button>
            <button
                type="button"
                onClick={onSave}
                disabled={saving || !dirty}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 bg-[var(--accent-primary)]"
            >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                {t('studio_apps_tables.manager.save_changes', 'Save changes')}
            </button>
        </>
    );
}

function Spinner({ label }: { label: string }) {
    return (
        <div className="flex items-center gap-2 py-10 text-sm justify-center text-[var(--text-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {label}
        </div>
    );
}

export default function TablesManager(props: TablesManagerProps) {
    const { open, onClose, appId } = props;
    const { t } = useTranslation();
    const { tables: savedTables, refetch: refetchSaved } = useAppTables(appId) as { tables: ModelTable[]; refetch: () => unknown };
    const data = useDataModel(appId, open, t, refetchSaved);
    const { model, tables, loading, saving, dirty, selectedId, setSelectedId, activeTab, setActiveTab, save } = data;

    const savedIds = useMemo(() => new Set((savedTables || []).map((tbl) => tbl.id)), [savedTables]);
    const savedById = useMemo(() => {
        const m = new Map<string, ModelTable>();
        for (const tbl of savedTables || []) m.set(tbl.id, tbl);
        return m;
    }, [savedTables]);

    const selected = tables.find((tbl) => tbl.id === selectedId) || null;
    // Which of the two kinds is the selected table? Memoised because
    // tableSourceOf returns a NEW object: without this the effect below runs
    // again on every render.
    const selectedSource = useMemo(() => (selected ? tableSourceOf(selected) : null), [selected]);

    // Rows live in the table the SERVER has; a draft table has none yet, and a
    // draft field is not a column until the model is saved.
    const selectedSaved = selected ? (savedById.get(selected.id) || null) : null;
    const fieldsUnsaved = !!selectedSaved
        && JSON.stringify(selected?.fields || []) !== JSON.stringify(selectedSaved.fields || []);

    // Deleting (or never having saved) the table behind the Rows tab leaves it
    // pointing at nothing — fall back to the designer rather than a blank pane.
    // A LINKED table has no rows to edit here either: they live in the Studio
    // datatable. Showing an empty rows view would claim the table is empty,
    // and that is something else than "not visible here".
    useEffect(() => {
        if (activeTab === 'rows' && (!selectedSaved || selectedSource)) setActiveTab('tables');
    }, [activeTab, selectedSaved, selectedSource, setActiveTab]);

    const deletingTable = tables.find((tbl) => tbl.id === data.confirmDeleteId) || null;
    const generate = (kind: 'form' | 'grid') => generateOnScreen(kind, { ...props, t, data, selected, savedById });

    const designer = activeTab === 'rows' && selectedSaved ? (
        <RowsTab key={selectedSaved.id} appId={appId} table={selectedSaved} tables={savedTables} fieldsUnsaved={fieldsUnsaved} />
    ) : selected ? (
        <TableDetail table={selected} tables={tables} savedTable={savedById.get(selected.id) || null} onChange={data.renameSelected}
            isSaved={savedIds.has(selected.id)} source={selectedSource} onGenerate={generate} onSave={save} saving={saving} dirty={dirty} />
    ) : <NoTableSelected onAdd={data.addTable} />;

    return (
        <Modal
            open={open}
            onClose={() => !saving && onClose?.()}
            title={t('studio_apps_tables.manager.title', 'Tables')}
            description={t('studio_apps_tables.manager.description', 'Design the data behind your app, then drop a form or grid onto the current screen.')}
            // 'full', not 'xl'. This dialog holds a table list, a field
            // designer, a rows grid and the connector editor side by side —
            // max-w-4xl gave the designer about 616px of usable width, so every
            // one of those was scrolling inside a column.
            size="full"
            footer={<ManagerFooter saving={saving} dirty={dirty} onClose={onClose} onSave={save} />}
        >
            {loading || !model ? <Spinner label={t('studio_apps_tables.manager.loading', 'Loading tables…')} /> : (
              <>
                <ManagerTabBar activeTab={activeTab} onTab={setActiveTab} selected={selected} selectedSaved={selectedSaved} selectedSource={selectedSource} />

                {activeTab === 'people' ? (
                    <PeopleTab orgMembers={model?.directory?.orgMembers === true} onChange={data.patchDirectory} disabled={saving} />
                ) : activeTab === 'relations' ? (
                    <Suspense fallback={<Spinner label={t('studio_apps_tables.manager.loading_map', 'Loading the map…')} />}>
                        <RelationshipsTab
                            tables={tables}
                            connectors={model.connectors}
                            onChange={data.patchModel}
                            onOpenTable={(id: string) => { setSelectedId(id); setActiveTab('tables'); }}
                            disabled={saving}
                        />
                    </Suspense>
                ) : activeTab === 'connectors' ? (
                    <ConnectorsManager
                        connectors={model.connectors}
                        onChange={data.patchConnectors}
                        disabled={saving}
                        appId={appId}
                        tables={tables}
                        onCreateTable={data.createTableForConnector}
                        // /inspect, /sync and "Test it" all read the LAST SAVED
                        // model. Rather than going grey until the draft is clean,
                        // the read-only ones save first (see bi/saveGate.js) —
                        // hence onSave alongside `saved`.
                        saved={!dirty}
                        onSave={save}
                    />
                ) : (
                <div className="flex gap-4 min-h-[22rem]">
                    <TableList tables={tables} selectedId={selectedId} savedIds={savedIds} onSelect={setSelectedId}
                        onDelete={data.setConfirmDeleteId} onAdd={data.addTable} />
                    {/* Designer + generators, or the selected table's rows */}
                    <div className="min-w-0 flex-1">{designer}</div>
                </div>
                )}
              </>
            )}

            <ConfirmDialog
                open={!!data.confirmDeleteId}
                title={t('studio_apps_tables.manager.delete_title', 'Delete “{name}”?', { name: deletingTable?.name || t('studio_apps_tables.manager.this_table', 'this table') })}
                description={t('studio_apps_tables.manager.delete_desc', 'Removing the table deletes it (and its records) when you save. This can\'t be undone.')}
                confirmLabel={t('studio_apps_tables.manager.delete_confirm', 'Delete table')}
                destructive
                onConfirm={data.deleteTable}
                onCancel={() => data.setConfirmDeleteId(null)}
            />
        </Modal>
    );
}

/**
 * The owner data model behind the table designer: loaded when the modal
 * opens, edited as a draft, saved through PUT /:id/schema (which triggers the
 * server's table migration). Connectors and the directory switch ride on the
 * same model, so one save persists them all.
 */
import { useCallback, useEffect, useState } from 'react';
import { emptyModel, fillersOf, newTableId, uniqueTableKey, withProposedTables } from './tablesManagerModel';
import type { DataModel, ModelConnector, ModelTable } from './tablesManagerModel';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import toast from '../../../../shared/Toast';
import { connectorProblem as connectorProblemJs } from '../bi/ConnectorsManager';
import { studioAppsApi } from '../studioAppsApi';

/** 'tables' | 'rows' | 'connectors' | 'relations' | 'people' */
export type ManagerTab = 'tables' | 'rows' | 'connectors' | 'relations' | 'people';

// The model's connector rows are read looser than the editor's own Connector
// type (their kind is optional on a row the server sent).
const connectorProblem = connectorProblemJs;

/**
 * The first connector that would fail the WHOLE save server-side (422), as
 * the sentence that says which one and what it needs — or null.
 */
function firstConnectorProblem(model: DataModel, t: TranslateFn): string | null {
    for (const c of model.connectors || []) {
        const problem = connectorProblem(c);
        if (problem) return t('studio_apps_tables.manager.connector_problem', '“{name}” {problem}.', { name: c.name || t('studio_apps_tables.manager.this_connector', 'This connector'), problem });
    }
    return null;
}

interface SaveResult {
    ok?: boolean;
    version?: number;
    conflict?: boolean;
    invalid?: boolean;
    errors?: Array<string | { message?: string }>;
    managed?: { message?: string } | null;
    error?: string;
}

/** Reports a save the server refused, in the owner's words. */
function reportRefusal(res: SaveResult, t: TranslateFn, reload: () => void): void {
    if (res.conflict) {
        toast.error(t('studio_apps_tables.manager.conflict', 'The data model changed elsewhere — reloading the latest.'));
        reload();
    } else if (res.invalid) {
        const first = Array.isArray(res.errors) && res.errors.length ? res.errors[0] : null;
        toast.error((typeof first === 'string' ? first : first?.message) || t('studio_apps_tables.manager.invalid', 'The data model is invalid.'));
    } else if (res.managed) {
        // A Solution stage manages this app (409 managed_part).
        toast.error(res.error || res.managed.message || t('studio_apps_tables.manager.managed', 'This app is managed by a Solution stage.'));
    }
}

export function useDataModel(appId: string | null | undefined, open: boolean, t: TranslateFn, refetchSaved: () => unknown) {
    const [model, setModel] = useState<DataModel | null>(null);
    const [modelVersion, setModelVersion] = useState(0);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    // The model exactly as the server last accepted it. Comparing against this
    // snapshot (rather than clearing a flag when a save returns) keeps edits
    // made WHILE that save was in flight marked as unsaved.
    const [savedSnapshot, setSavedSnapshot] = useState('');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<ManagerTab>('tables');

    // Load the editable owner model whenever the modal opens.
    const load = useCallback(async () => {
        if (!appId) { setModel(emptyModel()); return; }
        setLoading(true);
        try {
            const res = await studioAppsApi.getSchema(appId);
            const loaded: DataModel = (res && res.model && typeof res.model === 'object') ? res.model : emptyModel();
            if (!Array.isArray(loaded.tables)) loaded.tables = [];
            setModel(loaded);
            setModelVersion(res?.modelVersion || 0);
            setSavedSnapshot(JSON.stringify(loaded));
            setSelectedId(loaded.tables[0]?.id || null);
        } catch (err) {
            // A missing model (or endpoint) → start from a blank one; still usable.
            const blank = emptyModel();
            setModel(blank);
            setModelVersion(0);
            setSavedSnapshot(JSON.stringify(blank));
            const e = err as { status?: number; message?: string } | null;
            if (e?.status && e.status !== 404) toast.error(e.message || t('studio_apps_tables.manager.load_failed', 'Could not load the data model.'));
        } finally {
            setLoading(false);
        }
    }, [appId, t]);

    useEffect(() => {
        if (open) load();
    }, [open, load]);

    const tables = model?.tables || [];
    const dirty = !!model && JSON.stringify(model) !== savedSnapshot;
    const patch = (fields: Partial<DataModel>) => setModel((m) => ({ ...(m || emptyModel()), ...fields }));
    const patchModel = (nextTables: ModelTable[]) => patch({ tables: nextTables });
    /**
     * Whether this app may read the organisation's member list.
     *
     * OFF unless the owner says otherwise, and stored on the model so it shows
     * up in the schema — an app that quietly grew a directory read would be a
     * privacy change nobody could see. Person pickers load nothing until this
     * is on, which is a much better thing to debug than an empty dropdown.
     */
    const patchDirectory = (orgMembers: boolean) => patch({ directory: { orgMembers } });
    // Connectors ride on the SAME model — the existing save() persists them
    // through PUT /:id/schema alongside the tables.
    const patchConnectors = (nextConnectors: ModelConnector[]) => patch({ connectors: nextConnectors });

    /**
     * A connector proposed one or more tables (from /inspect) and the owner
     * accepted them. Everything lands in ONE model update: a sync whose tableId
     * — or whose child tableId — doesn't resolve fails validation, so writing
     * them across several setState calls would leave a window where the model
     * can't be saved at all.
     *
     * A chain that expands proposes a related SET (messages + attachments joined
     * by a relation column), so this takes an array.
     */
    const createTableForConnector = (connectorId: string, newTables: ModelTable | ModelTable[], sync: ModelConnector['sync']) => {
        const list = Array.isArray(newTables) ? newTables : [newTables];
        if (!list.length) return;
        setModel((m) => withProposedTables(m || emptyModel(), connectorId, list, sync));
        setSelectedId(list[0].id);
        toast.success(list.length > 1
            ? t('studio_apps_tables.manager.added_many', '{n} linked tables added — save your changes to create them and start filling them.', { n: list.length })
            : t('studio_apps_tables.manager.added_one', 'Table added — save your changes to create it and start filling it.'));
    };

    const addTable = () => {
        const name = t('studio_apps_tables.manager.default_name', 'Table {n}', { n: tables.length + 1 });
        const created = { id: newTableId(), key: uniqueTableKey(name, tables), name, fields: [] };
        patchModel([...tables, created]);
        setSelectedId(created.id);
    };

    const renameSelected = (nextTable: ModelTable) => {
        patchModel(tables.map((tbl) => (tbl.id === nextTable.id ? nextTable : tbl)));
    };

    const deleteTable = () => {
        const id = confirmDeleteId;
        setConfirmDeleteId(null);
        if (!id) return;
        // A connector that fills this table would be left pointing at nothing,
        // which the model validator rejects — so say which connector, here,
        // instead of failing the whole save with a 422 after the fact.
        const fillers = fillersOf(model, id);
        if (fillers.length) {
            setActiveTab('connectors');
            toast.error(t('studio_apps_tables.manager.filled_by_connector', '“{name}” fills this table. Stop it filling the table first, then delete it.', { name: fillers[0].name || t('studio_apps_tables.manager.a_connector', 'A connector') }));
            return;
        }
        const next = tables.filter((tbl) => tbl.id !== id);
        patchModel(next);
        if (selectedId === id) setSelectedId(next[0]?.id || null);
    };

    const save = async (): Promise<boolean> => {
        if (!appId || !model) return false;
        const problem = firstConnectorProblem(model, t);
        if (problem) {
            setActiveTab('connectors');
            toast.error(problem);
            return false;
        }
        const sent = model;
        setSaving(true);
        try {
            const res: SaveResult = await studioAppsApi.saveSchema(appId, sent, modelVersion || undefined);
            if (res.ok) {
                setModelVersion(res.version ?? modelVersion);
                setSavedSnapshot(JSON.stringify(sent));
                toast.success(t('studio_apps_tables.manager.saved', 'Data model saved.'));
                refetchSaved();
                return true;
            }
            reportRefusal(res, t, load);
        } catch (err) {
            toast.error((err as { message?: string } | null)?.message || t('studio_apps_tables.manager.save_failed', 'Saving the data model failed.'));
        } finally {
            setSaving(false);
        }
        return false;
    };

    return {
        model, tables, loading, saving, dirty, selectedId, setSelectedId, confirmDeleteId, setConfirmDeleteId,
        activeTab, setActiveTab, patchModel, patchDirectory, patchConnectors, createTableForConnector, addTable,
        renameSelected, deleteTable, save,
    };
}

export type DataModelState = ReturnType<typeof useDataModel>;

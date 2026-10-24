import { AppWindow } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import ConnectorPickerJs from './ConnectorPicker';
import ConnectorEditor from './connectors/ConnectorEditor';
import type { CreateTables } from './connectors/ConnectorEditor';
import type { ModelTable } from '../tables/tablesManagerModel';
import { KindChooser } from './connectors/ConnectorFields';
import ConnectorList from './connectors/ConnectorList';
import { groupConnectors, newConnectorId } from './connectors/connectorModel';
import type { Connector } from './connectors/connectorModel';
import useIntegrationCatalogJs from './useIntegrationCatalog';
import useTranslation from '../../../../../hooks/useTranslation';
import { useEditorChrome } from '../editor/EditorChromeContext';

export { connectorProblem } from './connectors/connectorModel';

/**
 * App Studio BI — the owner's external-connectors editor.
 *
 * A connector is an owner-authored external data source (server contract in
 * server/appStudio/connectors.js + validated by dataModel.js). Three kinds:
 *   integration_tool — dispatch a platform tool with author-pinned fixedArgs
 *   automation       — trigger one of the owner's automations
 *   rest             — GET an https-only, allow-listed URL template
 *
 * ── ONE CONNECTOR = ONE ACTION ──────────────────────────────────────
 * That has always been the model, and it stays: it keeps one row shape per
 * connector, which is what makes a connector map cleanly onto one table and
 * leaves every existing contract (bindings, validation, the runtime, the publish
 * summary) untouched. What changed is the authoring cost — ConnectorPicker is
 * the same multi-select app menu as the agent editor, and ticking five Gmail
 * actions creates five connectors at once instead of five trips through a pair
 * of dropdowns. They are grouped by app in the list so it still reads as "Gmail,
 * five things".
 *
 * The right pane (connectors/ConnectorEditor) answers, in order, the questions
 * an author actually has: what is it → what does the action NEED
 * (ActionParamsForm, from the action's own JSON Schema) → does it need another
 * action first (ConnectorChainEditor) → whose connection → should it fill a
 * table (ConnectorSyncPanel) → does it work (TestPanel) → the raw escape
 * hatches.
 *
 * This is a CONTROLLED component over `model.connectors[]`: it never saves —
 * the parent (TablesManager) owns the model and persists the whole thing through
 * the existing PUT /:id/schema save path, so connectors round-trip with the rest
 * of the data model. Credentials are NEVER entered here as raw values: the rest
 * editor only references the owner's credential store by provider id
 * (auth.credentialProvider) — the server resolves the secret.
 *
 * The endpoints it touches all resolve the connector from the LAST SAVED owner
 * model, so an unsaved draft 404s; that is said out loud rather than shown as a
 * mystery failure. All are rate-limited server-side and only ever fire on a click.
 *
 *   <ConnectorsManager connectors={model.connectors} onChange={next => …} />
 */
export interface ConnectorsManagerProps {
    connectors: Connector[] | undefined;
    onChange: (connectors: Connector[]) => void;
    disabled?: boolean;
    appId?: string | null;
    tables?: ModelTable[];
    onCreateTable?: CreateTables;
    saved?: boolean;
    onSave?: (() => unknown) | null;
}

interface PickerSelection {
    add?: Array<{ name: string; tool: string; integrationId?: string }>;
    remove?: string[];
}

const ConnectorPicker = ConnectorPickerJs;
const useIntegrationCatalog = useIntegrationCatalogJs;

function PickPrompt({ onPick, disabled }: { onPick: () => void; disabled?: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-sm text-[var(--text-tertiary)]">
            {t('studio_apps_bi.connectors.pick_connector', 'Pick a connector on the left, or add one to get started.')}
            <button
                type="button"
                onClick={onPick}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-primary)]"
            >
                <AppWindow className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
                {t('studio_apps_bi.connectors.choose_apps', 'Choose apps & actions')}
            </button>
        </div>
    );
}

export default function ConnectorsManager({
    connectors, onChange, disabled = false, appId = null, tables = [], onCreateTable, saved = true, onSave = null,
}: ConnectorsManagerProps) {
    const { t } = useTranslation();
    const list = useMemo(() => (Array.isArray(connectors) ? connectors : []), [connectors]);
    const [selectedId, setSelectedId] = useState<string | null>(list[0]?.id || null);
    const [adding, setAdding] = useState(false);
    const [picking, setPicking] = useState(false);
    const selected = list.find((c) => c.id === selectedId) || null;
    const catalog = useIntegrationCatalog();
    // The app id the "Test it" call needs; the editor shell publishes it, and a
    // prop wins for callers that already hold one.
    const chrome = useEditorChrome() as { appId?: string | null } | null;
    const effectiveAppId = appId || chrome?.appId || null;

    const createConnector = (kind: string) => {
        const c: Connector = { id: newConnectorId(), kind, name: t('studio_apps_bi.connectors.default_name', 'Connector {n}', { n: list.length + 1 }), params: [] };
        onChange([...list, c]);
        setSelectedId(c.id);
        setAdding(false);
    };
    const updateSelected = (next: Connector) => onChange(list.map((c) => (c.id === next.id ? next : c)));
    const removeConnector = (id: string) => {
        const next = list.filter((c) => c.id !== id);
        onChange(next);
        if (selectedId === id) setSelectedId(next[0]?.id || null);
    };

    /**
     * Apply a picker selection: one connector per newly-ticked action, and drop
     * the ones whose action was un-ticked. A removed connector that fills a table
     * would leave a dangling sync.tableId, which the model validator rejects — so
     * the sync block goes with it rather than blocking the next save.
     */
    const applyPicker = ({ add, remove }: PickerSelection) => {
        const removeSet = new Set(remove || []);
        const kept = list.filter((c) => !removeSet.has(c.id));
        const created: Connector[] = (add || []).map((a) => ({
            id: newConnectorId(),
            kind: 'integration_tool',
            name: a.name,
            tool: a.tool,
            ...(a.integrationId ? { integrationId: a.integrationId } : {}),
            params: [],
        }));
        onChange([...kept, ...created]);
        if (created.length) setSelectedId(created[0].id);
        else if (removeSet.has(selectedId as string)) setSelectedId(kept[0]?.id || null);
        setAdding(false);
    };

    const grouped = useMemo(() => groupConnectors(list, catalog, t), [list, catalog, t]);
    // Nothing to pick from yet → skip the empty pane and ask the one question.
    const choosing = adding || list.length === 0;

    return (
        <div className="flex gap-4 min-h-[22rem]">
            <ConnectorList list={list} grouped={grouped} selectedId={selectedId} adding={adding} choosing={choosing} catalog={catalog}
                disabled={disabled} onSelect={(id) => { setAdding(false); setSelectedId(id); }} onRemove={removeConnector}
                onPick={() => setPicking(true)} onAdd={() => setAdding(true)} />

            {/* Editor */}
            <div className="min-w-0 flex-1">
                {choosing ? (
                    <KindChooser
                        onCreate={createConnector}
                        onCancel={list.length ? () => setAdding(false) : null}
                        onPickApps={() => { setAdding(false); setPicking(true); }}
                        disabled={disabled}
                    />
                ) : selected ? (
                    <ConnectorEditor
                        key={selected.id}
                        connector={selected}
                        onChange={updateSelected}
                        disabled={disabled}
                        appId={effectiveAppId}
                        tables={tables}
                        onCreateTable={onCreateTable}
                        saved={saved}
                        onSave={onSave}
                        catalog={catalog}
                    />
                ) : <PickPrompt onPick={() => setPicking(true)} disabled={disabled} />}
            </div>

            {picking ? (
                <ConnectorPicker connectors={list} onApply={applyPicker} onClose={() => setPicking(false)} />
            ) : null}
        </div>
    );
}

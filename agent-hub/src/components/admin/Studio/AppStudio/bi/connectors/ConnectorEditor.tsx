import { AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AutomationField, JsonObjectField, ParamsEditor, TextField } from './ConnectorFields';
import { INPUT, LABEL, availableFieldsOf, chainSuggestionsOf, connectorProblem, kinds } from './connectorModel';
import type { Connector, InspectResult, IntegrationCatalog } from './connectorModel';
import { AppToolFields, RestFields } from './KindFields';
import MailboxFields from './MailboxFields';
import TestPanel from './TestPanel';
import useTranslation from '../../../../../../hooks/useTranslation';
import Disclosure from '../../../../../shared/Disclosure';
import ConnectorSyncPanelJs from '../ConnectorSyncPanel';
import type { ModelTable } from '../../tables/tablesManagerModel';

/** Adds the tables a connector proposed and points its sync at them, in one model update. */
export type CreateTables = (connectorId: string, tables: ModelTable[], sync: Connector['sync']) => void;

const ConnectorSyncPanel = ConnectorSyncPanelJs;

export interface ConnectorEditorProps {
    connector: Connector;
    onChange: (connector: Connector) => void;
    disabled?: boolean;
    appId: string | null;
    tables: ModelTable[];
    onCreateTable?: CreateTables;
    saved?: boolean;
    onSave?: (() => unknown) | null;
    catalog: IntegrationCatalog;
}

/** The three ways the editor writes a connector back. */
function connectorWriters(connector: Connector, onChange: (connector: Connector) => void) {
    // A patch value of `undefined` REMOVES the key rather than parking it as an
    // own property — a leftover `chain: undefined` reads as absent over the
    // wire but not to code that asks `'chain' in connector`.
    const set = (p: Record<string, unknown>) => {
        const next: Connector = { ...connector, ...p };
        for (const [k, v] of Object.entries(p)) if (v === undefined) delete next[k];
        onChange(next);
    };
    // Nullable text: '' clears the field (dropped from the object).
    const setOpt = (k: string, v: unknown) => { const next: Connector = { ...connector }; if (v === '' || v == null) delete next[k]; else next[k] = v; onChange(next); };
    // Patch several keys at once; `undefined`/'' removes a key rather than
    // storing an empty value (the model validator rejects empty optionals).
    const patch = (p: Record<string, unknown>) => { const next: Connector = { ...connector }; for (const [k, v] of Object.entries(p)) { if (v === '' || v == null) delete next[k]; else next[k] = v; } onChange(next); };
    return { set, setOpt, patch };
}

function ProblemNote({ problem }: { problem: string }) {
    const { t } = useTranslation();
    return (
        <p
            className="flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs"
            style={{ borderColor: 'rgba(217, 119, 6, 0.4)', background: 'rgba(217, 119, 6, 0.1)', color: '#d97706' }}
        >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t('studio_apps_bi.connectors.this_connector', 'This connector {problem}.', { problem })}</span>
        </p>
    );
}

/** Name, and where the data comes from. */
function IdentityFields({ connector, set, disabled }: { connector: Connector; set: (p: Record<string, unknown>) => void; disabled?: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-2 gap-2">
            <TextField label={t('studio_apps_bi.connectors.name', 'Name')} value={connector.name} onChange={(v) => set({ name: v })} disabled={disabled} placeholder={t('studio_apps_bi.connectors.name_placeholder', 'Recent emails')} />
            <label className="flex flex-col gap-1">
                <span className={LABEL}>{t('studio_apps_bi.connectors.gets_data_from', 'Gets data from')}</span>
                <select
                    className={INPUT}
                    value={connector.kind}
                    // A `chain` is only legal on an app connector
                    // (dataModel.js: "chain is only supported for app
                    // connectors"), and the chain editor is only RENDERED
                    // for one — so switching the kind away left the steps
                    // behind, invisible, and the data model could never be
                    // saved again. The error named a field the screen no
                    // longer showed.
                    onChange={(e) => set(e.target.value === 'integration_tool'
                        ? { kind: e.target.value }
                        : { kind: e.target.value, chain: undefined })}
                    disabled={disabled}
                    aria-label={t('studio_apps_bi.connectors.connector_kind', 'Connector kind')}
                >
                    {kinds(t).map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
            </label>
        </div>
    );
}

/**
 * The raw fields. The form above writes these — this is the escape hatch for
 * an action the catalog can't describe, or a parameter its schema doesn't
 * declare. The REST kind keeps its own disclosure (URL, auth and paging are
 * its whole configuration).
 */
function RawFields({ connector, set, setOpt, disabled }: { connector: Connector; set: (p: Record<string, unknown>) => void; setOpt: (k: string, v: unknown) => void; disabled?: boolean }) {
    const { t } = useTranslation();
    if (connector.kind !== 'integration_tool') {
        return <ParamsEditor params={connector.params} onChange={(params) => set({ params })} disabled={disabled} />;
    }
    return (
        <Disclosure title={t('studio_apps_bi.connectors.advanced', 'Advanced settings')}>
            <div className="flex flex-col gap-3">
                <TextField label={t('studio_apps_bi.connectors.tool', 'Tool')} value={connector.tool} onChange={(v) => setOpt('tool', v)} disabled={disabled} placeholder="gmail_list_messages" />
                <TextField label={t('studio_apps_bi.connectors.rows_path', 'Rows path')} value={connector.rowsPath} onChange={(v) => setOpt('rowsPath', v)} disabled={disabled} placeholder="results" />
                <p className="-mt-2 text-xs text-[var(--text-tertiary)]">
                    {t('studio_apps_bi.connectors.rows_path_hint', 'Only needed when a response holds more than one list and we can’t tell which one holds the rows.')}
                </p>
                <JsonObjectField label={t('studio_apps_bi.connectors.pinned_args', 'Pinned arguments (fixedArgs)')} value={connector.fixedArgs} onChange={(v) => setOpt('fixedArgs', v)} disabled={disabled} placeholder={'{ "labelIds": ["INBOX"] }'} />
                <ParamsEditor params={connector.params} onChange={(params) => set({ params })} disabled={disabled} />
            </div>
        </Disclosure>
    );
}

/**
 * One connector's editor. It answers, in order, the questions an author
 * actually has: what is it → what does the action NEED → does it need another
 * action first → whose connection → should it fill a table → does it work →
 * the raw escape hatches.
 */
export default function ConnectorEditor({ connector, onChange, disabled, appId, tables, onCreateTable, saved, onSave, catalog }: ConnectorEditorProps) {
    const { t } = useTranslation();
    const { set, setOpt, patch } = connectorWriters(connector, onChange);

    const hit = connector.kind === 'integration_tool' && connector.tool ? catalog.lookup(connector.tool) : null;
    const action = hit?.action || null;
    const problem = connectorProblem(connector, action, t);

    // What /inspect learned; the chain editor's fields and suggestions fall
    // back to the catalog until it has run.
    const [inspected] = useState<InspectResult | null>(null);
    const availableFields = useMemo(() => availableFieldsOf(inspected, action), [inspected, action]);
    const suggestions = useMemo(
        () => chainSuggestionsOf(inspected, action, catalog, connector, t),
        [inspected, action, catalog, connector, t],
    );

    return (
        <div className="flex flex-col gap-3">
            {problem ? <ProblemNote problem={problem} /> : null}
            <IdentityFields connector={connector} set={set} disabled={disabled} />

            {connector.kind === 'integration_tool' ? (
                <AppToolFields connector={connector} action={action} appUnavailable={hit?.app?.available === false} catalogFailed={catalog.failed}
                    availableFields={availableFields} suggestions={suggestions} patch={patch} setOpt={setOpt} disabled={disabled} />
            ) : null}

            {connector.kind === 'automation' ? (
                <AutomationField connector={connector} onChangeId={(v) => setOpt('automationId', v)} disabled={disabled} />
            ) : null}

            {connector.kind === 'mailbox' ? (
                <MailboxFields connector={connector} setOpt={setOpt} disabled={disabled} appId={appId} saved={saved} />
            ) : null}

            {connector.kind === 'rest' ? <RestFields connector={connector} setOpt={setOpt} disabled={disabled} /> : null}

            <ConnectorSyncPanel
                connector={connector}
                tables={tables}
                appId={appId}
                onChange={patch}
                onCreateTable={(table, sync) => onCreateTable?.(connector.id, [table], sync)}
                onCreateTables={(newTables, sync) => onCreateTable?.(connector.id, newTables, sync)}
                disabled={disabled}
                saved={saved}
                onSave={onSave}
            />

            <TestPanel connector={connector} appId={appId} disabled={disabled} problem={problem} />

            <RawFields connector={connector} set={set} setOpt={setOpt} disabled={disabled} />
        </div>
    );
}

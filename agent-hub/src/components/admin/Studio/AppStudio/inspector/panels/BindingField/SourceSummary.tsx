import useTranslation from '../../../../../../../hooks/useTranslation';
import useAppTables from '../../../bi/useAppTables';
import useConnectors from '../../../bi/useConnectors';
import useDatasets from '../../../bi/useDatasets';
import type { TableNameProps, DatasetNameProps, ConnectorNameProps, NamedProps, SourceSentenceProps, SourceSummaryProps } from '../BindingField.types';
import { slotted } from './BindingField.helpers';

// Names live in the app's data model, so each lookup is its own component —
// the hook only mounts for the kind that needs it.
function TableName({ appId, tableId }: TableNameProps) {
    const { tables } = useAppTables(appId);
    const t = tables.find((x) => x && (x.id === tableId || x.key === tableId));
    return <>{t?.name || t?.key || tableId}</>;
}

function DatasetName({ appId, datasetId }: DatasetNameProps) {
    const { datasets } = useDatasets(appId);
    const d = datasets.find((x) => x && x.id === datasetId);
    return <>{d?.name || datasetId}</>;
}

function ConnectorName({ appId, connectorId }: ConnectorNameProps) {
    const { connectors } = useConnectors(appId);
    const c = connectors.find((x) => x && x.id === connectorId);
    return <>{c?.name || connectorId}</>;
}

function Named({ appId, kind, id }: NamedProps) {
    if (!appId) return <span className="font-medium">{id}</span>;
    const inner = kind === 'table' ? <TableName appId={appId} tableId={id} />
        : kind === 'dataset' ? <DatasetName appId={appId} datasetId={id} />
            : <ConnectorName appId={appId} connectorId={id} />;
    return <span className="font-medium">“{inner}”</span>;
}

function SourceSentence({ binding, appId }: SourceSentenceProps) {
    const { t } = useTranslation();
    const kind = binding.kind;
    if (kind === 'record' || kind === 'records') {
        if (!binding.tableId) return <>{t('studio_apps_panels.binding.sentence_records_unset', 'Rows from a table — pick which one below.')}</>;
        const name = <Named appId={appId} kind="table" id={binding.tableId} />;
        return kind === 'record'
            ? <>{slotted(t('studio_apps_panels.binding.sentence_record', 'Showing: the first row of {name}.'), { name })}</>
            : <>{slotted(t('studio_apps_panels.binding.sentence_records', 'Showing: rows from {name}.'), { name })}</>;
    }
    if (kind === 'dataset') {
        if (!binding.datasetId) return <>{t('studio_apps_panels.binding.sentence_dataset_unset', 'A saved view — pick which one below.')}</>;
        return <>{slotted(t('studio_apps_panels.binding.sentence_dataset', 'Showing: the saved view {name}.'), { name: <Named appId={appId} kind="dataset" id={binding.datasetId} /> })}</>;
    }
    if (kind === 'connector') {
        if (!binding.connectorId) return <>{t('studio_apps_panels.binding.sentence_connector_unset', 'Another system — pick which one below.')}</>;
        return <>{slotted(t('studio_apps_panels.binding.sentence_connector', 'Showing: rows from {name}.'), { name: <Named appId={appId} kind="connector" id={binding.connectorId} /> })}</>;
    }
    if (kind === 'actionResult') {
        if (!binding.actionId) return <>{t('studio_apps_panels.binding.sentence_action_unset', 'The result of an automation — pick which one below.')}</>;
        return <>{t('studio_apps_panels.binding.sentence_action', 'Showing: what an automation sends back.')}</>;
    }
    if (kind === 'aggregate') {
        if (!binding.tableId) return <>{t('studio_apps_panels.binding.sentence_aggregate_unset', 'A count or total — pick the table below.')}</>;
        const name = <Named appId={appId} kind="table" id={binding.tableId} />;
        const what = (binding.aggregates || []).map((a) => a?.fn).filter(Boolean).join(' + ') || 'count';
        const by = (binding.groupBy || []).map((g) => g?.field).filter(Boolean);
        return <>{by.length
            ? slotted(t('studio_apps_panels.binding.sentence_aggregate_by', 'Showing: the {what} of {name}, per {by}.'), { what, name, by: by.join(t('studio_apps_panels.binding.and_join', ' and ')) })
            : slotted(t('studio_apps_panels.binding.sentence_aggregate', 'Showing: the {what} of {name}.'), { what, name })}</>;
    }
    if (kind === 'formula') return <>{t('studio_apps_panels.binding.sentence_formula', 'Showing: a value worked out on the page.')}</>;
    return <>{t('studio_apps_panels.binding.sentence_static', 'Showing: values typed in here.')}</>;
}

export function SourceSummary({ binding, appId, onChangeClick, disabled }: SourceSummaryProps) {
    const { t } = useTranslation();
    return (
        <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 text-sm text-[var(--text-primary)]">
                <SourceSentence binding={binding} appId={appId} />
            </p>
            <button
                type="button"
                onClick={onChangeClick}
                disabled={disabled}
                className="shrink-0 text-xs font-medium text-[var(--accent-primary)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {t('studio_apps_panels.binding.change', 'Change')}
            </button>
        </div>
    );
}

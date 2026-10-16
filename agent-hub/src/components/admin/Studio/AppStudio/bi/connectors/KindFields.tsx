/**
 * The kind-specific parts of a connector's editor: an app action (its params,
 * its chain, whose connection) and a web address (URL, auth, paging).
 */
import type { ComponentType } from 'react';
import { JsonObjectField, TextField } from './ConnectorFields';
import { INPUT, LABEL } from './connectorModel';
import type { CatalogAction, ChainSuggestion, Connector } from './connectorModel';
import type { SetOpt } from './MailboxFields';
import { getIntegrationIcon } from '../../../../../../config/integrationIcons';
import useTranslation from '../../../../../../hooks/useTranslation';
import Disclosure from '../../../../../shared/Disclosure';
import ActionParamsFormJs from '../ActionParamsForm';
import ConnectorChainEditorJs from '../ConnectorChainEditor';

/** Patches several keys at once; `undefined`/'' removes a key. */
export type PatchConnector = (patch: Record<string, unknown>) => void;

// Typed views of the .jsx editors, whose `= false` / `= []` defaults would mistype their props.
const ActionParamsForm = ActionParamsFormJs;
const ConnectorChainEditor = ConnectorChainEditorJs as unknown as ComponentType<{
    connector: Connector;
    onChange: PatchConnector;
    availableFields: Array<{ sourcePath: string; key: string }>;
    suggestions: ChainSuggestion[];
    disabled?: boolean;
}>;

interface AppToolFieldsProps {
    connector: Connector;
    action: CatalogAction | null;
    appUnavailable: boolean;
    catalogFailed: boolean;
    availableFields: Array<{ sourcePath: string; key: string }>;
    suggestions: ChainSuggestion[];
    patch: PatchConnector;
    setOpt: SetOpt;
    disabled?: boolean;
}

/** An app connector: what it is, what the action NEEDS, its chain, and whose connection. */
export function AppToolFields({ connector, action, appUnavailable, catalogFailed, availableFields, suggestions, patch, setOpt, disabled }: AppToolFieldsProps) {
    const { t } = useTranslation();
    return (
        <>
            <div className="flex items-center gap-2 rounded-md border px-2.5 py-2 border-[var(--border-default)]">
                <div className="w-5 h-5 flex items-center justify-center shrink-0">
                    {getIntegrationIcon(connector.integrationId || '')}
                </div>
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                    {action?.label || connector.tool || t('studio_apps_bi.connectors.no_action', 'No action chosen yet')}
                </span>
                {appUnavailable ? (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide" style={{ color: '#d97706' }}>{t('studio_apps_bi.connectors.not_connected', 'not connected')}</span>
                ) : null}
            </div>

            <ActionParamsForm action={action} connector={connector} onChange={patch} disabled={disabled} catalogUnavailable={catalogFailed} />

            <ConnectorChainEditor connector={connector} onChange={patch} availableFields={availableFields} suggestions={suggestions} disabled={disabled} />

            <label className="flex flex-col gap-1">
                <span className={LABEL}>{t('studio_apps_bi.connectors.runs_with', 'Runs with')}</span>
                <select
                    className={INPUT}
                    value={connector.runAs === 'viewer' ? 'viewer' : 'owner'}
                    onChange={(e) => setOpt('runAs', e.target.value === 'viewer' ? 'viewer' : '')}
                    disabled={disabled}
                    aria-label={t('studio_apps_bi.connectors.connector_identity', 'Connector identity')}
                >
                    <option value="owner">{t('studio_apps_bi.connectors.runs_owner', 'My connection — viewers never need their own')}</option>
                    <option value="viewer">{t('studio_apps_bi.connectors.runs_viewer', 'Each user\'s own connection — viewers must connect the app')}</option>
                </select>
            </label>
        </>
    );
}

/** A REST connector's auth: type, header and the saved credential it references. */
function RestAuthFields({ connector, setOpt, disabled }: { connector: Connector; setOpt: SetOpt; disabled?: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1">
                <span className={LABEL}>{t('studio_apps_bi.connectors.auth_type', 'Auth type')}</span>
                <select
                    className={INPUT}
                    value={connector.auth?.type || ''}
                    onChange={(e) => setOpt('auth', e.target.value ? { ...(connector.auth || {}), type: e.target.value } : undefined)}
                    disabled={disabled}
                    aria-label={t('studio_apps_bi.connectors.auth_type', 'Auth type')}
                >
                    <option value="">{t('studio_apps_bi.connectors.auth_none', 'None')}</option>
                    <option value="bearer">Bearer</option>
                    <option value="header">Header</option>
                </select>
            </label>
            <TextField
                label={t('studio_apps_bi.connectors.auth_header', 'Auth header')}
                value={connector.auth?.header}
                onChange={(v) => setOpt('auth', { ...(connector.auth || {}), header: v || undefined })}
                disabled={disabled || connector.auth?.type !== 'header'}
                placeholder="X-Api-Key"
            />
            <TextField
                label={t('studio_apps_bi.connectors.credential_provider', 'Credential provider')}
                value={connector.auth?.credentialProvider}
                onChange={(v) => setOpt('auth', { ...(connector.auth || {}), credentialProvider: v || undefined })}
                disabled={disabled || !connector.auth?.type}
                placeholder="example"
            />
        </div>
    );
}

/** A REST connector: the URL template, and auth and paging one disclosure deeper. */
export function RestFields({ connector, setOpt, disabled }: { connector: Connector; setOpt: SetOpt; disabled?: boolean }) {
    const { t } = useTranslation();
    return (
        <>
            <TextField label={t('studio_apps_bi.connectors.url_template', 'URL template (https)')} value={connector.url} onChange={(v) => setOpt('url', v)} disabled={disabled} placeholder="https://api.example.com/items?q={q}" />
            <p className="-mt-1 text-xs text-[var(--text-tertiary)]">{t('studio_apps_bi.connectors.url_hint', 'Use {placeholder} placeholders for declared params. The host is fixed — it may not be templated.', { placeholder: '{param}' })}</p>
            <Disclosure title={t('studio_apps_bi.connectors.advanced', 'Advanced settings')}>
                <div className="flex flex-col gap-3">
                    <JsonObjectField label={t('studio_apps_bi.connectors.static_headers', 'Static headers')} value={connector.headers} onChange={(v) => setOpt('headers', v)} disabled={disabled} placeholder={'{ "X-Api-Version": "2" }'} />
                    <RestAuthFields connector={connector} setOpt={setOpt} disabled={disabled} />
                    <div className="grid grid-cols-3 gap-2">
                        <TextField label={t('studio_apps_bi.connectors.rows_path', 'Rows path')} value={connector.rowsPath} onChange={(v) => setOpt('rowsPath', v)} disabled={disabled} placeholder="data.items" />
                        <TextField label={t('studio_apps_bi.connectors.next_page_path', 'Next-page path')} value={connector.nextPagePath} onChange={(v) => setOpt('nextPagePath', v)} disabled={disabled} placeholder="data.next_cursor" />
                        <label className="flex flex-col gap-1">
                            <span className={LABEL}>{t('studio_apps_bi.connectors.max_rows', 'Max rows')}</span>
                            <input
                                type="number"
                                className={INPUT}
                                value={connector.maxRows ?? ''}
                                min={1}
                                max={500}
                                onChange={(e) => { const n = Number(e.target.value); setOpt('maxRows', e.target.value === '' || !Number.isFinite(n) ? '' : Math.max(1, Math.min(500, Math.round(n)))); }}
                                disabled={disabled}
                                aria-label={t('studio_apps_bi.connectors.max_rows', 'Max rows')}
                            />
                        </label>
                    </div>
                    <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_bi.connectors.never_paste_keys', 'Never paste API keys here — reference a saved credential by provider id. The server attaches the owner\'s secret.')}</p>
                </div>
            </Disclosure>
        </>
    );
}

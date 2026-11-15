import { Button } from '@/components/shared/Button';
import { ALERT_ERROR, INPUT } from '@/components/shared/adminUi';
import { useTranslation } from '@/hooks/useTranslation';
import { AccessCheckCard } from './N8nStatus';
import type { N8nConnection } from './useN8nState';

/** The instance URL and API key, Save / Test, and the access check once configured. */
export default function N8nConnectionTab({ conn, saving, onGotoPermissions }: { conn: N8nConnection; saving: boolean; onGotoPermissions: () => void }) {
    const { t } = useTranslation();
    const { n8nUrl, apiKey, hasApiKey, testing, testResult } = conn;
    return (
        <div className="space-y-4">
            {conn.configured && (
                <AccessCheckCard
                    diag={conn.diag}
                    loading={conn.diagLoading}
                    onRefresh={conn.loadDiagnostics}
                    onEnableForOrg={conn.enableForOrg}
                    enablingForOrg={conn.enablingForOrg}
                    onGotoPermissions={onGotoPermissions}
                />
            )}
            <div>
                <label className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">{t('settings.n8n.instance_url', 'n8n Instance URL')}</label>
                <input
                    type="url" value={n8nUrl} onChange={e => conn.setN8nUrl(e.target.value)}
                    placeholder="https://n8n.yourdomain.com"
                    className={INPUT}
                />
                <p className="text-[11px] mt-1 text-[var(--text-muted)]">
                    {t('settings.n8n.instance_url_hint', 'Base URL of your n8n instance. `/api/v1` is appended automatically.')}
                </p>
            </div>
            <div>
                {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                <label className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">{t('settings.n8n.api_key', 'API Key')}</label>
                <input
                    type="password" value={apiKey} onChange={e => conn.setApiKey(e.target.value)}
                    /* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */
                    placeholder={hasApiKey ? '••••••••••••••••' : t('settings.n8n.api_key_placeholder', 'Enter your n8n API key')}
                    className={INPUT}
                />
                <p className="text-[11px] mt-1 text-[var(--text-muted)]">
                    {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                    {t('settings.n8n.api_key_hint', 'Generate at n8n → Settings → API → Create API Key. Stored encrypted.')}
                </p>
            </div>
            <div className="flex items-center gap-2">
                <Button variant="primary" onClick={conn.saveConnection} busy={saving} disabled={!n8nUrl}>
                    {saving ? t('settings.n8n.saving', 'Saving...') : t('settings.n8n.save_connection', 'Save Connection')}
                </Button>
                <Button variant="secondary" onClick={conn.testConnection} busy={testing} disabled={!n8nUrl || (!apiKey && !hasApiKey)}>
                    {testing ? t('settings.n8n.testing', 'Testing...') : t('settings.n8n.test_connection', 'Test Connection')}
                </Button>
            </div>
            {testResult && !testResult.ok && (
                <div role="alert" className={ALERT_ERROR}>
                    {testResult.error || `HTTP ${testResult.status || '?'}`}
                </div>
            )}
        </div>
    );
}

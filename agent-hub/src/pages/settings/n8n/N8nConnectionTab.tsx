import { Loader2 } from 'lucide-react';
import { useTranslation } from '../../../hooks/useTranslation';
import { AccessCheckCard } from './N8nStatus';
import type { N8nConnection } from './useN8nState';

const FIELD_STYLE = { borderColor: 'var(--border-default)', color: 'var(--text-primary)' };

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
                    className="w-full px-3 py-2 text-sm rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)]"
                    style={FIELD_STYLE}
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
                    className="w-full px-3 py-2 text-sm rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)]"
                    style={FIELD_STYLE}
                />
                <p className="text-[11px] mt-1 text-[var(--text-muted)]">
                    {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                    {t('settings.n8n.api_key_hint', 'Generate at n8n → Settings → API → Create API Key. Stored encrypted.')}
                </p>
            </div>
            <div className="flex items-center gap-2">
                <button
                    onClick={conn.saveConnection} disabled={saving || !n8nUrl}
                    className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)', color: 'white' }}
                >
                    {saving ? t('settings.n8n.saving', 'Saving...') : t('settings.n8n.save_connection', 'Save Connection')}
                </button>
                <button
                    onClick={conn.testConnection} disabled={testing || !n8nUrl || (!apiKey && !hasApiKey)}
                    className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 border"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', background: 'transparent' }}
                >
                    {testing ? <><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />{t('settings.n8n.testing', 'Testing...')}</> : t('settings.n8n.test_connection', 'Test Connection')}
                </button>
            </div>
            {testResult && !testResult.ok && (
                <div className="text-[11px] rounded-lg border px-3 py-2" style={{ background: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.2)', color: '#ef4444' }}>
                    {testResult.error || `HTTP ${testResult.status || '?'}`}
                </div>
            )}
        </div>
    );
}

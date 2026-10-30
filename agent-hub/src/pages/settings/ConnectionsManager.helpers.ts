import { API_BASE } from '../../utils/helpers';
import { HTTP_AUTH_TYPES, httpKindName } from '../../utils/httpCredentialTypes';
import type { ProviderSpec, Connection } from './ConnectionsManager.types';
import { logger } from '../../utils/logger';

export const BASE = `${API_BASE}/api/integrations/connections`;

export const EMERALD = '#059669';

// Providers that support multiple named API-key / basic connections. The field
// keys MUST match the server's legacy mirror map so the default connection
// keeps the existing integration code working.
//
// `labelKey` is the i18n key; `label` is the English fallback.
export const PROVIDERS: ProviderSpec[] = [
    { id: 'fireflies', name: 'Fireflies.ai', kind: 'api_key', fields: [{ key: 'api_key', label: 'API key', labelKey: 'connections.field_api_key', type: 'password' }] },
    { id: 'gamma', name: 'Gamma', kind: 'api_key', fields: [{ key: 'api_key', label: 'API key', labelKey: 'connections.field_api_key', type: 'password' }] },
    { id: 'github', name: 'GitHub', kind: 'api_key', fields: [{ key: 'token', label: 'Personal access token', labelKey: 'connections.field_pat', type: 'password' }] },
    { id: 'youtrack', name: 'YouTrack', kind: 'basic', fields: [{ key: 'url', label: 'Instance URL', labelKey: 'connections.field_instance_url', type: 'text' }, { key: 'token', label: 'Permanent token', labelKey: 'connections.field_permanent_token', type: 'password' }] },
    { id: 'signrequest', name: 'SignRequest', kind: 'basic', fields: [{ key: 'subdomain', label: 'Subdomain', labelKey: 'connections.field_subdomain', type: 'text' }, { key: 'token', label: 'API token', labelKey: 'connections.field_api_token', type: 'password' }] },
    { id: 'afas-profit', name: 'AFAS Profit', kind: 'basic', fields: [{ key: 'member_number', label: 'Member number (digits, e.g. 12345)', labelKey: 'connections.field_member_number', type: 'text' }, { key: 'token', label: 'AppConnector token (XML or code)', labelKey: 'connections.field_afas_token', type: 'password' }, { key: 'env_type', label: 'Environment (production / test / accept)', labelKey: 'connections.field_afas_env', type: 'text' }] },
    { id: 'vplan', name: 'vPlan', kind: 'basic', fields: [{ key: 'api_env', label: 'API env', labelKey: 'connections.field_vplan_env', type: 'text' }, { key: 'api_key', label: 'API key', labelKey: 'connections.field_vplan_key', type: 'password' }] },
    { id: 'firebird', name: 'Firebird database', kind: 'basic', fields: [{ key: 'host', label: 'Server', labelKey: 'connections.field_firebird_host', type: 'text' }, { key: 'port', label: 'Port (default 3050)', labelKey: 'connections.field_firebird_port', type: 'text' }, { key: 'database', label: 'Database (alias or path)', labelKey: 'connections.field_firebird_database', type: 'text' }, { key: 'user', label: 'User', labelKey: 'connections.field_firebird_user', type: 'text' }, { key: 'password', label: 'Password', labelKey: 'connections.field_firebird_password', type: 'password' }, { key: 'charset', label: 'Character set (default UTF8)', labelKey: 'connections.field_firebird_charset', type: 'text' }] },
    { id: 'scaleway-billing', name: 'Scaleway Billing', kind: 'basic', fields: [{ key: 'secret_key', label: 'Secret key', labelKey: 'connections.field_scaleway_billing_key', type: 'password' }, { key: 'organization_id', label: 'Organization ID', labelKey: 'connections.field_scaleway_billing_org', type: 'text' }] },
    { id: 'nmbrs', name: 'NMBRS', kind: 'basic', fields: [{ key: 'api_mode', label: 'API (soap / rest)', labelKey: 'connections.field_nmbrs_mode', type: 'text' }, { key: 'subdomain', label: 'Subdomain (e.g. mycompany)', labelKey: 'connections.field_nmbrs_subdomain', type: 'text' }, { key: 'email', label: 'Login email (SOAP only)', labelKey: 'connections.field_nmbrs_email', type: 'text' }, { key: 'token', label: 'API token', labelKey: 'connections.field_api_token', type: 'password' }, { key: 'env', label: 'Environment (production / sandbox)', labelKey: 'connections.field_nmbrs_env', type: 'text' }] },
    // Reusable HTTP credentials for the automation http_request step. The
    // auth type picks the kind + fields; each field's `target` routes it to
    // the encrypted `secret` blob or the plaintext `secretMeta` on submit.
    { id: 'http', name: 'HTTP API (custom)', authTypes: HTTP_AUTH_TYPES },
];

export const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map(p => [p.id, p]));

export const EXPIRY_OPTIONS = [
    { labelKey: 'connections.expiry_none', label: 'No expiry', value: '' },
    { labelKey: 'connections.expiry_7d', label: '7 days', value: 7 },
    { labelKey: 'connections.expiry_30d', label: '30 days', value: 30 },
    { labelKey: 'connections.expiry_90d', label: '90 days', value: 90 },
];

export const inputStyle = { background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' };

export const inputCls = 'px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors';

export function daysFromNowIso(days: number) {
    if (!days) return null;
    return new Date(Date.now() + days * 86400000).toISOString();
}

// Pull a server error message out of a failed response, falling back to a
// translated generic. Mutations used to ignore !res.ok entirely, so a rejected
// rename or delete looked like it had worked until the list reloaded.
export async function errorFrom(res: Response, fallback: string) {
    try {
        const body = await res.json();
        if (body && typeof body.error === 'string' && body.error) return body.error;
    } catch (err) { logger.debug('empty or non-JSON body', err); }
    return fallback;
}

// Kind + display metadata line for an HTTP credential card. secretMeta is
// plaintext display-only data by API contract (headerName / tokenUrl /
// username / clientIdHint) — actual secret values are never returned.
export function httpMetaSummary(connection: Connection) {
    const meta = connection.secretMeta || {};
    const bits = [httpKindName(connection.kind)];
    if (meta.headerName) bits.push(meta.headerName);
    if (meta.username) bits.push(meta.username);
    if (meta.tokenUrl) bits.push(meta.tokenUrl);
    if (meta.clientIdHint) bits.push(`client ${meta.clientIdHint}`);
    if (meta.scope) bits.push(meta.scope);
    return bits.join(' · ');
}

import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../../utils/helpers';
import { integrationsAdminKeys, useConnectionLendingQuery } from '../../api/queries/integrationsAdmin';
import { mutate } from '../../api/mutate';
import useTranslation from '../../hooks/useTranslation';

/**
 * ConnectionPolicyPicker — per-integration "Bring-your-own (default) vs Lend my
 * connection" control for a shared resource (agent / webpage / skill / automation).
 *
 * "Lend" creates a connection_grants row bound to this resource (granteeType
 * 'org' — same-org users who can access the resource borrow the owner's
 * connection, full delegation). "BYO" = no grant (recipients connect their own).
 *
 * Only renders providers the resource uses AND the owner has a named connection
 * for — there's nothing to lend otherwise.
 */

const BASE = `${API_BASE}/api/integrations/connections`;

// Providers that support lending today (API-key / basic named connections).
const LENDABLE = new Set(['fireflies', 'youtrack', 'gamma', 'signrequest', 'linkedin', 'github']);
const PROVIDER_NAME: Record<string, string> = {
    fireflies: 'Fireflies.ai', youtrack: 'YouTrack', gamma: 'Gamma',
    signrequest: 'SignRequest', linkedin: 'LinkedIn', github: 'GitHub',
};

const selStyle = {
    background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)',
};

interface ConnectionPolicyPickerProps {
    resourceType: string;
    resourceId?: string | null;
    providers?: string[] | null;
}

const ConnectionPolicyPicker = ({ resourceType, resourceId, providers }: ConnectionPolicyPickerProps) => {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);

    const lendable = (providers || []).filter((p) => LENDABLE.has(p));
    const lendingQuery = useConnectionLendingQuery(resourceType, resourceId, lendable.length > 0);
    const connsByProvider = lendingQuery.data?.connsByProvider ?? {};
    const grantByProvider = lendingQuery.data?.grantByProvider ?? {};
    const loading = !!resourceId && lendable.length > 0 && lendingQuery.isPending;

    const onChange = async (provider: string, value: string) => {
        setBusy(provider);
        // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed request; nothing reaches another user or a response
        try {
            const existing = grantByProvider[provider];
            // Revoke any current grant for this provider+resource first.
            if (existing?.grantId) await mutate(`${BASE}/grants/${existing.grantId}`, { method: 'DELETE' });
            // value === '' means bring-your-own (no grant).
            if (value) {
                await mutate(`${BASE}/${value}/grants`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ granteeType: 'org', resourceType, resourceId }),
                });
            }
            await queryClient.refetchQueries({ queryKey: integrationsAdminKeys.connectionLending(resourceType, resourceId) });
        } catch (e) { console.error(e); }
        setBusy(null);
    };

    // Nothing to lend → render nothing (no clutter).
    const rows = lendable.filter((p) => (connsByProvider[p] || []).length > 0);
    if (loading || !resourceId || rows.length === 0) {
        if (!resourceId && lendable.length > 0) {
            return <p className="text-[11px] text-muted mt-2">{t('connections.lending_save_first', 'Save the agent to configure connection lending.')}</p>;
        }
        return null;
    }

    return (
        <div className="mt-4 rounded-xl p-3 [border:1px_solid_var(--border-subtle)] [background:rgba(16,185,129,0.04)]">
            <p className="text-xs font-medium text-primary">{t('connections.lending_title', 'Connection lending')}</p>
            <p className="text-[11px] text-muted mt-0.5 mb-2">
                {t('connections.lending_hint', 'Recipients use their own credentials by default. Lend one of your connections to let them run as you (full delegation).')}
            </p>
            <div className="space-y-2">
                {rows.map((provider) => {
                    const conns = connsByProvider[provider] || [];
                    const current = grantByProvider[provider]?.connectionId || '';
                    return (
                        <div key={provider} className="flex items-center gap-2">
                            <span className="text-[12px] text-primary flex-1">{PROVIDER_NAME[provider] || provider}</span>
                            <select
                                value={current}
                                disabled={busy === provider}
                                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(provider, e.target.value)}
                                className="px-2.5 py-1.5 rounded-lg border outline-none text-[12px]"
                                style={selStyle}
                            >
                                <option value="">{t('connections.lending_byo', 'Bring-your-own (default)')}</option>
                                {conns.map((c) => (
                                    <option key={c.id} value={c.id}>Lend: {c.label}</option>
                                ))}
                            </select>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default ConnectionPolicyPicker;

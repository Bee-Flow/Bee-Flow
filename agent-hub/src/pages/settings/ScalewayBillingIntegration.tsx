// ── Scaleway Billing ─────────────────────────────────────────────────────────
// Read-only invoice access for automations. A Scaleway IAM secret key whose
// principal holds BillingReadOnly is required; the Organization ID is optional
// (without it the key's own organization is used). Both are UUIDs that travel
// in a header or query string, so the server shape-checks them before storing.
// This is deliberately a per-user key, never the instance's Generative APIs key.

import React, { useState } from 'react';
import { IntegrationRow, ApiKeyField, DisconnectButton } from './IntegrationsSection';
import { getIntegrationIcon } from '../../config/integrationIcons';
import { useTranslation } from '../../hooks/useTranslation';
import useUserSettingSave from '../../hooks/useUserSettingSave';

const HELP_URL = 'https://www.scaleway.com/en/docs/iam/how-to/create-api-keys/';

interface ScalewayBillingIntegrationProps {
    hasScalewayBillingConfig: boolean;
    onSaved: () => void;
    last?: boolean;
}

export default function ScalewayBillingIntegration({ hasScalewayBillingConfig, onSaved, last }: ScalewayBillingIntegrationProps) {
    const { t } = useTranslation();
    const [secretKey, setSecretKey] = useState('');
    const [orgId, setOrgId] = useState('');
    const { saving, disconnecting, error, save, disconnect } = useUserSettingSave(onSaved);
    const clearFields = () => { setSecretKey(''); setOrgId(''); };
    // First connect needs the secret key; once connected, the organization id
    // can be changed on its own.
    const canSave = !!(secretKey.trim() || (hasScalewayBillingConfig && orgId.trim()));
    const handleSave = () => {
        if (!canSave) return;
        const body: Record<string, string> = {};
        if (secretKey.trim()) body.scalewayBillingSecretKey = secretKey.trim();
        if (orgId.trim()) body.scalewayBillingOrgId = orgId.trim();
        save(body, { onSuccess: clearFields });
    };
    const handleDisconnect = () => disconnect({ scalewayBillingSecretKey: '', scalewayBillingOrgId: '' }, { onSuccess: clearFields });
    return (
        <IntegrationRow
            last={last}
            connected={hasScalewayBillingConfig}
            name="Scaleway Billing"
            description={hasScalewayBillingConfig ? t('integ.scaleway_billing_connected') : t('integ.scaleway_billing_desc')}
            icon={getIntegrationIcon('scaleway-billing')}
            badge={null}
        >
            <div className="space-y-2">
                <ol className="list-decimal pl-4 space-y-1 text-[11px] text-[var(--text-muted)]">
                    <li>{t('integ.scaleway_billing_step1')}</li>
                    <li>{t('integ.scaleway_billing_step2')}</li>
                    <li>{t('integ.scaleway_billing_step3')}</li>
                    <li>{t('integ.scaleway_billing_step4')}</li>
                </ol>
                <input type="text" value={orgId} onChange={e => setOrgId(e.target.value)}
                    placeholder={t('integ.scaleway_billing_org_placeholder')}
                    aria-label={t('integ.scaleway_billing_org_label')}
                    autoComplete="off"
                    className="w-full px-3 py-2 rounded-lg border outline-none text-[13px] transition-colors bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)] focus:border-[var(--accent-primary)]" />
                <ApiKeyField
                    placeholder={hasScalewayBillingConfig ? '••••••••••••••••' : t('integ.scaleway_billing_key_placeholder')}
                    value={secretKey} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSecretKey(e.target.value)}
                    onSave={handleSave} saving={saving} canSave={canSave} t={t}
                    hint={<>Scaleway Help: <a href={HELP_URL} target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">create an API key</a></>}
                />
                {error && <p className="text-[11px] text-[#dc2626]">{error}</p>}
                {hasScalewayBillingConfig && <DisconnectButton onDisconnect={handleDisconnect} disconnecting={disconnecting} t={t} />}
            </div>
        </IntegrationRow>
    );
}

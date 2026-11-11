import { useState } from 'react';
import { settled } from '@/api/settled';
import { API_BASE } from '@/utils/helpers';
import AutoApproveCard from '../orgUsers/AutoApproveCard';
import OrgHealthBanner from '../OrgHealthBanner';
import type { AdminOrganization } from './types';
import type { OrgTabMode } from './useOrgTabTarget';

interface UsersOrgControlsProps {
    /** The organisation the people list shows; null while "All organisations" is chosen. */
    org: AdminOrganization | undefined;
    mode: OrgTabMode;
    onChanged: () => Promise<void>;
}

/** Switch an organisation's auto-approve for external sign-in, then re-read the lists. */
function useAutoApprove(org: AdminOrganization | undefined, onChanged: () => Promise<void>) {
    const [override, setOverride] = useState<boolean | null>(null);
    const [saving, setSaving] = useState(false);
    const current = override ?? !!org?.autoApproveSSO;
    const toggle = async () => {
        if (!org) return;
        const next = !current;
        setOverride(next);
        setSaving(true);
        try {
            const res = await settled(`${API_BASE}/auth/organizations/${org.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ autoApproveSSO: next }),
            }, 'empty');
            if (!res.ok) setOverride(!next);
            else await onChanged();
        } catch {
            setOverride(!next);
        } finally {
            setSaving(false);
        }
    };
    return { current, saving, toggle };
}

/**
 * Above the people: the connector-health blockers of the viewer's own organisation and the
 * auto-approve switch of an organisation that signs in through an external provider.
 */
export default function UsersOrgControls({ org, mode, onChanged }: UsersOrgControlsProps) {
    const auto = useAutoApprove(org, onChanged);
    const authMethod = typeof org?.authMethod === 'string' ? org.authMethod : null;
    return (
        <>
            {mode === 'ok' && <OrgHealthBanner />}
            {mode !== 'choose' && authMethod && authMethod !== 'password' && (
                <AutoApproveCard autoApprove={auto.current} saving={auto.saving} onToggle={auto.toggle} />
            )}
        </>
    );
}

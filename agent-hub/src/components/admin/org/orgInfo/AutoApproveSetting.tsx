import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { apiRequest } from '@/api/typedRequest';
import { ALERT_ERROR } from '@/components/shared/adminUi';
import SaveStatus from '@/components/shared/SaveStatus';
import Toggle from '@/components/shared/Toggle';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { OrgFormData } from './orgInfoFormRows';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface AutoApproveSettingProps {
    t: TranslateFn;
    orgData: OrgFormData;
    setOrgData: Dispatch<SetStateAction<OrgFormData | null>>;
}

/**
 * Whether someone who signs in through single sign-on with an address on the
 * organisation's domain joins at once (with the default groups) or waits as
 * pending (server/auth/ssoUserResolver planNewSSOUserPlacement). Its one home
 * is the Preferred sign-in method row, next to the allowed domains.
 *
 * A switch, so it stores itself the moment it moves and says so (SaveStatus):
 * it sends `autoApproveSSO` alone, and the row's save bar never sends it, so a
 * save of another field cannot put an old value back. A refused save puts the
 * switch back and offers a retry.
 */
export default function AutoApproveSetting({ t, orgData, setOrgData }: AutoApproveSettingProps) {
    const [state, setState] = useState<SaveState>('idle');
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const [lastTry, setLastTry] = useState<boolean | null>(null);
    const orgId = orgData.id;

    const save = async (next: boolean) => {
        const previous = orgData.autoApproveSSO;
        setLastTry(next);
        setOrgData(p => (p ? { ...p, autoApproveSSO: next } : p));
        setState('saving');
        try {
            await apiRequest('PUT /auth/organizations/{id}', { params: { id: orgId }, body: { autoApproveSSO: next } });
            setState('saved');
            setSavedAt(new Date());
        } catch {
            setOrgData(p => (p ? { ...p, autoApproveSSO: previous } : p));
            setState('error');
        }
    };

    return (
        <div className="space-y-2">
            <Toggle
                checked={orgData.autoApproveSSO}
                onChange={(next) => { void save(next); }}
                disabled={state === 'saving'}
                label={t('org_signin.auto_approve')}
                description={t('org_signin.auto_approve_desc')}
            />
            <div className="flex justify-end">
                <SaveStatus
                    saveState={state}
                    lastSavedAt={savedAt}
                    onRetry={lastTry === null ? null : () => { void save(lastTry); }}
                    showWhenIdle
                />
            </div>
            {state === 'error' && (
                <p role="alert" className={ALERT_ERROR}>{t('org_signin.auto_approve_failed')}</p>
            )}
        </div>
    );
}

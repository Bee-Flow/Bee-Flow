import type { Dispatch, SetStateAction } from 'react';
import type { OrgFormData } from './orgInfoFormRows';
import { AUTH_METHODS, AllowedDomainsEditor } from './orgInfoShared';
import { useUnavailableSignInMethods, type AuthMethodId, type SignInUnavailable } from './signInAvailability';
import AutoApproveSetting from './AutoApproveSetting';
import ChoiceCards, { type ChoiceCardOption } from '@/components/shared/ChoiceCards';
import type { TranslateFn } from '@/hooks/useTranslation';

interface OrgAuthSectionProps {
    t: TranslateFn;
    orgData: OrgFormData;
    setOrgData: Dispatch<SetStateAction<OrgFormData | null>>;
    isSelfHosted: boolean;
}

const UNAVAILABLE_KEY: Record<SignInUnavailable, string> = {
    password_off: 'org_signin.unavailable_password',
    not_set_up: 'org_signin.unavailable_not_set_up',
    unlicensed: 'org_signin.unavailable_unlicensed',
};

/**
 * The organisation's preferred sign-in method. Nothing reads it when someone
 * signs in: it is a preference the admin may change at any time, saved on
 * the shared save bar. Only the methods this server offers can be picked; the
 * others say why not. Below it, who may join through single sign-on: the
 * allowed domains (self-hosted) and auto-approve, whose one home this row is
 * (it stores itself). The page title and its description are the dashboard
 * frame's (AdminPage), so the row draws none of its own.
 */
const OrgAuthSection = ({ t, orgData, setOrgData, isSelfHosted }: OrgAuthSectionProps) => {
    const unavailable = useUnavailableSignInMethods(isSelfHosted);
    const options: ChoiceCardOption<AuthMethodId>[] = AUTH_METHODS.map(method => {
        const reason = unavailable[method.id];
        return {
            value: method.id,
            label: t(method.nameKey),
            description: t(method.descKey),
            Icon: method.Icon,
            disabled: !!reason,
            lockedNotice: reason ? t(UNAVAILABLE_KEY[reason]) : undefined,
        };
    });
    const value = AUTH_METHODS.some(m => m.id === orgData.authMethod) ? orgData.authMethod as AuthMethodId : null;
    return (
        <div className="space-y-5 animate-fadeIn">
            <ChoiceCards
                appearance="radio"
                columns={1}
                ariaLabel={t('org_signin.title')}
                value={value}
                options={options}
                onChange={(id) => setOrgData(p => (p ? { ...p, authMethod: id } : p))}
            />
            {/* Allowed Domains (self-hosted org-management feature) */}
            {isSelfHosted && (
                <AllowedDomainsEditor
                    domains={orgData.allowedDomains || []}
                    onChange={(domains) => setOrgData(p => (p ? { ...p, allowedDomains: domains } : p))}
                    t={t}
                />
            )}
            <AutoApproveSetting t={t} orgData={orgData} setOrgData={setOrgData} />
        </div>
    );
};

export default OrgAuthSection;

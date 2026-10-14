import { AlertTriangle, Building2, Clock, Info, MailCheck, Network, ShieldCheck, Users } from 'lucide-react';
import type { SignupEnvironment, SignupSettings, UpdateSetting } from './useSignupSettings';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Banner, Card, Checkbox, Toggle } from '../ui/typedUi';

interface SignupTogglesProps {
    settings: SignupSettings;
    update: UpdateSetting;
    env: SignupEnvironment;
}

function ConsumerLoginMethods({ settings, update }: Omit<SignupTogglesProps, 'env'>) {
    const { t } = useTranslation();
    const LOGIN_METHODS = [
        { id: 'password',  label: t('admin_subscriptions.access_login_password', 'Username & Password') },
        { id: 'google',    label: t('admin_subscriptions.access_login_google', 'Google SSO') },
        { id: 'microsoft', label: t('admin_subscriptions.access_login_microsoft', 'Microsoft SSO') },
    ];
    const methods = settings.consumerLoginMethods;
    return (
        <div className="-mt-1 pt-1">
            <div className="px-3 py-3 border border-t-0 border-[var(--border-default)] rounded-b-lg bg-[var(--bg-tertiary)]/70">
                <p className="text-[12px] font-semibold text-[var(--text-secondary)] mb-2">{t('admin_subscriptions.access_login_methods', 'Allowed login methods')}</p>
                <div className="flex flex-col gap-2 pl-1">
                    {LOGIN_METHODS.map(m => (
                        <Checkbox
                            key={m.id}
                            checked={methods.includes(m.id)}
                            onChange={on => update('consumerLoginMethods', prev => on ? [...prev, m.id] : prev.filter(x => x !== m.id))}
                            label={m.label}
                        />
                    ))}
                </div>
                {methods.length === 0 && (
                    <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-rose-400">
                        <AlertTriangle className="w-3 h-3" /> {t('admin_subscriptions.access_login_methods_min', 'At least one login method must be enabled.')}
                    </p>
                )}
            </div>
        </div>
    );
}

/** Who may sign up at all, and how: the switches card. */
export default function SignupToggles({ settings, update, env }: SignupTogglesProps) {
    const { t } = useTranslation();
    return (
        <Card className="space-y-3 !p-5 mb-4">
            <Toggle
                checked={settings.allowOrgSignups}
                onChange={v => update('allowOrgSignups', v)}
                icon={Building2}
                iconClass="text-sky-400"
                label={t('admin_subscriptions.access_org_signups', 'Organization signups')}
                description={t('admin_subscriptions.access_org_signups_desc', 'Allow users to register and create new organizations.')}
            />

            <div className="rounded-lg overflow-hidden">
                <Toggle
                    checked={settings.allowConsumerSignups}
                    onChange={v => update('allowConsumerSignups', v)}
                    icon={Users}
                    iconClass="text-emerald-400"
                    label={t('admin_subscriptions.access_consumer_signups', 'Consumer signups')}
                    description={t('admin_subscriptions.access_consumer_signups_desc', 'Allow users to register personal (non-organization) accounts.')}
                />
                {settings.allowConsumerSignups && <ConsumerLoginMethods settings={settings} update={update} />}
            </div>

            <Toggle
                checked={settings.waitlistEnabled}
                onChange={v => update('waitlistEnabled', v)}
                icon={Clock}
                iconClass="text-amber-400"
                label={t('admin_subscriptions.access_waitlist_mode', 'Waitlist mode')}
                description={t('admin_subscriptions.access_waitlist_mode_desc', 'Require admin approval for new account registrations. Invited users bypass the waitlist.')}
            />

            <div className="rounded-lg overflow-hidden">
                <Toggle
                    checked={settings.emailVerificationEnabled}
                    onChange={v => update('emailVerificationEnabled', v)}
                    icon={MailCheck}
                    iconClass="text-blue-400"
                    label={t('admin_subscriptions.access_email_verify', 'Require email verification')}
                    description={t('admin_subscriptions.access_email_verify_desc', 'New password signups must confirm their email address via a link before they can log in. Invited and SSO users (already trusted) are exempt. The verification & welcome email text is configured under Languages → Email Templates.')}
                />
                {settings.emailVerificationEnabled && !env.serviceEmailConfigured && (
                    <div className="-mt-1 pt-1">
                        <Banner tone="warning" icon={AlertTriangle}>
                            {t('admin_subscriptions.access_email_unconfigured', 'Service Email is not configured, so verification can\'t be enforced: new accounts are created active until you set up a sender under Integrations → Email.')}
                        </Banner>
                    </div>
                )}
            </div>

            <Toggle
                checked={settings.requireMfaForPasswordAccounts}
                onChange={v => update('requireMfaForPasswordAccounts', v)}
                icon={ShieldCheck}
                iconClass="text-teal-400"
                label={t('admin_subscriptions.access_mfa', 'Require MFA for password accounts')}
                description={t('admin_subscriptions.access_mfa_desc', 'Force username/password accounts to set up two-factor authentication before they can use the platform. Google/Microsoft SSO accounts are exempt (their provider handles MFA).')}
            />

            <Toggle
                checked={settings.connectorOnly}
                onChange={v => update('connectorOnly', v)}
                icon={Network}
                iconClass="text-sky-400"
                label={t('admin_subscriptions.access_connector_only', 'Only allow signups via the Nextcloud connector')}
                description={t('admin_subscriptions.access_connector_only_desc', 'Block all public web signups (organization, consumer & SSO). New accounts can only be created through the Nextcloud app. Email invitations still work.')}
            />

            {settings.connectorOnly && (
                <Banner tone="info" icon={Info}>
                    {t('admin_subscriptions.access_connector_only_on', 'Connector-only mode is on: the toggles above are overridden for web signups. The “Create Account” button is hidden on the login page; users get accounts by opening Bee Flow inside Nextcloud, or via an invitation.')}
                </Banner>
            )}
        </Card>
    );
}

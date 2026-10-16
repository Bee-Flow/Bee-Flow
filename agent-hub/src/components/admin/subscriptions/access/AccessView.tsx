import { AlertTriangle, Info, Save } from 'lucide-react';
import GeoRestrictions from './GeoRestrictions';
import SignupToggles from './SignupToggles';
import useSignupSettings from './useSignupSettings';
import type { SignupEnvironment, SignupSettings } from './useSignupSettings';
import WaitlistQueue from './WaitlistQueue';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Button } from '../../../shared/Button';
import { Banner } from '../ui/Banner';
import { SectionHeader } from '../ui/SectionHeader';
import { Spinner } from '../ui/Spinner';

/** Why the switches are overridden, or that they take effect at once. */
function OverrideBanners({ settings, env }: { settings: SignupSettings; env: SignupEnvironment }) {
    const { t } = useTranslation();
    return (
        <>
            {!env.allowSignupsEnv && (
                <Banner tone="danger" icon={AlertTriangle} title={t('admin_subscriptions.access_env_off_title', 'Signups are forced off by the environment')} className="mb-4">
                    {t('admin_subscriptions.access_env_off_body', 'The ALLOW_SIGNUPS environment variable is set to false in this deployment, which overrides the toggles above. No “Create Account” button will appear on the login page regardless of these settings. Remove the variable (or set it to true) to enable web signups. Note that it defaults to false on self-hosted installs. Email invitations still work.')}
                </Banner>
            )}

            {env.allowSignupsEnv && !settings.allowOrgSignups && !settings.allowConsumerSignups && (
                <Banner tone="danger" icon={AlertTriangle} title={t('admin_subscriptions.access_all_off_title', 'All signups are disabled')} className="mb-4">
                    {t('admin_subscriptions.access_all_off_body', 'No new users will be able to create accounts. The “Create Account” button will be hidden from the login page. Invited users can still join existing organizations.')}
                </Banner>
            )}

            {env.allowSignupsEnv && (
                <Banner tone="info" icon={Info} className="mb-5">
                    {t('admin_subscriptions.access_immediate', 'These settings take effect immediately. The ALLOW_SIGNUPS environment variable acts as a global override: if set to false, both toggles above are ignored.')}
                </Banner>
            )}
        </>
    );
}

/**
 * Net result the login page will actually see, recomputed live from the
 * current toggles so the admin sees the effect of every override at a glance.
 */
function CreateAccountState({ settings, env }: { settings: SignupSettings; env: SignupEnvironment }) {
    const { t } = useTranslation();
    const anySignups = settings.allowOrgSignups || settings.allowConsumerSignups;
    const effectiveAllowSignups = anySignups && !settings.connectorOnly && env.allowSignupsEnv;
    return (
        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
            <span className={`w-2 h-2 rounded-full ${effectiveAllowSignups ? 'bg-emerald-400' : 'bg-rose-400'}`} />
            <span className="text-[var(--text-muted)]">{t('admin_subscriptions.access_button_state', 'Create Account button:')}</span>
            <span className={effectiveAllowSignups ? 'text-emerald-400' : 'text-rose-400'}>
                {effectiveAllowSignups ? t('admin_subscriptions.access_button_visible', 'visible on the login page') : t('admin_subscriptions.access_button_hidden', 'hidden')}
            </span>
            {!effectiveAllowSignups && anySignups && (
                <span className="text-[var(--text-muted)]">
                    ({!env.allowSignupsEnv ? t('admin_subscriptions.access_reason_env', 'ALLOW_SIGNUPS=false') : settings.connectorOnly ? t('admin_subscriptions.access_reason_connector', 'connector-only mode') : t('admin_subscriptions.access_reason_overridden', 'overridden')})
                </span>
            )}
        </span>
    );
}

export function AccessView() {
    const { t } = useTranslation();
    const { loading, saving, settings, update, env, waitlistUsers, handleSave, approve, reject, confirmDialog } = useSignupSettings();

    if (loading) return <Spinner label={t('admin_subscriptions.access_loading', 'Loading settings…')} />;

    return (
        <div className="px-6 py-6 max-w-3xl mx-auto">
            <SectionHeader
                title={t('admin_subscriptions.access_title', 'Access Control')}
                description={t('admin_subscriptions.access_desc', 'Control which types of accounts can be created on this platform.')}
            />

            <SignupToggles settings={settings} update={update} env={env} />
            <OverrideBanners settings={settings} env={env} />
            <GeoRestrictions settings={settings} update={update} />

            <div className="flex items-center justify-between gap-4 mb-8">
                <CreateAccountState settings={settings} env={env} />
                <Button icon={Save} onClick={handleSave} busy={saving}>
                    {saving ? t('admin_subscriptions.access_saving', 'Saving…') : t('admin_subscriptions.access_save', 'Save changes')}
                </Button>
            </div>

            {(settings.waitlistEnabled || waitlistUsers.length > 0) && (
                <WaitlistQueue users={waitlistUsers} onApprove={approve} onReject={reject} />
            )}
            {confirmDialog}
        </div>
    );
}

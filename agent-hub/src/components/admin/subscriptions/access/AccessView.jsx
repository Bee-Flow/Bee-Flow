import { ShieldCheck, Building2, Users, Clock, Save, AlertTriangle, CheckCircle, Trash2, Info, Network, Globe, X, MailCheck } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { COUNTRIES, EU_EEA, countryName, countryFlag } from './countries';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Button } from '../../../shared/Button';
import EmptyState from '../../../shared/EmptyState';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';
import { apiJson } from '../hooks/useApi';
import { Badge } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Card } from '../ui/Card';
import { SectionHeader } from '../ui/SectionHeader';
import { Spinner } from '../ui/Spinner';
import { Toggle, Checkbox } from '../ui/Toggle';

export function AccessView() {
    const { t } = useTranslation();
    const LOGIN_METHODS = [
        { id: 'password',  label: t('admin_subscriptions.access_login_password', 'Username & Password') },
        { id: 'google',    label: t('admin_subscriptions.access_login_google', 'Google SSO') },
        { id: 'microsoft', label: t('admin_subscriptions.access_login_microsoft', 'Microsoft SSO') },
    ];
    const GEO_MODES = [
        { id: 'off',       label: t('admin_subscriptions.access_geo_off', 'Off') },
        { id: 'allowlist', label: t('admin_subscriptions.access_geo_allowlist', 'Allowlist') },
        { id: 'blocklist', label: t('admin_subscriptions.access_geo_blocklist', 'Blocklist') },
    ];
    const { confirm, confirmDialog } = useConfirm();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [allowOrgSignups,      setAllowOrgSignups]      = useState(true);
    const [allowConsumerSignups, setAllowConsumerSignups] = useState(true);
    const [consumerLoginMethods, setConsumerLoginMethods] = useState(['password', 'google', 'microsoft']);
    const [waitlistEnabled, setWaitlistEnabled] = useState(false);
    const [emailVerificationEnabled, setEmailVerificationEnabled] = useState(false);
    const [serviceEmailConfigured, setServiceEmailConfigured] = useState(true);
    const [requireMfaForPasswordAccounts, setRequireMfaForPasswordAccounts] = useState(true);
    const [waitlistUsers, setWaitlistUsers]     = useState([]);
    // Effective state after global overrides (ALLOW_SIGNUPS env + connector-only).
    const [allowSignupsEnv, setAllowSignupsEnv] = useState(true);
    // Connector-only + geo-blocking
    const [connectorOnly,    setConnectorOnly]    = useState(false);
    const [geoMode,          setGeoMode]          = useState('off');
    const [geoCountries,     setGeoCountries]     = useState([]);
    const [geoBlockUnknown,  setGeoBlockUnknown]  = useState(false);
    const [geoApplyConnector, setGeoApplyConnector] = useState(true);
    const [countrySearch,    setCountrySearch]    = useState('');

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const data = await apiJson('/auth/admin/signup-settings');
                if (!alive) return;
                setAllowOrgSignups(data.allowOrgSignups !== false);
                setAllowConsumerSignups(data.allowConsumerSignups !== false);
                setWaitlistEnabled(!!data.waitlistEnabled);
                setEmailVerificationEnabled(!!data.emailVerificationEnabled);
                setServiceEmailConfigured(data.serviceEmailConfigured !== false);
                setRequireMfaForPasswordAccounts(data.requireMfaForPasswordAccounts !== false);
                if (Array.isArray(data.consumerLoginMethods)) setConsumerLoginMethods(data.consumerLoginMethods);
                setConnectorOnly(!!data.connectorOnly);
                setAllowSignupsEnv(data.allowSignupsEnv !== false);
                if (['off', 'allowlist', 'blocklist'].includes(data.geoMode)) setGeoMode(data.geoMode);
                if (Array.isArray(data.geoCountries)) setGeoCountries(data.geoCountries);
                setGeoBlockUnknown(!!data.geoBlockUnknown);
                setGeoApplyConnector(data.geoApplyConnector !== false);
            } catch (e) {
                console.warn('Failed to fetch signup settings:', e);
            } finally {
                if (alive) setLoading(false);
            }
            try {
                const list = await apiJson('/auth/admin/waitlist');
                if (alive) setWaitlistUsers(list);
            } catch (e) { /* ignore */ }
        })();
        return () => { alive = false; };
    }, []);

    const handleSave = async () => {
        setSaving(true);
        try {
            await apiJson('/auth/admin/signup-settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    allowOrgSignups, allowConsumerSignups, waitlistEnabled, emailVerificationEnabled, requireMfaForPasswordAccounts, consumerLoginMethods,
                    connectorOnly, geoMode, geoCountries, geoBlockUnknown, geoApplyConnector,
                }),
            });
            toast.success(t('admin_subscriptions.access_saved', 'Signup settings saved.'));
        } catch (e) {
            toast.error(e.message || t('admin_subscriptions.access_save_failed', 'Save failed'));
        } finally {
            setSaving(false);
        }
    };

    const approve = async (u) => {
        try {
            await apiJson(`/auth/admin/waitlist/${u.id}/approve`, { method: 'POST' });
            setWaitlistUsers(prev => prev.filter(w => w.id !== u.id));
            toast.success(t('admin_subscriptions.access_approved', '{name} approved.', { name: u.displayName || u.username }));
        } catch (e) { toast.error(t('admin_subscriptions.access_approve_failed', 'Failed to approve.')); }
    };
    const reject = async (u) => {
        if (!(await confirm({ title: t('admin_subscriptions.access_reject_confirm', 'Reject and delete {name}?', { name: u.displayName || u.username }), confirmLabel: t('admin_subscriptions.access_reject', 'Reject'), destructive: true }))) return;
        try {
            await apiJson(`/auth/admin/waitlist/${u.id}/reject`, { method: 'POST' });
            setWaitlistUsers(prev => prev.filter(w => w.id !== u.id));
            toast.success(t('admin_subscriptions.access_rejected', '{name} rejected.', { name: u.displayName || u.username }));
        } catch (e) { toast.error(t('admin_subscriptions.access_reject_failed', 'Failed to reject.')); }
    };

    const addCountry    = (code) => setGeoCountries(prev => prev.includes(code) ? prev : [...prev, code]);
    const removeCountry = (code) => setGeoCountries(prev => prev.filter(c => c !== code));
    const addEuEea      = () => setGeoCountries(prev => [...new Set([...prev, ...EU_EEA])]);

    const availableCountries = useMemo(() => {
        const q = countrySearch.trim().toLowerCase();
        return COUNTRIES.filter(c =>
            !geoCountries.includes(c.code) &&
            (!q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q))
        );
    }, [countrySearch, geoCountries]);

    // Net result the login page will actually see, recomputed live from the
    // current toggles so the admin sees the effect of every override at a glance.
    const effectiveAllowSignups = (allowOrgSignups || allowConsumerSignups) && !connectorOnly && allowSignupsEnv;

    if (loading) return <Spinner label={t('admin_subscriptions.access_loading', 'Loading settings…')} />;

    return (
        <div className="px-6 py-6 max-w-3xl mx-auto">
            <SectionHeader
                title={t('admin_subscriptions.access_title', 'Access Control')}
                description={t('admin_subscriptions.access_desc', 'Control which types of accounts can be created on this platform.')}
            />

            <Card className="space-y-3 !p-5 mb-4">
                <Toggle
                    checked={allowOrgSignups}
                    onChange={setAllowOrgSignups}
                    icon={Building2}
                    iconClass="text-sky-400"
                    label={t('admin_subscriptions.access_org_signups', 'Organization signups')}
                    description={t('admin_subscriptions.access_org_signups_desc', 'Allow users to register and create new organizations.')}
                />

                <div className="rounded-lg overflow-hidden">
                    <Toggle
                        checked={allowConsumerSignups}
                        onChange={setAllowConsumerSignups}
                        icon={Users}
                        iconClass="text-emerald-400"
                        label={t('admin_subscriptions.access_consumer_signups', 'Consumer signups')}
                        description={t('admin_subscriptions.access_consumer_signups_desc', 'Allow users to register personal (non-organization) accounts.')}
                    />

                    {allowConsumerSignups && (
                        <div className="-mt-1 pt-1">
                            <div className="px-3 py-3 border border-t-0 border-[var(--border-default)] rounded-b-lg bg-[var(--bg-tertiary)]/70">
                                <p className="text-[12px] font-semibold text-[var(--text-secondary)] mb-2">{t('admin_subscriptions.access_login_methods', 'Allowed login methods')}</p>
                                <div className="flex flex-col gap-2 pl-1">
                                    {LOGIN_METHODS.map(m => (
                                        <Checkbox
                                            key={m.id}
                                            checked={consumerLoginMethods.includes(m.id)}
                                            onChange={on => setConsumerLoginMethods(prev => on ? [...prev, m.id] : prev.filter(x => x !== m.id))}
                                            label={m.label}
                                        />
                                    ))}
                                </div>
                                {consumerLoginMethods.length === 0 && (
                                    <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-rose-400">
                                        <AlertTriangle className="w-3 h-3" /> {t('admin_subscriptions.access_login_methods_min', 'At least one login method must be enabled.')}
                                    </p>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <Toggle
                    checked={waitlistEnabled}
                    onChange={setWaitlistEnabled}
                    icon={Clock}
                    iconClass="text-amber-400"
                    label={t('admin_subscriptions.access_waitlist_mode', 'Waitlist mode')}
                    description={t('admin_subscriptions.access_waitlist_mode_desc', 'Require admin approval for new account registrations. Invited users bypass the waitlist.')}
                />

                <div className="rounded-lg overflow-hidden">
                    <Toggle
                        checked={emailVerificationEnabled}
                        onChange={setEmailVerificationEnabled}
                        icon={MailCheck}
                        iconClass="text-blue-400"
                        label={t('admin_subscriptions.access_email_verify', 'Require email verification')}
                        description={t('admin_subscriptions.access_email_verify_desc', 'New password signups must confirm their email address via a link before they can log in. Invited and SSO users (already trusted) are exempt. The verification & welcome email text is configured under Languages → Email Templates.')}
                    />
                    {emailVerificationEnabled && !serviceEmailConfigured && (
                        <div className="-mt-1 pt-1">
                            <Banner tone="warning" icon={AlertTriangle}>
                                {t('admin_subscriptions.access_email_unconfigured', 'Service Email is not configured, so verification can\'t be enforced: new accounts are created active until you set up a sender under Integrations → Email.')}
                            </Banner>
                        </div>
                    )}
                </div>

                <Toggle
                    checked={requireMfaForPasswordAccounts}
                    onChange={setRequireMfaForPasswordAccounts}
                    icon={ShieldCheck}
                    iconClass="text-teal-400"
                    label={t('admin_subscriptions.access_mfa', 'Require MFA for password accounts')}
                    description={t('admin_subscriptions.access_mfa_desc', 'Force username/password accounts to set up two-factor authentication before they can use the platform. Google/Microsoft SSO accounts are exempt (their provider handles MFA).')}
                />

                <Toggle
                    checked={connectorOnly}
                    onChange={setConnectorOnly}
                    icon={Network}
                    iconClass="text-sky-400"
                    label={t('admin_subscriptions.access_connector_only', 'Only allow signups via the Nextcloud connector')}
                    description={t('admin_subscriptions.access_connector_only_desc', 'Block all public web signups (organization, consumer & SSO). New accounts can only be created through the Nextcloud app. Email invitations still work.')}
                />

                {connectorOnly && (
                    <Banner tone="info" icon={Info}>
                        {t('admin_subscriptions.access_connector_only_on', 'Connector-only mode is on: the toggles above are overridden for web signups. The “Create Account” button is hidden on the login page; users get accounts by opening Bee Flow inside Nextcloud, or via an invitation.')}
                    </Banner>
                )}
            </Card>

            {!allowSignupsEnv && (
                <Banner tone="danger" icon={AlertTriangle} title={t('admin_subscriptions.access_env_off_title', 'Signups are forced off by the environment')} className="mb-4">
                    {t('admin_subscriptions.access_env_off_body', 'The ALLOW_SIGNUPS environment variable is set to false in this deployment, which overrides the toggles above. No “Create Account” button will appear on the login page regardless of these settings. Remove the variable (or set it to true) to enable web signups. Note that it defaults to false on self-hosted installs. Email invitations still work.')}
                </Banner>
            )}

            {allowSignupsEnv && !allowOrgSignups && !allowConsumerSignups && (
                <Banner tone="danger" icon={AlertTriangle} title={t('admin_subscriptions.access_all_off_title', 'All signups are disabled')} className="mb-4">
                    {t('admin_subscriptions.access_all_off_body', 'No new users will be able to create accounts. The “Create Account” button will be hidden from the login page. Invited users can still join existing organizations.')}
                </Banner>
            )}

            {allowSignupsEnv && (
                <Banner tone="info" icon={Info} className="mb-5">
                    {t('admin_subscriptions.access_immediate', 'These settings take effect immediately. The ALLOW_SIGNUPS environment variable acts as a global override: if set to false, both toggles above are ignored.')}
                </Banner>
            )}

            <Card className="space-y-4 !p-5 mb-4">
                <div className="flex items-start gap-2">
                    <Globe className="w-4 h-4 mt-0.5 text-teal-400 shrink-0" />
                    <div>
                        <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{t('admin_subscriptions.access_geo_title', 'Geo restrictions')}</h3>
                        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                            {t('admin_subscriptions.access_geo_desc', 'Restrict which countries can create accounts, based on the signup request\'s IP location.')}
                        </p>
                    </div>
                </div>

                {/* Mode selector */}
                <div className="inline-flex rounded-lg border border-[var(--border-default)] overflow-hidden">
                    {GEO_MODES.map(m => (
                        <button
                            key={m.id}
                            type="button"
                            onClick={() => setGeoMode(m.id)}
                            className={`px-3.5 py-1.5 text-[12px] font-semibold transition-colors ${
                                geoMode === m.id
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                            }`}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>

                {geoMode !== 'off' && (
                    <>
                        <p className="text-[12px] text-[var(--text-secondary)]">
                            {geoMode === 'allowlist'
                                ? t('admin_subscriptions.access_geo_allow_hint', 'Only allow signups from these countries:')
                                : t('admin_subscriptions.access_geo_block_hint', 'Block signups from these countries:')}
                        </p>

                        {/* Selected countries */}
                        <div className="flex flex-wrap gap-1.5">
                            {geoCountries.length === 0 && (
                                <span className="text-[11.5px] text-[var(--text-muted)] italic">
                                    {geoMode === 'allowlist' ? t('admin_subscriptions.access_geo_none_allow', 'No countries selected: all signups will be blocked.') : t('admin_subscriptions.access_geo_none', 'No countries selected.')}
                                </span>
                            )}
                            {geoCountries.map(code => (
                                <button
                                    key={code}
                                    type="button"
                                    onClick={() => removeCountry(code)}
                                    title={t('admin_subscriptions.access_remove', 'Remove')}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-medium bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)] hover:border-rose-500/40 hover:text-rose-400"
                                >
                                    <span>{countryFlag(code)}</span>
                                    <span>{countryName(code)}</span>
                                    <X className="w-3 h-3" />
                                </button>
                            ))}
                        </div>

                        <div className="flex items-center gap-2">
                            <Button size="sm" variant="secondary" onClick={addEuEea}>{t('admin_subscriptions.access_eu_preset', '+ EU/EEA preset')}</Button>
                            {geoCountries.length > 0 && (
                                <Button size="sm" variant="ghost" onClick={() => setGeoCountries([])}>{t('admin_subscriptions.access_clear_all', 'Clear all')}</Button>
                            )}
                        </div>

                        {/* Country picker */}
                        <div>
                            <input
                                type="text"
                                value={countrySearch}
                                onChange={e => setCountrySearch(e.target.value)}
                                placeholder={t('admin_subscriptions.access_search_countries', 'Search countries to add…')}
                                className="w-full px-3 py-2 text-[13px] rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-blue-500/50"
                            />
                            <div className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-[var(--border-default)] divide-y divide-[var(--border-default)]">
                                {availableCountries.length === 0 ? (
                                    <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">{t('admin_subscriptions.access_no_matches', 'No matches.')}</div>
                                ) : availableCountries.map(c => (
                                    <button
                                        key={c.code}
                                        type="button"
                                        onClick={() => addCountry(c.code)}
                                        className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-left text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                                    >
                                        <span>{countryFlag(c.code)}</span>
                                        <span className="flex-1">{c.name}</span>
                                        <span className="text-[10.5px] text-[var(--text-muted)]">{c.code}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="pt-1 border-t border-[var(--border-default)]" />

                        <Checkbox
                            checked={geoBlockUnknown}
                            onChange={setGeoBlockUnknown}
                            accent="amber"
                            label={t('admin_subscriptions.access_geo_unknown', 'Block signups when the country can\'t be determined')}
                        />

                        <Toggle
                            checked={geoApplyConnector}
                            onChange={setGeoApplyConnector}
                            icon={Network}
                            iconClass="text-sky-400"
                            label={t('admin_subscriptions.access_geo_connector', 'Also apply to Nextcloud connector signups')}
                            description={t('admin_subscriptions.access_geo_connector_desc', 'When a new Nextcloud user is auto-provisioned, check the connecting Nextcloud server\'s location (not the individual user\'s).')}
                        />

                        <Banner tone="warning" icon={AlertTriangle}>
                            {t('admin_subscriptions.access_geo_warning', 'Geo-blocking is best-effort: it relies on IP geolocation, which is approximate and can be bypassed with a VPN. Use it as a guardrail, not a hard security boundary.')}
                        </Banner>
                    </>
                )}
            </Card>

            <div className="flex items-center justify-between gap-4 mb-8">
                <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
                    <span className={`w-2 h-2 rounded-full ${effectiveAllowSignups ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                    <span className="text-[var(--text-muted)]">{t('admin_subscriptions.access_button_state', 'Create Account button:')}</span>
                    <span className={effectiveAllowSignups ? 'text-emerald-400' : 'text-rose-400'}>
                        {effectiveAllowSignups ? t('admin_subscriptions.access_button_visible', 'visible on the login page') : t('admin_subscriptions.access_button_hidden', 'hidden')}
                    </span>
                    {!effectiveAllowSignups && (allowOrgSignups || allowConsumerSignups) && (
                        <span className="text-[var(--text-muted)]">
                            ({!allowSignupsEnv ? t('admin_subscriptions.access_reason_env', 'ALLOW_SIGNUPS=false') : connectorOnly ? t('admin_subscriptions.access_reason_connector', 'connector-only mode') : t('admin_subscriptions.access_reason_overridden', 'overridden')})
                        </span>
                    )}
                </span>
                <Button icon={Save} onClick={handleSave} busy={saving}>
                    {saving ? t('admin_subscriptions.access_saving', 'Saving…') : t('admin_subscriptions.access_save', 'Save changes')}
                </Button>
            </div>

            {(waitlistEnabled || waitlistUsers.length > 0) && (
                <div>
                    <div className="flex items-end justify-between gap-4 mb-3">
                        <div>
                            <h3 className="flex items-center gap-2 text-[16px] font-bold text-[var(--text-primary)]">
                                <Clock className="w-4 h-4 text-amber-400" />
                                {t('admin_subscriptions.access_waitlist_queue', 'Waitlist queue')}
                                {waitlistUsers.length > 0 && <Badge tone="warning" size="sm">{waitlistUsers.length}</Badge>}
                            </h3>
                            <p className="text-[12px] text-[var(--text-muted)]">{t('admin_subscriptions.access_waitlist_queue_desc', 'Users waiting for account approval.')}</p>
                        </div>
                    </div>

                    {waitlistUsers.length === 0 ? (
                        <EmptyState
                            icon={<CheckCircle className="w-6 h-6" />}
                            title={t('admin_subscriptions.access_waitlist_empty', 'No users in the waitlist')}
                            description={t('admin_subscriptions.access_waitlist_empty_desc', 'When waitlist mode is on, new signups appear here for approval.')}
                        />
                    ) : (
                        <Card padded={false}>
                            {waitlistUsers.map((u, idx) => (
                                <div
                                    key={u.id}
                                    className={`flex items-center justify-between gap-3 px-4 py-3 ${idx < waitlistUsers.length - 1 ? 'border-b border-[var(--border-default)]' : ''}`}
                                >
                                    <div className="min-w-0">
                                        <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{u.displayName || u.username}</div>
                                        <div className="flex flex-wrap gap-x-3 mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                                            {u.email && <span>{u.email}</span>}
                                            {u.createdAt && <span>{t('admin_subscriptions.access_signed_up', 'Signed up {date}', { date: new Date(u.createdAt).toLocaleDateString() })}</span>}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Button size="sm" variant="success" icon={CheckCircle} onClick={() => approve(u)}>{t('admin_subscriptions.access_approve', 'Approve')}</Button>
                                        <Button size="sm" variant="danger" icon={Trash2} onClick={() => reject(u)}>{t('admin_subscriptions.access_reject', 'Reject')}</Button>
                                    </div>
                                </div>
                            ))}
                        </Card>
                    )}
                </div>
            )}
            {confirmDialog}
        </div>
    );
}

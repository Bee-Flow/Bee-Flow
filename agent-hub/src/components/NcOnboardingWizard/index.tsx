import React, { useId, useState } from 'react';
import { CheckCircle2, ChevronRight, ChevronLeft, Loader2 } from 'lucide-react';
import { API_BASE } from '../../utils/helpers';
import { useOrgForm, useGroups } from './useOnboardingData';
import beeFlowLogo from '../../assets/bee-flow-logo.svg';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import { mutate, errorBody, RefusedError } from '../../api/mutate';
import ChoiceCards from '../shared/ChoiceCards';
import Toggle from '../shared/Toggle';
import { piiCategoriesLocalized } from '../../config/piiCategories';
import { EYEBROW, SECTION_TITLE, ALERT_ERROR } from '../mcpLibrary/ui';
/**
 * Bee Flow ↔ Nextcloud App Store onboarding wizard.
 *
 * Mounted by App.jsx when /auth/user reports `ncOnboardingNeeded: true`
 * (org has nc_instance_id but nc_onboarding_completed_at is NULL and the
 * caller is an org admin). Submitting writes every choice in one POST and
 * flips the onboarding flag — only after that does connectorJwt unblock
 * auto-provisioning for everyone else.
 *
 * Subscription / billing is intentionally NOT part of this wizard. Plans and
 * payment are managed by the organisation admin (Admin → Subscriptions and
 * Settings → Organisation → License & Usage) so the onboarding flow stays
 * about how Bee Flow runs and handles the team's data.
 *
 * Looks like the Studio surfaces (one bordered card, the recipes of
 * mcpLibrary/ui, ChoiceCards for every either/or), with more contrast than a
 * settings page needs: this is the first screen of the product. Fields are
 * white on a stronger border, and the brand's honey marks the three things
 * that move the person on: the progress, the focused field, the next button.
 */

// Same step list for Cloud and self-hosted — billing lives elsewhere.
const STEPS = ['welcome', 'org', 'sync', 'shield', 'done'];

// The categories the wizard offers, by their id in config/piiCategories.
const WIZARD_PII = ['Person', 'Email', 'PhoneNumber', 'Address', 'DateOfBirth', 'BankAccountNumber', 'URL', 'ApiKeyOrSecret'];
const DEFAULT_PII = ['Person', 'Email', 'PhoneNumber', 'Address', 'BankAccountNumber'];

const EDGE = 'border-[color-mix(in_srgb,var(--text-primary)_22%,transparent)]';
const BOX = `rounded-[10px] border ${EDGE} bg-[var(--bg-secondary)] p-3.5`;
const FIELD = `w-full px-3 py-2 text-[13px] rounded-lg border ${EDGE} bg-[var(--bg-card)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/25`;
const FIELD_LABEL = 'block mb-1 text-[12px] font-semibold text-[var(--text-primary)]';
const BTN = 'inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
const NEXT_BTN = `${BTN} bg-amber-500 text-[#111827] hover:bg-amber-400`;
const BACK_BTN = `${BTN} border ${EDGE} bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]`;
const CHECK_ROW = 'flex items-center gap-2 text-[12.5px] text-[var(--text-primary)] [&>input]:accent-amber-500';
const BODY_TEXT = 'm-0 text-[13.5px] leading-relaxed text-[var(--text-primary)]';
const FACT = 'm-0 text-[13px] text-[var(--text-primary)]';

function TextField({ label, value, onChange, type = 'text', placeholder }: { label: string; value: string; onChange: (next: string) => void; type?: string; placeholder?: string }) {
    const id = useId();
    return (
        <div>
            <label htmlFor={id} className={FIELD_LABEL}>{label}</label>
            <input id={id} type={type} value={value} placeholder={placeholder} className={FIELD}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)} />
        </div>
    );
}

/** A titled, scrollable grid of checkboxes: Nextcloud groups, PII categories. */
function CheckGroup({ title, loading = false, children }: { title: string; loading?: boolean; children: React.ReactNode }) {
    return (
        <fieldset className={`m-0 min-w-0 rounded-[10px] border ${EDGE} p-3.5`}>
            <legend className="px-1 text-[12px] font-semibold text-[var(--text-primary)]">{title}</legend>
            {loading
                ? <Loader2 className="w-4 h-4 animate-spin text-[var(--text-tertiary)]" />
                : <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 max-h-40 overflow-y-auto">{children}</div>}
        </fieldset>
    );
}

/** Add `val` to the list, or take it out when it is in. */
function toggle(list: string[], setter: (next: string[]) => void, val: string) {
    setter(list.includes(val) ? list.filter(x => x !== val) : [...list, val]);
}

function stepTitle(step: string, orgName?: string | null): string {
    if (step === 'welcome') return `Welcome to Bee Flow${orgName ? ` for ${orgName}` : ''}`;
    if (step === 'org') return 'Organisation details';
    if (step === 'sync') return 'Nextcloud user sync';
    if (step === 'shield') return 'Privacy Shield';
    return 'You\'re ready';
}

const NcOnboardingWizard = ({ user, orgName, onComplete, deploymentMode = 'cloud' }: { user: { organizationId?: string; email?: string } | null; orgName?: string | null; onComplete?: () => void; deploymentMode?: string }) => {
    const { t } = useTranslation();
    const orgId = user?.organizationId;
    const [stepIdx, setStepIdx] = useState(0);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null | undefined>(null);

    const [org, setOrg] = useOrgForm(orgId, orgName, user?.email);
    const [syncMode, setSyncMode] = useState('mirror_all');
    const [syncGroups, setSyncGroups] = useState<string[]>([]);
    const [excludedGroups, setExcludedGroups] = useState(['admin']);
    const [newUserDefaultStatus, setNewUserDefaultStatus] = useState('active');
    const [shieldEnabled, setShieldEnabled] = useState(true);
    const [shieldAction, setShieldAction] = useState('tokenize');
    const [shieldCategories, setShieldCategories] = useState(DEFAULT_PII);

    const { groups, groupsLoading } = useGroups(orgId);
    const piiCategories = piiCategoriesLocalized(t).filter(c => WIZARD_PII.includes(c.id));

    const step = STEPS[stepIdx];
    const next = () => setStepIdx(i => Math.min(i + 1, STEPS.length - 1));
    const prev = () => setStepIdx(i => Math.max(i - 1, 0));

    const canAdvance = () => {
        if (step === 'org' && !org.name.trim()) return false;
        if (step === 'sync' && syncMode === 'selective_groups' && syncGroups.length === 0) return false;
        if (step === 'shield' && shieldEnabled && shieldCategories.length === 0) return false;
        return true;
    };

    const handleFinish = async () => {
        if (!orgId) return;
        setSubmitting(true);
        setError(null);
        try {
            // 1. Persist org details (mirrors OrgInfoPanel's PUT).
            try {
                await mutate(`${API_BASE}/auth/organizations/${orgId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: org.name.trim(), email: org.email.trim(), tagline: org.tagline.trim(),
                        description: org.description.trim(), address: org.address.trim(), phone: org.phone.trim(),
                        website: org.website.trim(), kvk: org.kvk.trim(), vat: org.vat.trim(),
                    }),
                });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const j = errorBody(err) ?? {};
                throw new Error(`Could not save organisation: ${j.error || err.status}`);
            }

            // 2. Persist wizard outputs (deployment + sync + shield). Subscription
            //    is handled separately by the organisation admin, so it's not sent
            //    here — the org keeps whatever plan it already has.
            try {
                await mutate(`${API_BASE}/auth/admin/${orgId}/nc-onboarding/complete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        deploymentMode,
                        syncMode,
                        syncGroups: syncMode === 'selective_groups' ? syncGroups : [],
                        excludedGroups,
                        newUserDefaultStatus,
                        privacyShield: {
                            enabled: shieldEnabled,
                            piiDetectionAction: shieldAction,
                            piiDetectionCategories: shieldCategories,
                        },
                    }),
                });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const j = errorBody(err) ?? {};
                throw new Error(j.error || `HTTP ${err.status}`);
            }

            onComplete?.();
        } catch (e) {
            setError(errorMessage(e));
            setSubmitting(false);
        }
    };

    const groupChecks = (selected: string[], setter: (next: string[]) => void) => groups.map(g => (
        <label key={g} className={CHECK_ROW}>
            <input type="checkbox" checked={selected.includes(g)} onChange={() => toggle(selected, setter, g)} />{g}
        </label>
    ));

    // ── Step renderers ────────────────────────────────────────────────────
    const renderOrg = () => (
        <div className="flex flex-col gap-3.5">
            <p className={BODY_TEXT}>
                {t('nc_onboarding.nc_onboarding_wizard_tell_us_a_bit_about_your_organisation', 'Tell us a bit about your organisation. We pre-filled what Nextcloud already knows; the rest is optional and can be edited later.')}
            </p>
            <TextField label={t('nc_onboarding.nc_onboarding_wizard_organisation_name', 'Organisation name *')} value={org.name} onChange={v => setOrg({ ...org, name: v })} />
            <TextField label={t('nc_onboarding.nc_onboarding_wizard_billing_email', 'Billing email')} type="email" placeholder="finance@example.com" value={org.email} onChange={v => setOrg({ ...org, email: v })} />
            <TextField label={t('nc_onboarding.nc_onboarding_wizard_tagline', 'Tagline')} placeholder={t('nc_onboarding.nc_onboarding_wizard_one_line_that_describes_your_team', 'One line that describes your team')} value={org.tagline} onChange={v => setOrg({ ...org, tagline: v })} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <TextField label={t('nc_onboarding.nc_onboarding_wizard_phone', 'Phone')} value={org.phone} onChange={v => setOrg({ ...org, phone: v })} />
                <TextField label={t('nc_onboarding.nc_onboarding_wizard_website', 'Website')} placeholder="https://" value={org.website} onChange={v => setOrg({ ...org, website: v })} />
            </div>
            <TextField label={t('nc_onboarding.nc_onboarding_wizard_address', 'Address')} value={org.address} onChange={v => setOrg({ ...org, address: v })} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <TextField label={t('nc_onboarding.nc_onboarding_wizard_chamber_of_commerce_kvk', 'Chamber of Commerce (KVK)')} value={org.kvk} onChange={v => setOrg({ ...org, kvk: v })} />
                <TextField label={t('nc_onboarding.nc_onboarding_wizard_vat', 'VAT')} value={org.vat} onChange={v => setOrg({ ...org, vat: v })} />
            </div>
        </div>
    );

    const renderSync = () => (
        <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
                <h2 className={SECTION_TITLE}>{t('nc_onboarding.nc_onboarding_wizard_who_gets_a_bee_flow_account', 'Who gets a Bee Flow account?')}</h2>
                <ChoiceCards appearance="radio" columns={1} value={syncMode} onChange={setSyncMode}
                    ariaLabel={t('nc_onboarding.nc_onboarding_wizard_who_gets_a_bee_flow_account', 'Who gets a Bee Flow account?')}
                    options={[
                        { value: 'mirror_all', label: 'Everyone in Nextcloud', description: 'All NC users automatically get a Bee Flow account when they first click the icon.' },
                        { value: 'selective_groups', label: 'Only specific groups', description: 'Only members of the groups you pick are mirrored.' },
                        { value: 'manual', label: 'Manual only', description: 'You invite people one by one via the admin UI.' },
                    ]} />
            </div>
            {syncMode === 'selective_groups' && (
                <CheckGroup title={t('nc_onboarding.nc_onboarding_wizard_groups_to_sync_1_required', 'Groups to sync (≥1 required)')} loading={groupsLoading}>
                    {groupChecks(syncGroups, setSyncGroups)}
                </CheckGroup>
            )}
            <CheckGroup title={t('nc_onboarding.nc_onboarding_wizard_excluded_groups_members_never_mirrored', 'Excluded groups (members never mirrored)')} loading={groupsLoading}>
                {groupChecks(excludedGroups, setExcludedGroups)}
            </CheckGroup>
            <div className="flex flex-col gap-2">
                <h2 className={SECTION_TITLE}>{t('nc_onboarding.nc_onboarding_wizard_new_user_default_status', 'New user default status')}</h2>
                <ChoiceCards appearance="radio" value={newUserDefaultStatus} onChange={setNewUserDefaultStatus}
                    ariaLabel={t('nc_onboarding.nc_onboarding_wizard_new_user_default_status', 'New user default status')}
                    options={[
                        { value: 'active', label: 'Active immediately', description: 'Recommended for most teams' },
                        { value: 'pending', label: 'Pending approval', description: 'Admin reviews each new user' },
                    ]} />
            </div>
        </div>
    );

    const renderShield = () => (
        <div className="flex flex-col gap-5">
            <div className={`${BOX} flex items-start justify-between gap-4`}>
                <div className="min-w-0">
                    <p className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{t('nc_onboarding.nc_onboarding_wizard_enable_privacy_shield', 'Enable Privacy Shield')}</p>
                    <p className="m-0 mt-1 text-xs leading-[17px] text-[var(--text-secondary)]">{t('nc_onboarding.nc_onboarding_wizard_detects_pii_emails_phone_numbers_ibans', 'Detects PII (emails, phone numbers, IBANs, etc.) before messages reach the AI. Runs locally, in-process — no third-party services.')}</p>
                </div>
                <Toggle checked={shieldEnabled} onChange={setShieldEnabled} size="sm"
                    ariaLabel={t('nc_onboarding.nc_onboarding_wizard_enable_privacy_shield', 'Enable Privacy Shield')} />
            </div>
            {shieldEnabled && (
                <>
                    <div className="flex flex-col gap-2">
                        <h2 className={SECTION_TITLE}>{t('nc_onboarding.nc_onboarding_wizard_action_on_detection', 'Action on detection')}</h2>
                        <ChoiceCards appearance="radio" value={shieldAction} onChange={setShieldAction}
                            ariaLabel={t('nc_onboarding.nc_onboarding_wizard_action_on_detection', 'Action on detection')}
                            options={[
                                { value: 'tokenize', label: 'Tokenize & round-trip', description: 'Replace with [email_1] before sending; restore in response' },
                                { value: 'block', label: 'Block the message', description: 'Reject and ask user to rephrase' },
                            ]} />
                    </div>
                    <CheckGroup title={t('nc_onboarding.nc_onboarding_wizard_categories_to_detect_count_count_2', 'Categories to detect ({count}/{count_2})', { count: shieldCategories.length, count_2: piiCategories.length })}>
                        {piiCategories.map(c => (
                            <label key={c.id} className={CHECK_ROW}>
                                <input type="checkbox" checked={shieldCategories.includes(c.id)} onChange={() => toggle(shieldCategories, setShieldCategories, c.id)} />
                                <c.Icon className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                                <span>{c.label}</span>
                            </label>
                        ))}
                    </CheckGroup>
                </>
            )}
        </div>
    );

    return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--bg-secondary)]">
            <div className={`w-full max-w-2xl rounded-xl border ${EDGE} bg-[var(--bg-card)] shadow-[0_10px_30px_rgba(15,23,42,0.08)]`}>
                <header className="flex items-center gap-3 px-6 pt-6">
                    <img src={beeFlowLogo} alt={t('nc_onboarding.nc_onboarding_wizard_bee_flow', 'Bee Flow')} className={`w-10 h-10 rounded-lg border ${EDGE} object-cover`} />
                    <div className="min-w-0">
                        <p className={EYEBROW}>{t('nc_onboarding.nc_onboarding_wizard_step_of', 'Step {current} of {total}', { current: stepIdx + 1, total: STEPS.length })}</p>
                        <h1 className="m-0 mt-0.5 text-[17px] font-semibold leading-snug text-[var(--text-primary)]">{stepTitle(step, orgName)}</h1>
                    </div>
                </header>

                <div className="flex gap-1 px-6 mt-5" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={stepIdx + 1}>
                    {STEPS.map((s, i) => (
                        <span key={s} className={`flex-1 h-1.5 rounded-full ${i <= stepIdx ? 'bg-amber-500' : 'bg-[var(--bg-tertiary)]'}`} />
                    ))}
                </div>

                <div className="px-6 py-6">
                    {step === 'welcome' && (
                        <div className="flex flex-col gap-4">
                            <p className={BODY_TEXT}>
                                {t('nc_onboarding.nc_onboarding_wizard_bee_flow_is_now_connected_to_your', 'Bee Flow is now connected to your Nextcloud instance. We\'ll walk you through a few quick decisions about how Bee Flow runs and how it handles your team and their data.')}
                            </p>
                            <div className={`${BOX} flex flex-col gap-1.5`}>
                                <p className={FACT}><span className="font-semibold">Organisation:</span> {orgName || 'Nextcloud'}</p>
                                <p className={FACT}><span className="font-semibold">Administrator:</span> {user?.email}</p>
                                <p className="m-0 pt-1.5 text-xs leading-[17px] text-[var(--text-secondary)]">
                                    {t('nc_onboarding.nc_onboarding_wizard_no_credentials_app_passwords_or_oauth', 'No credentials, app passwords, or OAuth clients required — Nextcloud handles authentication, and Bee Flow uses the AppAPI shared secret to act on each user\'s behalf.')}
                                </p>
                            </div>
                        </div>
                    )}
                    {step === 'org' && renderOrg()}
                    {step === 'sync' && renderSync()}
                    {step === 'shield' && renderShield()}
                    {step === 'done' && (
                        <div className="flex flex-col gap-4">
                            <p className={BODY_TEXT}>{t('nc_onboarding.nc_onboarding_wizard_review_your_choices_and_finish_setup', 'Review your choices and finish setup. You can change any of this later under Settings → Organisation.')}</p>
                            <div className={`${BOX} flex flex-col gap-1.5`}>
                                <p className={FACT}><span className="font-semibold">Organisation:</span> {org.name || '—'}</p>
                                <p className={FACT}><span className="font-semibold">Deployment:</span> {deploymentMode === 'cloud' ? 'Bee Flow Cloud' : 'Self-hosted'}</p>
                                <p className={FACT}><span className="font-semibold">{t('nc_onboarding.nc_onboarding_wizard_sync_mode', 'Sync mode:')}</span> {syncMode}{syncMode === 'selective_groups' ? ` (${syncGroups.length} groups)` : ''}</p>
                                <p className={FACT}><span className="font-semibold">{t('nc_onboarding.nc_onboarding_wizard_privacy_shield', 'Privacy Shield:')}</span> {shieldEnabled ? `${shieldAction} • ${shieldCategories.length} categories` : 'disabled'}</p>
                            </div>
                            <p className="m-0 text-xs text-[var(--text-secondary)]">
                                {t('nc_onboarding.nc_onboarding_wizard_your_subscription_is_managed', 'Your subscription is managed separately under')} <span className="font-semibold">{t('nc_onboarding.nc_onboarding_wizard_settings_organisation_license_usage', 'Settings → Organisation → License & Usage')}</span>.
                            </p>
                            {error && <div role="alert" className={ALERT_ERROR}>{error}</div>}
                        </div>
                    )}
                </div>

                <footer className={`flex items-center justify-between gap-3 px-6 py-4 border-t ${EDGE} bg-[var(--bg-secondary)] rounded-b-xl`}>
                    <button type="button" onClick={prev} disabled={stepIdx === 0 || submitting} className={BACK_BTN}>
                        <ChevronLeft className="w-4 h-4" /> {t('nc_onboarding.nc_onboarding_wizard_back', 'Back')}
                    </button>
                    {step !== 'done' ? (
                        <button type="button" onClick={next} disabled={!canAdvance()} className={NEXT_BTN}>
                            {t('nc_onboarding.nc_onboarding_wizard_next', 'Next')} <ChevronRight className="w-4 h-4" />
                        </button>
                    ) : (
                        <button type="button" onClick={handleFinish} disabled={submitting} className={NEXT_BTN}>
                            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                            {submitting ? 'Finishing…' : 'Finish setup'}
                        </button>
                    )}
                </footer>
            </div>
        </div>
    );
};

export default NcOnboardingWizard;

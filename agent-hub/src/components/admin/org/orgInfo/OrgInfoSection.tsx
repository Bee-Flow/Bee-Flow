import { ArrowRight, Building2, Upload } from 'lucide-react';
import type { ChangeEvent, Dispatch, SetStateAction } from 'react';
import DefaultLanguageLine from './DefaultLanguageLine';
import { Field } from './orgInfoShared';
import type { OrgFormData, OrgNcBinding } from './orgInfoFormRows';
import { INPUT, QUIET_BTN } from '@/components/shared/adminUi';
import { buttonClass } from '@/components/shared/buttonClasses';
import type { TranslateFn } from '@/hooks/useTranslation';
import { navigate } from '@/router/history';
import { API_BASE } from '@/utils/helpers';
import { COUNTRIES } from '../../subscriptions/access/countries';

/** The Nextcloud row of the admin dashboard, where the sync is set up. */
const NEXTCLOUD_ROW_PATH = '/app/admin/organisation/nextcloud-sync';

const SYNC_MODE_KEYS: Readonly<Record<string, string>> = {
    mirror_all: 'admin_org_rows.nc_sync_mirror_all',
    selective_groups: 'admin_org_rows.nc_sync_selective_groups',
    manual: 'admin_org_rows.nc_sync_manual',
};

/** The sync mode in words; an id this page does not know is shown as stored. */
function syncModeLabel(t: TranslateFn, mode: string): string {
    return Object.hasOwn(SYNC_MODE_KEYS, mode) ? t(SYNC_MODE_KEYS[mode]) : mode;
}

type Setter = Dispatch<SetStateAction<OrgFormData | null>>;
type TextField = 'name' | 'tagline' | 'description' | 'email' | 'phone' | 'website' | 'address' | 'billingLine2'
    | 'billingPostalCode' | 'billingCity' | 'kvk' | 'vat';

/**
 * The props of a text input bound to one field of the form. Spread on a plain
 * `<input>`: Field ties its label to a host element only (orgInfoShared).
 */
function bound(field: TextField, orgData: OrgFormData, setOrgData: Setter) {
    return {
        value: orgData[field],
        onChange: (e: ChangeEvent<HTMLInputElement>) => setOrgData(p => p && ({ ...p, [field]: e.target.value })),
        className: INPUT,
    };
}

/** Which Nextcloud provisions the CHOSEN organisation's people (its stored binding), with a way to its settings. */
function NcBindingBanner({ t, nc }: { t: TranslateFn; nc: OrgNcBinding }) {
    return (
        <div className="rounded-xl p-4 flex items-start gap-3 bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-[var(--bg-tertiary)]">
                {/* The Nextcloud mark in its brand colour. */}
                <svg viewBox="0 0 24 24" width="18" height="18" fill="#0082C9" aria-hidden="true">
                    <path d="M12.018 6.537a5.5 5.5 0 00-5.142 3.547 3.62 3.62 0 100 3.832 5.498 5.498 0 0010.284 0 3.62 3.62 0 100-3.832 5.5 5.5 0 00-5.142-3.547zm0 1.987a3.518 3.518 0 11-.001 7.035 3.518 3.518 0 010-7.035z" />
                </svg>
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold mb-0.5 text-[var(--text-primary)]">
                    {t('admin_org.org_info_nc_title', 'Provisioned through Nextcloud')}
                </p>
                <p className="text-[12px] mb-2 text-[var(--text-muted)]">
                    {t('admin_org.org_info_nc_desc', 'User accounts and authentication are managed by your Nextcloud instance. Sign-in method and allowed-domain settings are not shown here.')}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]">
                    {nc.baseUrl && (
                        <span>{t('admin_org.org_info_nc_instance', 'Instance:')} <code className="px-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{nc.baseUrl}</code></span>
                    )}
                    {nc.adminUid && (
                        <span>{t('admin_org.org_info_nc_bootstrap', 'Bootstrap admin:')} <code className="px-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{nc.adminUid}</code></span>
                    )}
                    <span>{t('admin_org.org_info_nc_sync', 'Sync:')} <span className="text-[var(--text-secondary)]">{syncModeLabel(t, nc.syncMode)}</span></span>
                </div>
                <button type="button" className={`${QUIET_BTN} mt-2 -ml-2`} onClick={() => navigate(NEXTCLOUD_ROW_PATH)}>
                    {t('admin_org_rows.nc_sync_open')}
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            </div>
        </div>
    );
}

interface LogoFieldProps {
    t: TranslateFn;
    logo: string;
    handleLogoUpload: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
    handleLogoRemove: () => Promise<void>;
}

function LogoField({ t, logo, handleLogoUpload, handleLogoRemove }: LogoFieldProps) {
    return (
        <Field label={t('org.logo')} hint={t('org.logo_hint')}>
            <div className="flex items-center gap-4">
                {logo ? (
                    <img
                        src={logo.startsWith('/') ? `${API_BASE}${logo}` : logo}
                        alt={t('admin_org.org_info_logo_alt', 'Logo')}
                        className="w-20 h-20 object-contain rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-2"
                    />
                ) : (
                    <div className="w-20 h-20 rounded-xl border-2 border-dashed border-[var(--border-subtle)] flex items-center justify-center bg-[var(--bg-tertiary)]">
                        <Building2 className="w-8 h-8 text-[var(--text-muted)] opacity-40" aria-hidden="true" />
                    </div>
                )}
                <div className="flex flex-col gap-2">
                    <label className={`${buttonClass('primary', 'md')} cursor-pointer`}>
                        <Upload className="w-4 h-4" aria-hidden="true" />
                        {t('org.upload_logo')}
                        <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={handleLogoUpload} />
                    </label>
                    {logo && (
                        <button type="button" onClick={handleLogoRemove} className="text-xs text-[var(--text-muted)] hover:text-[var(--error-ink)] transition-colors text-left">
                            {t('org.remove_logo')}
                        </button>
                    )}
                </div>
            </div>
        </Field>
    );
}

type BlockProps = { t: TranslateFn; orgData: OrgFormData; setOrgData: Setter };

/** Invoicing: the billing address the Stripe customer is kept in step with, plus the registration numbers. Cloud only. */
function InvoicingBlock({ t, orgData, setOrgData }: BlockProps) {
    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('org.legal_invoicing')}</h3>
                <p className="text-sm text-[var(--text-muted)] mt-0.5">{t('org.legal_subtitle')}</p>
            </div>
            <Field label={t('org.street')} hint={t('org.billing_address_hint')}>
                <input type="text" {...bound('address', orgData, setOrgData)} placeholder={t('org.placeholder_street')} />
            </Field>
            <Field label={t('org.address_line2')}>
                <input type="text" {...bound('billingLine2', orgData, setOrgData)} placeholder={t('org.placeholder_line2')} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label={t('org.postal_code')}>
                    <input type="text" {...bound('billingPostalCode', orgData, setOrgData)} placeholder={t('org.placeholder_postal_code')} />
                </Field>
                <Field label={t('org.city')}>
                    <input type="text" {...bound('billingCity', orgData, setOrgData)} placeholder={t('org.placeholder_city')} />
                </Field>
            </div>
            <Field label={t('org.country')}>
                <select value={orgData.billingCountry} onChange={e => setOrgData(p => p && ({ ...p, billingCountry: e.target.value }))} className={INPUT}>
                    <option value="">{t('org.select_country')}</option>
                    {COUNTRIES.map(c => (
                        <option key={c.code} value={c.code}>{c.name}</option>
                    ))}
                </select>
            </Field>
            <RegistrationFields t={t} orgData={orgData} setOrgData={setOrgData} />
        </div>
    );
}

function RegistrationFields({ t, orgData, setOrgData }: BlockProps) {
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={t('org.kvk')}>
                <input type="text" {...bound('kvk', orgData, setOrgData)} placeholder={t('org.placeholder_kvk')} />
            </Field>
            <Field label={t('org.vat')}>
                <input type="text" {...bound('vat', orgData, setOrgData)} placeholder={t('org.placeholder_vat')} />
            </Field>
        </div>
    );
}

/** Self-hosted: no invoicing (the billing fields feed only the cloud's Stripe customer), the registration numbers alone. */
function LegalDetailsBlock({ t, orgData, setOrgData }: BlockProps) {
    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('admin_org_rows.legal_details')}</h3>
                <p className="text-sm text-[var(--text-muted)] mt-0.5">{t('admin_org_rows.legal_details_desc')}</p>
            </div>
            <RegistrationFields t={t} orgData={orgData} setOrgData={setOrgData} />
        </div>
    );
}

interface OrgInfoSectionProps {
    t: TranslateFn;
    /** The cloud edition: the invoicing block shows (its fields feed the Stripe customer). */
    isCloud: boolean;
    orgData: OrgFormData;
    setOrgData: Setter;
    handleLogoUpload: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
    handleLogoRemove: () => Promise<void>;
    /** A platform administrator: is pointed to Languages, where the server-wide default language changes. */
    isPlatformAdmin?: boolean;
}

/**
 * Organisation info: the CHOSEN organisation's Nextcloud binding (when it has
 * one), branding and contact, the legal details (with invoicing on cloud) and
 * the server's default language, read only. The page title is the dashboard
 * frame's (AdminPage); the blocks keep their own h3 headings.
 */
const OrgInfoSection = ({ t, isCloud, orgData, setOrgData, handleLogoUpload, handleLogoRemove, isPlatformAdmin = false }: OrgInfoSectionProps) => {
    const bind = { orgData, setOrgData };
    return (
        <div className="space-y-8 animate-fadeIn">
            {orgData.nc && <NcBindingBanner t={t} nc={orgData.nc} />}
            <div className="space-y-5">
                <div>
                    <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('org.branding')}</h3>
                    <p className="text-sm text-[var(--text-muted)] mt-0.5">{t('org.branding_subtitle')}</p>
                </div>
                <LogoField t={t} logo={orgData.logo} handleLogoUpload={handleLogoUpload} handleLogoRemove={handleLogoRemove} />
                <Field label={t('org.company_name')}>
                    <input type="text" {...bound('name', orgData, setOrgData)} placeholder={t('org.placeholder_company_name')} />
                </Field>
                <Field label={t('org.tagline')} hint={t('org.tagline_hint')}>
                    <input type="text" {...bound('tagline', orgData, setOrgData)} placeholder={t('org.placeholder_tagline')} />
                </Field>
                <Field label={t('org.description')}>
                    <input type="text" {...bound('description', orgData, setOrgData)} placeholder={t('org.placeholder_description')} />
                </Field>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label={t('org.email')}>
                        <input type="email" {...bound('email', orgData, setOrgData)} placeholder={t('org.placeholder_email')} />
                    </Field>
                    <Field label={t('org.phone')}>
                        <input type="tel" {...bound('phone', orgData, setOrgData)} placeholder={t('org.placeholder_phone')} />
                    </Field>
                </div>
                <Field label={t('org.website')}>
                    <input type="url" {...bound('website', orgData, setOrgData)} placeholder={t('org.placeholder_website')} />
                </Field>
            </div>

            <div className="border-t border-[var(--border-subtle)]" />
            {isCloud ? <InvoicingBlock t={t} {...bind} /> : <LegalDetailsBlock t={t} {...bind} />}

            {/* Draws its own divider: on a server with one language it draws nothing at all. */}
            <DefaultLanguageLine t={t} isPlatformAdmin={isPlatformAdmin} />
        </div>
    );
};

export default OrgInfoSection;

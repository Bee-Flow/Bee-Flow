import { Building2, Upload } from 'lucide-react';
import OrgDefaultLanguage from './OrgDefaultLanguage';
import { Field } from './orgInfoShared';
import { API_BASE } from '../../../../utils/helpers';
import { COUNTRIES } from '../../subscriptions/access/countries';

    const inputClass = "w-full px-3 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-sm outline-none focus:border-[var(--accent-primary)] transition-colors";

// ── Organisation Info section (Branding + Legal) — extracted verbatim from OrgInfoPanel. ──
const OrgInfoSection = ({ t, isNcOrg, ncOrg, orgData, setOrgData, handleLogoUpload, handleLogoRemove }) => (
                    <div className="max-w-xl mx-auto space-y-8 animate-fadeIn">
                        {/* NC binding banner — read-only summary of which Nextcloud
                            instance owns this org's identity. Reminds admins that
                            users come from NC and points them to the Sync panel. */}
                        {isNcOrg && (
                            <div
                                className="rounded-2xl p-4 flex items-start gap-3"
                                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
                            >
                                <div
                                    className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                                    style={{ background: 'rgba(0, 130, 201, 0.12)' }}
                                >
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="#0082C9">
                                        <path d="M12.018 6.537a5.5 5.5 0 00-5.142 3.547 3.62 3.62 0 100 3.832 5.498 5.498 0 0010.284 0 3.62 3.62 0 100-3.832 5.5 5.5 0 00-5.142-3.547zm0 1.987a3.518 3.518 0 11-.001 7.035 3.518 3.518 0 010-7.035z" />
                                    </svg>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[13px] font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>
                                        {t('admin_org.org_info_nc_title', 'Provisioned through Nextcloud')}
                                    </p>
                                    <p className="text-[12px] mb-2" style={{ color: 'var(--text-muted)' }}>
                                        {t('admin_org.org_info_nc_desc', 'User accounts and authentication are managed by your Nextcloud instance. Sign-in method and allowed-domain settings are not shown here.')}
                                    </p>
                                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                        {ncOrg.baseUrl && (
                                            <span><span className="opacity-70">{t('admin_org.org_info_nc_instance', 'Instance:')}</span> <code className="px-1 rounded" style={{ background: 'var(--bg-tertiary)' }}>{ncOrg.baseUrl}</code></span>
                                        )}
                                        {ncOrg.adminUid && (
                                            <span><span className="opacity-70">{t('admin_org.org_info_nc_bootstrap', 'Bootstrap admin:')}</span> <code className="px-1 rounded" style={{ background: 'var(--bg-tertiary)' }}>{ncOrg.adminUid}</code></span>
                                        )}
                                        <span><span className="opacity-70">{t('admin_org.org_info_nc_sync', 'Sync:')}</span> {(ncOrg.syncMode || 'mirror_all').replace('_', ' ')}</span>
                                    </div>
                                </div>
                            </div>
                        )}
                        {/* ── Branding section ── */}
                        <div className="space-y-5">
                            <div>
                                <h2 className="text-lg font-bold text-[var(--text-primary)]">{t('org.branding')}</h2>
                                <p className="text-sm text-[var(--text-muted)] mt-0.5">{t('org.branding_subtitle')}</p>
                            </div>
                            <Field label={t('org.logo')} hint={t('org.logo_hint')}>
                                <div className="flex items-center gap-4">
                                    {orgData.logo ? (
                                        <img
                                            src={orgData.logo.startsWith('/') ? `${API_BASE}${orgData.logo}` : orgData.logo}
                                            alt={t('admin_org.org_info_logo_alt', 'Logo')}
                                            className="w-20 h-20 object-contain rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-2"
                                        />
                                    ) : (
                                        <div className="w-20 h-20 rounded-xl border-2 border-dashed border-[var(--border-subtle)] flex items-center justify-center bg-[var(--bg-tertiary)]">
                                            <Building2 className="w-8 h-8 text-[var(--text-muted)] opacity-40" />
                                        </div>
                                    )}
                                    <div className="flex flex-col gap-2">
                                        <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity">
                                            <Upload className="w-4 h-4" />
                                            {t('org.upload_logo')}
                                            <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={handleLogoUpload} />
                                        </label>
                                        {orgData.logo && (
                                            <button onClick={handleLogoRemove} className="text-xs text-[var(--text-muted)] hover:text-red-500 transition-colors text-left">
                                                {t('org.remove_logo')}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </Field>
                            <Field label={t('org.company_name')}>
                                <input type="text" value={orgData.name} onChange={e => setOrgData(p => ({ ...p, name: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_company_name')} />
                            </Field>
                            <Field label={t('org.tagline')} hint={t('org.tagline_hint')}>
                                <input type="text" value={orgData.tagline} onChange={e => setOrgData(p => ({ ...p, tagline: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_tagline')} />
                            </Field>
                            <Field label={t('org.description')}>
                                <input type="text" value={orgData.description} onChange={e => setOrgData(p => ({ ...p, description: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_description')} />
                            </Field>
                            <div className="grid grid-cols-2 gap-4">
                                <Field label={t('org.email')}>
                                    <input type="email" value={orgData.email} onChange={e => setOrgData(p => ({ ...p, email: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_email')} />
                                </Field>
                                <Field label={t('org.phone')}>
                                    <input type="tel" value={orgData.phone} onChange={e => setOrgData(p => ({ ...p, phone: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_phone')} />
                                </Field>
                            </div>
                            <Field label={t('org.website')}>
                                <input type="url" value={orgData.website} onChange={e => setOrgData(p => ({ ...p, website: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_website')} />
                            </Field>
                        </div>

                        {(
                            <>
                                {/* ── Divider ── */}
                                <div className="border-t border-[var(--border-subtle)]" />

                                {/* ── Legal & Invoicing section ── */}
                                <div className="space-y-5">
                                    <div>
                                        <h2 className="text-lg font-bold text-[var(--text-primary)]">{t('org.legal_invoicing')}</h2>
                                        <p className="text-sm text-[var(--text-muted)] mt-0.5">{t('org.legal_subtitle')}</p>
                                    </div>
                                    <Field label={t('org.street')} hint={t('org.billing_address_hint')}>
                                        <input type="text" value={orgData.address} onChange={e => setOrgData(p => ({ ...p, address: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_street')} />
                                    </Field>
                                    <Field label={t('org.address_line2')}>
                                        <input type="text" value={orgData.billingLine2} onChange={e => setOrgData(p => ({ ...p, billingLine2: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_line2')} />
                                    </Field>
                                    <div className="grid grid-cols-2 gap-4">
                                        <Field label={t('org.postal_code')}>
                                            <input type="text" value={orgData.billingPostalCode} onChange={e => setOrgData(p => ({ ...p, billingPostalCode: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_postal_code')} />
                                        </Field>
                                        <Field label={t('org.city')}>
                                            <input type="text" value={orgData.billingCity} onChange={e => setOrgData(p => ({ ...p, billingCity: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_city')} />
                                        </Field>
                                    </div>
                                    <Field label={t('org.country')}>
                                        <select value={orgData.billingCountry} onChange={e => setOrgData(p => ({ ...p, billingCountry: e.target.value }))} className={inputClass}>
                                            <option value="">{t('org.select_country')}</option>
                                            {COUNTRIES.map(c => (
                                                <option key={c.code} value={c.code}>{c.name}</option>
                                            ))}
                                        </select>
                                    </Field>
                                    <div className="grid grid-cols-2 gap-4">
                                        <Field label={t('org.kvk')}>
                                            <input type="text" value={orgData.kvk} onChange={e => setOrgData(p => ({ ...p, kvk: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_kvk')} />
                                        </Field>
                                        <Field label={t('org.vat')}>
                                            <input type="text" value={orgData.vat} onChange={e => setOrgData(p => ({ ...p, vat: e.target.value }))} className={inputClass} placeholder={t('org.placeholder_vat')} />
                                        </Field>
                                    </div>
                                </div>
                            </>
                        )}

                        {/* ── Divider ── */}
                        <div className="border-t border-[var(--border-subtle)]" />

                        {/* ── Default Language for New Users ── */}
                        <OrgDefaultLanguage />
                        {/* AI usage sharing moved to the License & Usage section. */}
                    </div>
);

export default OrgInfoSection;

import type { Dispatch, SetStateAction } from 'react';
import { API_BASE } from '../../../../utils/helpers';
import type { AdminOrganization, OrgFormData } from './types';
import { useTranslation } from '../../../../hooks/useTranslation';

export interface MyOrganizationSectionProps {
    myOrg: AdminOrganization | undefined;
    orgData: OrgFormData;
    setOrgData: Dispatch<SetStateAction<OrgFormData>>;
    onSave: () => void;
    onUploadLogo: (file: File) => void;
    onRemoveLogo: () => void;
}

export default function MyOrganizationSection({ myOrg, orgData, setOrgData, onSave, onUploadLogo, onRemoveLogo }: MyOrganizationSectionProps) {
    const { t } = useTranslation();
    if (!myOrg) {
        return <div className="text-center py-12 text-[var(--text-muted)]">{t('admin_org.my_org_none', 'No organization found')}</div>;
    }
    return (
        <div className="max-w-2xl">
            <div className="mb-6">
                <h3 className="text-lg font-semibold text-[var(--text-primary)]">{t('admin_org.my_org_title', 'My Organization')}</h3>
                <p className="text-sm text-[var(--text-muted)]">{t('admin_org.my_org_subtitle', "Edit your organization's information")}</p>
            </div>
            <div className="space-y-4 p-6 rounded-2xl border bg-[var(--bg-secondary)] border-[var(--border-default)]">
                {/* Company Logo */}
                <div>
                    <label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">{t('admin_org.my_org_logo', 'Company Logo')}</label>
                    <div className="flex items-center gap-4">
                        {orgData.logo && (
                            <img src={orgData.logo.startsWith('/') ? `${API_BASE}${orgData.logo}` : orgData.logo} alt={t('admin_org.my_org_logo_alt', 'Logo')} className="w-16 h-16 object-contain rounded-lg border border-[var(--border-default)]" />
                        )}
                        <div className="flex items-center gap-2">
                            <label className="cursor-pointer px-4 py-2 rounded-lg font-medium text-sm bg-[var(--accent-primary)] text-white">
                                {t('admin_org.my_org_upload_logo', 'Upload Logo')}
                                <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) onUploadLogo(file);
                                }} />
                            </label>
                            {orgData.logo && (
                                <button onClick={onRemoveLogo} className="text-sm font-medium text-[var(--text-muted)]">{t('admin_org.my_org_remove', 'Remove')}</button>
                            )}
                        </div>
                    </div>
                </div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.my_org_company_name', 'Company Name')}</label><input type="text" value={orgData.name} onChange={e => setOrgData(p => ({ ...p, name: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder={t('admin_org.my_org_company_name', 'Company Name')} /></div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.my_org_tagline', 'Company Details / Tagline')}</label><input type="text" value={orgData.tagline} onChange={e => setOrgData(p => ({ ...p, tagline: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" /></div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.my_org_description', 'Description')}</label><input type="text" value={orgData.description} onChange={e => setOrgData(p => ({ ...p, description: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" /></div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.my_org_address', 'Address')}</label><input type="text" value={orgData.address} onChange={e => setOrgData(p => ({ ...p, address: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" /></div>
                <div className="grid grid-cols-2 gap-4">
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.my_org_email', 'Email')}</label><input type="email" value={orgData.email} onChange={e => setOrgData(p => ({ ...p, email: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" /></div>
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.my_org_phone', 'Phone')}</label><input type="tel" value={orgData.phone} onChange={e => setOrgData(p => ({ ...p, phone: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" /></div>
                </div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.my_org_website', 'Website')}</label><input type="url" value={orgData.website} onChange={e => setOrgData(p => ({ ...p, website: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" /></div>
                <div className="grid grid-cols-2 gap-4">
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.my_org_kvk', 'Chamber of Commerce')}</label><input type="text" value={orgData.kvk} onChange={e => setOrgData(p => ({ ...p, kvk: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" /></div>
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.my_org_vat', 'VAT Number')}</label><input type="text" value={orgData.vat} onChange={e => setOrgData(p => ({ ...p, vat: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" /></div>
                </div>
                <div className="flex justify-end pt-2">
                    <button onClick={onSave} className="px-6 py-2 rounded-lg font-medium bg-[var(--accent-primary)] text-white">{t('admin_org.my_org_save', 'Save Changes')}</button>
                </div>
            </div>
        </div>
    );
}

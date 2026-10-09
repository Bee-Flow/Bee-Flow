import { Edit2, Trash2, Unlink } from 'lucide-react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { API_BASE } from '../../../../utils/helpers';
import { ORG_SOURCE_KEY } from './constants';
import type { AdminOrganization } from './types';

export interface OrganizationsSectionProps {
    organizations: AdminOrganization[];
    isFullAdmin: boolean;
    onAddOrg: () => void;
    onEditOrg: (org: AdminOrganization) => void;
    onDeleteOrg: (orgId: string) => void;
    onRemoveNcBinding: (org: AdminOrganization) => void;
    t: TranslateFn;
}

export default function OrganizationsSection({ organizations, isFullAdmin, onAddOrg, onEditOrg, onDeleteOrg, onRemoveNcBinding, t }: OrganizationsSectionProps) {
    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between mb-6">
                <div><h3 className="text-lg font-semibold text-[var(--text-primary)]">{t('admin_org.orgs_section_title', 'Organizations')}</h3><p className="text-sm text-[var(--text-muted)]">{t('admin_org.orgs_section_subtitle', 'Manage organizations and their metadata')}</p></div>
                {isFullAdmin && <button onClick={onAddOrg} className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium bg-[var(--accent-primary)] text-white"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5v14" /></svg> {t('admin_org.orgs_section_add', 'Add Organization')}</button>}
            </div>
            <div className="grid gap-4">
                {organizations.map(org => (
                    <div key={org.id} className="p-4 rounded-xl border group hover:border-[var(--accent-primary)] bg-[var(--bg-secondary)] border-[var(--border-default)]">
                        <div className="flex items-start justify-between">
                            <div className="flex items-center gap-3">
                                {org.logo ? (
                                    <img src={org.logo.startsWith('/') ? `${API_BASE}${org.logo}` : org.logo} alt={org.name} className="w-10 h-10 object-contain rounded-lg" />
                                ) : (
                                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(59, 130, 246, 0.15)' }}><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" /><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" /><path d="M10 6h4" /><path d="M10 10h4" /><path d="M10 14h4" /><path d="M10 18h4" /></svg></div>
                                )}
                                <div>
                                    <h4 className="font-semibold text-[var(--text-primary)]">{org.name}</h4>
                                    <p className="text-sm text-[var(--text-muted)]">{org.description}</p>
                                    {org.nc_instance_id && <p className="text-xs mt-1 text-[var(--text-muted)]">{t('admin.org_nc_bound_label')}: {org.nc_base_url || org.nc_instance_id}</p>}
                                    <p className="text-xs mt-1 text-[var(--text-muted)]">{t('admin.org_source_label')}: {t(ORG_SOURCE_KEY[org.registrationSource || ''] || 'admin.org_source_unknown')}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 opacity-100 xl:opacity-0 xl:group-hover:opacity-100">
                                <button onClick={() => onEditOrg(org)} className="p-1.5 rounded hover:bg-blue-500/10 text-blue-500"><Edit2 className="w-4 h-4" /></button>
                                {isFullAdmin && org.nc_instance_id && <button onClick={() => onRemoveNcBinding(org)} title={t('admin.org_nc_remove_title')} className="p-1.5 rounded hover:bg-amber-500/10 text-amber-500"><Unlink className="w-4 h-4" /></button>}
                                {isFullAdmin && <button onClick={() => onDeleteOrg(org.id)} className="p-1.5 rounded hover:bg-red-500/10 text-red-500"><Trash2 className="w-4 h-4" /></button>}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

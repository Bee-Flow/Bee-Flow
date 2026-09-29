import { Activity, Unlink } from 'lucide-react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { AdminOrganization } from './types';

export interface NextcloudBindingsSectionProps {
    organizations: AdminOrganization[];
    onNavigate?: (path: string) => void;
    onRemoveNcBinding: (org: AdminOrganization) => void;
    t: TranslateFn;
}

export default function NextcloudBindingsSection({ organizations, onNavigate, onRemoveNcBinding, t }: NextcloudBindingsSectionProps) {
    const bound = organizations.filter(o => o.nc_instance_id);
    return (
        <div className="space-y-4">
            <div className="mb-6">
                <h3 className="text-lg font-semibold text-[var(--text-primary)]">{t('admin.nc_bindings_title')}</h3>
                <p className="text-sm text-[var(--text-muted)]">{t('admin.nc_bindings_desc')}</p>
            </div>
            {bound.length === 0 ? (
                <div className="text-sm p-6 text-center rounded-xl border text-[var(--text-muted)] bg-[var(--bg-secondary)] border-[var(--border-default)]">{t('admin.nc_bindings_empty')}</div>
            ) : (
                <div className="rounded-xl border overflow-x-auto border-[var(--border-default)]">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                                <th className="text-left font-medium px-4 py-2">{t('admin.nc_bindings_col_org')}</th>
                                <th className="text-left font-medium px-4 py-2">{t('admin.nc_bindings_col_url')}</th>
                                <th className="text-left font-medium px-4 py-2">{t('admin.nc_bindings_col_instance')}</th>
                                <th className="text-left font-medium px-4 py-2">{t('admin.nc_bindings_col_bound')}</th>
                                <th className="px-4 py-2"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {bound.map(org => (
                                <tr key={org.id} className="border-t border-[var(--border-subtle)]">
                                    <td className="px-4 py-2 text-[var(--text-primary)]">{org.name}<span className="block text-xs text-[var(--text-muted)]">{org.id}</span></td>
                                    <td className="px-4 py-2 text-[var(--text-secondary)]">{org.nc_base_url || '—'}</td>
                                    <td className="px-4 py-2 font-mono text-xs text-[var(--text-muted)]">{org.nc_instance_id}</td>
                                    <td className="px-4 py-2 text-[var(--text-muted)]">{org.nc_provisioned_at ? new Date(org.nc_provisioned_at).toLocaleDateString() : '—'}</td>
                                    <td className="px-4 py-2 text-right whitespace-nowrap">
                                        <button onClick={() => { if (onNavigate) onNavigate(`admin/security/connector-health/${org.id}`); }} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-teal-600 hover:bg-teal-500/10 font-medium"><Activity className="w-4 h-4" /> {t('admin.ch_health_link', 'Health')}</button>
                                        <button onClick={() => onRemoveNcBinding(org)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-amber-600 hover:bg-amber-500/10 font-medium"><Unlink className="w-4 h-4" /> {t('admin.org_nc_remove_title')}</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

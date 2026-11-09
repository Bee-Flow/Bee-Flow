import { Activity, Unlink } from 'lucide-react';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AdminOrganization } from './types';
import { EntitySectionHeader } from './EntityRows';
import { QUIET_BTN } from '@/components/mcpLibrary/ui';

export interface NextcloudBindingsSectionProps {
    organizations: AdminOrganization[];
    onNavigate?: (path: string) => void;
    onRemoveNcBinding: (org: AdminOrganization) => void;
    t: TranslateFn;
}

export default function NextcloudBindingsSection({ organizations, onNavigate, onRemoveNcBinding, t }: NextcloudBindingsSectionProps) {
    const bound = organizations.filter(o => o.nc_instance_id);
    return (
        <div>
            <EntitySectionHeader title={t('admin.nc_bindings_title')} description={t('admin.nc_bindings_desc')} />
            {bound.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[var(--border-default)] p-6 text-center text-sm text-[var(--text-tertiary)]">{t('admin.nc_bindings_empty')}</div>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-[var(--bg-secondary)] text-xs text-[var(--text-tertiary)]">
                                <th className="text-left font-medium px-4 py-2">{t('admin.nc_bindings_col_org')}</th>
                                <th className="text-left font-medium px-4 py-2">{t('admin.nc_bindings_col_url')}</th>
                                <th className="text-left font-medium px-4 py-2">{t('admin.nc_bindings_col_instance')}</th>
                                <th className="text-left font-medium px-4 py-2">{t('admin.nc_bindings_col_bound')}</th>
                                <th className="px-4 py-2"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {bound.map(org => (
                                <tr key={org.id} className="border-t border-[var(--border-default)]">
                                    <td className="px-4 py-2 text-[var(--text-primary)]">{org.name}<span className="block text-xs text-[var(--text-muted)]">{org.id}</span></td>
                                    <td className="px-4 py-2 text-[var(--text-secondary)]">{org.nc_base_url || '—'}</td>
                                    <td className="px-4 py-2 font-mono text-xs text-[var(--text-muted)]">{org.nc_instance_id}</td>
                                    <td className="px-4 py-2 text-[var(--text-muted)]">{org.nc_provisioned_at ? new Date(org.nc_provisioned_at).toLocaleDateString() : '—'}</td>
                                    <td className="px-4 py-2 text-right whitespace-nowrap">
                                        <button type="button" onClick={() => { if (onNavigate) onNavigate(`admin/security/connector-health/${org.id}`); }} className={QUIET_BTN}><Activity className="h-3.5 w-3.5" aria-hidden="true" /> {t('admin.ch_health_link', 'Health')}</button>
                                        <button type="button" onClick={() => onRemoveNcBinding(org)} className={QUIET_BTN}><Unlink className="h-3.5 w-3.5" aria-hidden="true" /> {t('admin.org_nc_remove_title')}</button>
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

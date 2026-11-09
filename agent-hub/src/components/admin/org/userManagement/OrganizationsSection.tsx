import { Edit2, Plus, Trash2, Unlink } from 'lucide-react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { API_BASE } from '@/utils/helpers';
import { ORG_SOURCE_KEY } from './constants';
import { AddButton, EntityList, EntityRow, EntitySectionHeader, OrgIcon, RowAction } from './EntityRows';
import type { AdminOrganization } from './types';

export interface OrganizationsSectionProps {
    organizations: AdminOrganization[];
    isFullAdmin: boolean | undefined;
    onAddOrg: () => void;
    onEditOrg: (org: AdminOrganization) => void;
    onDeleteOrg: (orgId: string) => void;
    onRemoveNcBinding: (org: AdminOrganization) => void;
    t: TranslateFn;
}

export default function OrganizationsSection({ organizations, isFullAdmin, onAddOrg, onEditOrg, onDeleteOrg, onRemoveNcBinding, t }: OrganizationsSectionProps) {
    return (
        <div>
            <EntitySectionHeader
                title={t('admin_org.orgs_section_title', 'Organizations')}
                description={t('admin_org.orgs_section_subtitle', 'Manage organizations and their metadata')}
                action={isFullAdmin ? <AddButton onClick={onAddOrg} icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}>{t('admin_org.orgs_section_add', 'Add Organization')}</AddButton> : undefined}
            />
            <EntityList>
                {organizations.map(org => (
                    <EntityRow
                        key={org.id}
                        icon={org.logo
                            ? <img src={org.logo.startsWith('/') ? `${API_BASE}${org.logo}` : org.logo} alt={org.name} className="h-8 w-8 object-contain" />
                            : <OrgIcon />}
                        title={org.name}
                        description={org.description}
                        details={<>
                            {org.nc_instance_id && <p className="m-0 mt-1 text-xs text-[var(--text-tertiary)]">{t('admin.org_nc_bound_label')}: {org.nc_base_url || org.nc_instance_id}</p>}
                            <p className="m-0 mt-1 text-xs text-[var(--text-tertiary)]">{t('admin.org_source_label')}: {t(ORG_SOURCE_KEY[org.registrationSource || ''] || 'admin.org_source_unknown')}</p>
                        </>}
                        actions={<>
                            <RowAction label={`${t('common.edit', 'Edit')} ${org.name}`} onClick={() => onEditOrg(org)}><Edit2 /></RowAction>
                            {isFullAdmin && org.nc_instance_id && <RowAction label={t('admin.org_nc_remove_title')} onClick={() => onRemoveNcBinding(org)}><Unlink /></RowAction>}
                            {isFullAdmin && <RowAction danger label={`${t('common.delete', 'Delete')} ${org.name}`} onClick={() => onDeleteOrg(org.id)}><Trash2 /></RowAction>}
                        </>}
                    />
                ))}
            </EntityList>
        </div>
    );
}

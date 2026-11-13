import { Check, X } from 'lucide-react';
import GroupAllowedTiers from './GroupAllowedTiers';
import BudgetEditor from './BudgetEditor';
import ImageLimitsEditor from '../imageLimits/ImageLimitsEditor';
import { ORG_ROLES } from '@/config/orgRoles';
import { useTranslation } from '@/hooks/useTranslation';
import { useDeploymentMode } from '@/hooks/useDeploymentMode';
import type { CustomTierMeta, OrgGroupRow } from '../useOrgDirectory';
import type { OrgGroups } from '../useOrgGroups';

interface GroupSettingsProps {
    group: OrgGroupRow;
    customTiersMeta: CustomTierMeta[];
    groupsState: OrgGroups;
}

function DescriptionEditor({ group, groupsState }: Omit<GroupSettingsProps, 'customTiersMeta'>) {
    const { t } = useTranslation();
    const { editingGroup, setEditingGroup, editGroupDesc, setEditGroupDesc, handleUpdateGroupDesc } = groupsState;
    return (
        <div className="flex items-start gap-2">
            <label className="text-xs text-[var(--text-secondary)] w-24 pt-1.5 shrink-0">{t('admin_org.users_description', 'Description')}</label>
            {editingGroup === group.id ? (
                <div className="flex items-center gap-2 flex-1">
                    <input
                        type="text"
                        value={editGroupDesc}
                        onChange={e => setEditGroupDesc(e.target.value)}
                        className="flex-1 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-xs outline-none focus:border-blue-500"
                        placeholder={t('admin_org.users_add_desc_ph', 'Add a description...')}
                        onKeyDown={e => e.key === 'Enter' && handleUpdateGroupDesc(group.id)}
                        autoFocus
                    />
                    <button onClick={() => handleUpdateGroupDesc(group.id)} className="p-1 text-green-500 hover:bg-green-500/10 rounded">
                        <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setEditingGroup(null)} className="p-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] rounded">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            ) : (
                <p className="text-xs text-[var(--text-muted)] pt-1.5 flex-1 cursor-pointer hover:text-[var(--text-primary)] transition-colors"
                    onClick={(e) => { e.stopPropagation(); setEditingGroup(group.id); setEditGroupDesc(group.description || ''); }}>
                    {group.description || <span className="italic opacity-60">{t('admin_org.users_click_add_desc', 'Click to add description...')}</span>}
                </p>
            )}
        </div>
    );
}

export function GroupRoleSelect({ group, onChange }: { group: OrgGroupRow; onChange: (groupId: string, role: string) => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2">
            <label className="text-xs text-[var(--text-secondary)] w-24 shrink-0">{t('admin_org.users_group_role', 'Group Role')}</label>
            <select
                value={group.orgRole || ''}
                onChange={e => onChange(group.id, e.target.value)}
                className="flex-1 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-xs outline-none focus:border-blue-500 cursor-pointer"
            >
                <option value="">{t('admin_org.users_user_default', 'User (default)')}</option>
                {ORG_ROLES.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                ))}
            </select>
            {group.orgRole && (
                <span className="text-[10px] text-[var(--text-muted)]">
                    {t('admin_org.users_inherit_role', 'All members inherit this role')}
                </span>
            )}
        </div>
    );
}

/** An expanded group's own settings: description, the role it grants, its budget and image limits, the tiers it allows. */
export default function GroupSettings({ group, customTiersMeta, groupsState }: GroupSettingsProps) {
    const { t } = useTranslation();
    const { isSelfHosted } = useDeploymentMode();
    return (
        <div className="space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {t('admin.org_group_settings', 'Group Settings')}
            </p>
            <DescriptionEditor group={group} groupsState={groupsState} />
            <GroupRoleSelect group={group} onChange={groupsState.handleUpdateGroupRole} />
            {isSelfHosted && (
                <BudgetEditor
                    showLabel
                    value={group.perUserCostLimit}
                    label={t('admin_org.group_modal_cost_limit', 'AI budget per member per month (€)')}
                    hint={t('admin_org.group_modal_cost_limit_hint', "Every member of this group gets this amount for themselves; it is not shared between them. A member's own budget takes precedence. Leave empty for no limit.")}
                    onSave={v => groupsState.handleUpdateGroupCostLimit(group.id, v)}
                />
            )}
            <ImageLimitsEditor
                value={group.perUserImageLimits}
                label={t('image_limits.group_label', 'Image limits per member')}
                hint={t('image_limits.group_hint', "Each member gets these limits for themselves. A member's own limit comes first; with several groups the most generous one applies. An empty window uses the organisation's default.")}
                onSave={limits => groupsState.handleUpdateGroupImageLimits(group.id, limits)}
            />
            <GroupAllowedTiers group={group} customTiersMeta={customTiersMeta} onChange={groupsState.handleUpdateGroupAllowedTiers} />
        </div>
    );
}

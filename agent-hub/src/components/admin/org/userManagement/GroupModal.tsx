import type { Dispatch, SetStateAction } from 'react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import type { AdminCurrentUser, AdminOrganization, AdminPermission, AdminRole, GroupFormData } from './types';

const ALLOWED_AGENT_TYPES = [
    { id: 'chat', name: 'Chat Agents' },
];

export interface GroupModalProps {
    open: boolean;
    onClose: () => void;
    showEditGroup: boolean;
    groupData: GroupFormData;
    setGroupData: Dispatch<SetStateAction<GroupFormData>>;
    organizations: AdminOrganization[];
    permissions: AdminPermission[];
    roles: AdminRole[];
    isFullAdmin: boolean;
    currentUser?: AdminCurrentUser | null;
    onSubmitAdd: () => void;
    onSubmitUpdate: () => void;
    t: TranslateFn;
}

export default function GroupModal({
    open, onClose, showEditGroup, groupData, setGroupData, organizations, permissions, roles, isFullAdmin, currentUser, onSubmitAdd, onSubmitUpdate, t,
}: GroupModalProps) {
    return (
        <Modal
            open={open}
            onClose={onClose}
            title={showEditGroup ? t('admin.sec_group_edit_title', 'Edit group') : t('admin.sec_group_add_title', 'Add new group')}
            size="md"
            footer={
                <>
                    <button onClick={onClose} className="px-4 py-2 rounded-lg font-medium text-[var(--text-secondary)]">
                        {t('admin.sec_cancel', 'Cancel')}
                    </button>
                    <button
                        onClick={showEditGroup ? onSubmitUpdate : onSubmitAdd}
                        className="px-4 py-2 rounded-lg font-medium bg-[var(--accent-primary)] text-white"
                    >
                        {showEditGroup ? t('admin.sec_save', 'Save') : t('admin.sec_group_add_submit', 'Add group')}
                    </button>
                </>
            }
        >
            <div className="space-y-4">
                {!showEditGroup && <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">Group Name</label><input type="text" value={groupData.name} onChange={e => setGroupData(p => ({ ...p, name: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="Editors" /></div>}

                <div>
                    <label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">Organization</label>
                    <select
                        value={groupData.organizationId || ''}
                        onChange={e => setGroupData(p => ({ ...p, organizationId: e.target.value || '' }))}
                        className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
                    >
                        <option value="" className="bg-[var(--bg-secondary)] text-[var(--text-secondary)]">None (Global Group)</option>
                        {organizations.map(org => (
                            <option key={org.id} value={org.id} className="bg-[var(--bg-secondary)] text-[var(--text-primary)]">{org.name}</option>
                        ))}
                    </select>
                </div>

                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">Description</label><input type="text" value={groupData.description} onChange={e => setGroupData(p => ({ ...p, description: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="Can edit agents" /></div>
                <div><label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">Permissions</label>
                    <div className="grid grid-cols-2 gap-2 max-h-40 overflow-auto p-2 rounded border border-[var(--border-subtle)]">
                        {permissions.filter(p => isFullAdmin || (currentUser?.permissions || []).includes(p.id)).map(p => (
                            <label key={p.id} className="flex items-center gap-2 cursor-pointer p-1 hover:bg-[var(--bg-tertiary)] rounded">
                                <input type="checkbox" checked={groupData.permissions.includes(p.id)} onChange={e => setGroupData(prev => ({ ...prev, permissions: e.target.checked ? [...prev.permissions, p.id] : prev.permissions.filter(x => x !== p.id) }))} className="accent-[var(--accent-primary)]" />
                                <span className="text-sm text-[var(--text-primary)]">{p.name}</span>
                            </label>
                        ))}
                    </div>
                </div>
                <div><label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">Assigned Roles</label>
                    <div className="grid grid-cols-2 gap-2 max-h-40 overflow-auto p-2 rounded border border-[var(--border-subtle)]">
                        {roles.filter(r => isFullAdmin || (r.permissions || []).every(rp => (currentUser?.permissions || []).includes(rp))).map(r => (
                            <label key={r.id} className="flex items-center gap-2 cursor-pointer p-1 hover:bg-[var(--bg-tertiary)] rounded">
                                <input type="checkbox" checked={groupData.roles?.includes(r.id)} onChange={e => setGroupData(prev => ({ ...prev, roles: e.target.checked ? [...(prev.roles || []), r.id] : (prev.roles || []).filter(x => x !== r.id) }))} className="accent-[var(--accent-primary)]" />
                                <span className="text-sm text-[var(--text-primary)]">{r.name}</span>
                            </label>
                        ))}
                    </div>
                </div>
                <div><label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">Allowed Agent Types</label>
                    <p className="text-xs mb-2 text-[var(--text-muted)]">Leave all unchecked to allow all types</p>
                    <div className="grid grid-cols-2 gap-2 max-h-40 overflow-auto p-2 rounded border border-[var(--border-subtle)]">
                        {ALLOWED_AGENT_TYPES.map(type => (
                            <label key={type.id} className="flex items-center gap-2 cursor-pointer p-1 hover:bg-[var(--bg-tertiary)] rounded">
                                <input type="checkbox" checked={(groupData.allowedAgentTypes || []).includes(type.id)} onChange={e => setGroupData(prev => ({ ...prev, allowedAgentTypes: e.target.checked ? [...(prev.allowedAgentTypes || []), type.id] : (prev.allowedAgentTypes || []).filter(x => x !== type.id) }))} className="accent-[var(--accent-primary)]" />
                                <span className="text-sm text-[var(--text-primary)]">{type.name}</span>
                            </label>
                        ))}
                    </div>
                </div>
            </div>
        </Modal>
    );
}

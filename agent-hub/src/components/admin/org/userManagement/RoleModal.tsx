import type { Dispatch, SetStateAction } from 'react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import type { AdminPermission, RoleFormData } from './types';

const PERMISSION_GROUPS = [
    { key: 'pages', labelKey: 'admin_org.role_modal_group_pages', label: '📄 Pages', color: '#3b82f6' },
    { key: 'admin', labelKey: 'admin_org.role_modal_group_admin', label: '🛡️ Admin Pages', color: '#8b5cf6' },
    { key: 'actions', labelKey: 'admin_org.role_modal_group_actions', label: '⚡ Actions', color: '#f59e0b' },
    { key: 'super', labelKey: 'admin_org.role_modal_group_super', label: '🔑 Super', color: '#ef4444' },
];

export interface RoleModalProps {
    open: boolean;
    onClose: () => void;
    showEditRole: boolean;
    roleData: RoleFormData;
    setRoleData: Dispatch<SetStateAction<RoleFormData>>;
    permissions: AdminPermission[];
    onSubmitAdd: () => void;
    onSubmitUpdate: () => void;
    t: TranslateFn;
}

export default function RoleModal({ open, onClose, showEditRole, roleData, setRoleData, permissions, onSubmitAdd, onSubmitUpdate, t }: RoleModalProps) {
    return (
        <Modal
            open={open}
            onClose={onClose}
            title={showEditRole ? t('admin.sec_role_edit_title', 'Edit role') : t('admin.sec_role_add_title', 'Add new role')}
            size="lg"
            footer={
                <>
                    <button onClick={onClose} className="px-4 py-2 rounded-lg font-medium text-[var(--text-secondary)]">
                        {t('admin.sec_cancel', 'Cancel')}
                    </button>
                    <button
                        onClick={showEditRole ? onSubmitUpdate : onSubmitAdd}
                        className="px-4 py-2 rounded-lg font-medium bg-[var(--accent-primary)] text-white"
                    >
                        {showEditRole ? t('admin.sec_save', 'Save') : t('admin.sec_role_add_submit', 'Add role')}
                    </button>
                </>
            }
        >
            <div className="space-y-4">
                {!showEditRole && <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.role_modal_name', 'Role Name')}</label><input type="text" value={roleData.name} onChange={e => setRoleData(p => ({ ...p, name: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder={t('admin_org.role_modal_name_ph', 'Editor')} /></div>}
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.role_modal_description', 'Description')}</label><input type="text" value={roleData.description} onChange={e => setRoleData(p => ({ ...p, description: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder={t('admin_org.role_modal_desc_ph', 'Can edit content')} /></div>
                <div><label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">{t('admin_org.role_modal_permissions', 'Permissions')}</label>
                    <div className="space-y-3 max-h-60 overflow-auto p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                        {/* Group permissions by their group field */}
                        {PERMISSION_GROUPS.map(group => {
                            const groupPerms = permissions.filter(p => p.group === group.key);
                            if (groupPerms.length === 0) return null;
                            return (
                                <div key={group.key}>
                                    <div className="text-xs font-semibold uppercase tracking-wider mb-1.5 px-1" style={{ color: group.color }}>{t(group.labelKey, group.label)}</div>
                                    <div className="space-y-0.5">
                                        {groupPerms.map(p => (
                                            <label key={p.id} className="flex items-center gap-2.5 cursor-pointer px-2 py-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors">
                                                <input type="checkbox" checked={roleData.permissions.includes(p.id)} onChange={e => setRoleData(prev => ({ ...prev, permissions: e.target.checked ? [...prev.permissions, p.id] : prev.permissions.filter(x => x !== p.id) }))} className="accent-[var(--accent-primary)] w-4 h-4" />
                                                <div className="flex-1 min-w-0">
                                                    <span className="text-sm font-medium block text-[var(--text-primary)]">{p.name}</span>
                                                    <span className="text-xs text-[var(--text-muted)]">{p.description}</span>
                                                </div>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </Modal>
    );
}

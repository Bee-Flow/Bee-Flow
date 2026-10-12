import { Building, ChevronDown, Image, Smile } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { ORG_ROLES } from '../../../../config/orgRoles';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { API_BASE } from '../../../../utils/helpers';
import Modal from '../../../shared/Modal';
import type { AdminGroup, AdminOrganization, UserFormData } from './types';

const EMOJI_CHOICES = ['😀', '😎', '🤖', '👨', '👩', '👤', '🧑‍💻', '👨‍💼', '👩‍💼', '🦸', '🧙', '👷', '🎅', '🐝', '🦊', '🐱', '🐶', '🐻', '🦁', '🐸', '🌟', '⭐', '🔥', '💡', '🎯', '🚀', '💻', '🛡️', '🎨', '📊', '🔧', '⚡'];

export interface UserModalProps {
    open: boolean;
    onClose: () => void;
    showEditUser: boolean;
    userData: UserFormData;
    setUserData: Dispatch<SetStateAction<UserFormData>>;
    showEmojiPicker: boolean;
    setShowEmojiPicker: Dispatch<SetStateAction<boolean>>;
    groups: AdminGroup[];
    organizations: AdminOrganization[];
    isPlatformAdmin: boolean;
    onSubmitAdd: () => void;
    onSubmitUpdate: () => void;
    onUploadAvatar: (file: File) => void;
    onRemoveAvatar: () => void;
    t: TranslateFn;
}

export default function UserModal({
    open, onClose, showEditUser, userData, setUserData, showEmojiPicker, setShowEmojiPicker,
    groups, organizations, isPlatformAdmin, onSubmitAdd, onSubmitUpdate, onUploadAvatar, onRemoveAvatar, t,
}: UserModalProps) {
    const canSubmit = showEditUser || (userData.username && userData.displayName && userData.password);
    return (
        <Modal
            open={open}
            onClose={onClose}
            title={showEditUser ? t('admin.sec_user_edit_title', 'Edit user') : t('admin.sec_user_add_title', 'Add new user')}
            size="md"
            footer={
                <>
                    <button onClick={onClose} className="px-4 py-2 rounded-lg font-medium text-[var(--text-secondary)]">
                        {t('admin.sec_cancel', 'Cancel')}
                    </button>
                    <button
                        // Arrow, not a bare reference: onSubmitUpdate takes no
                        // arguments, and React would hand a bare handler the
                        // click event, which would then be spread into the
                        // request body by handleUpdateUser's `extra` param.
                        onClick={showEditUser ? () => onSubmitUpdate() : onSubmitAdd}
                        disabled={!canSubmit}
                        className="px-4 py-2 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed bg-[var(--accent-primary)] text-white"
                    >
                        {showEditUser ? t('admin.sec_save', 'Save') : t('admin.sec_user_add_submit', 'Add user')}
                    </button>
                </>
            }
        >
            <div className="space-y-4">
                {/* Avatar Picker */}
                <div>
                    <label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">{t('admin_org.user_modal_avatar', 'Avatar')}</label>
                    <div className="flex items-center gap-4">
                        {/* Avatar preview */}
                        <div className="w-16 h-16 rounded-full flex items-center justify-center overflow-hidden border-2 border-[var(--border-default)] bg-[var(--bg-tertiary)]">
                            {userData.avatarType === 'emoji' && userData.avatar ? (
                                <span className="text-3xl">{userData.avatar}</span>
                            ) : userData.avatarType === 'image' && userData.avatar ? (
                                <img src={userData.avatar.startsWith('data:') || userData.avatar.startsWith('/') ? (userData.avatar.startsWith('/') ? `${API_BASE}${userData.avatar}` : userData.avatar) : userData.avatar} alt="" className="w-full h-full object-cover" />
                            ) : (
                                <span className="text-xl font-semibold text-[var(--text-muted)]">{(userData.displayName?.[0] || '?').toUpperCase()}</span>
                            )}
                        </div>
                        {/* Mode buttons */}
                        <div className="flex flex-col gap-2">
                            <div className="flex gap-2">
                                <button type="button" onClick={() => setShowEmojiPicker(!showEmojiPicker)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all bg-[var(--bg-tertiary)] text-[var(--text-primary)] ${showEmojiPicker ? 'ring-2 ring-[var(--accent-primary)]' : ''}`}>
                                    <Smile className="w-4 h-4" /> {t('admin_org.user_modal_emoji', 'Emoji')}
                                </button>
                                <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium cursor-pointer bg-[var(--bg-tertiary)] text-[var(--text-primary)]">
                                    <Image className="w-4 h-4" /> {t('admin_org.user_modal_upload', 'Upload')}
                                    <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        if (file) onUploadAvatar(file);
                                    }} />
                                </label>
                                {(userData.avatar) && (
                                    <button type="button" onClick={onRemoveAvatar} className="px-3 py-1.5 rounded-lg text-sm font-medium text-[var(--text-muted)]">{t('admin_org.user_modal_remove', 'Remove')}</button>
                                )}
                            </div>
                        </div>
                    </div>
                    {/* Emoji grid */}
                    {showEmojiPicker && (
                        <div className="mt-3 p-3 rounded-lg border grid grid-cols-8 gap-1.5 max-h-40 overflow-auto border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                            {EMOJI_CHOICES.map(emoji => (
                                <button key={emoji} type="button" onClick={() => { setUserData(p => ({ ...p, avatar: emoji, avatarType: 'emoji' })); setShowEmojiPicker(false); }} className="w-8 h-8 flex items-center justify-center rounded-lg text-lg hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer" style={userData.avatar === emoji ? { background: 'var(--accent-primary)', opacity: 0.8 } : {}}>{emoji}</button>
                            ))}
                        </div>
                    )}
                </div>
                {!showEditUser && <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.user_modal_username', 'Username')}</label><input type="text" value={userData.username} onChange={e => setUserData(p => ({ ...p, username: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder={t('admin_org.user_modal_username_ph', 'johndoe')} /></div>}
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.user_modal_display_name', 'Display Name')}</label><input type="text" value={userData.displayName} onChange={e => setUserData(p => ({ ...p, displayName: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder={t('admin_org.user_modal_display_name_ph', 'John Doe')} /></div>
                <div className="grid grid-cols-2 gap-4">
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.user_modal_first_name', 'First Name')}</label><input type="text" value={userData.firstName} onChange={e => setUserData(p => ({ ...p, firstName: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder={t('admin_org.user_modal_first_name_ph', 'John')} /></div>
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.user_modal_last_name', 'Last Name')}</label><input type="text" value={userData.lastName} onChange={e => setUserData(p => ({ ...p, lastName: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder={t('admin_org.user_modal_last_name_ph', 'Doe')} /></div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.user_modal_email', 'Email')}</label><input type="email" value={userData.email} onChange={e => setUserData(p => ({ ...p, email: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="john@example.com" /></div>
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.user_modal_phone', 'Phone')}</label><input type="tel" value={userData.phone} onChange={e => setUserData(p => ({ ...p, phone: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="+1 555 123 4567" /></div>
                </div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{showEditUser ? t('admin_org.user_modal_password_new', 'New Password (blank to keep)') : t('admin_org.user_modal_password', 'Password')}</label><input type="password" value={userData.password} onChange={e => setUserData(p => ({ ...p, password: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="••••••••" /></div>
                {/* ── Organisation Assignment ── */}
                <div className="p-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)]">
                    <div className="flex items-center gap-2 mb-3">
                        <Building className="w-4 h-4 text-[#8b5cf6]" />
                        <label className="text-sm font-semibold text-[var(--text-primary)]">{t('admin_org.user_modal_org_assignment', 'Organisation Assignment')}</label>
                    </div>

                    {/* Org selector — operators only. Tenant membership is not an
                        org admin's to change (the server answers 403
                        cross_org_move_denied), so they see it, they cannot set it. */}
                    <div className="mb-3">
                        <label className="block text-xs font-medium mb-1 text-[var(--text-muted)]">{t('admin_org.user_modal_organisation', 'Organisation')}</label>
                        {!isPlatformAdmin ? (
                            <div
                                className="w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-muted)]"
                            >
                                {organizations.find(o => o.id === userData.organizationId)?.name
                                    || t('admin.sec_no_organisation', '— No organisation —')}
                            </div>
                        ) : (
                            <div className="relative">
                                <select
                                    value={userData.organizationId || ''}
                                    onChange={e => {
                                        const newOrgId = e.target.value;
                                        // When org changes, auto-assign to org's default groups
                                        const orgGroups = groups.filter(g => g.organizationId === newOrgId);
                                        const otherGroups = (userData.groups || []).filter(gid => {
                                            const g = groups.find(gr => gr.id === gid);
                                            return !g?.organizationId; // keep non-org groups
                                        });
                                        const newGroups = newOrgId
                                            ? [...otherGroups, ...(orgGroups.length > 0 ? [orgGroups[0].id] : [])]
                                            : otherGroups;
                                        setUserData(p => ({ ...p, organizationId: newOrgId, groups: newGroups, orgRole: newOrgId ? (p.orgRole || 'member') : '' }));
                                    }}
                                    className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none appearance-none cursor-pointer focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
                                >
                                    <option value="">{t('admin.sec_no_organisation', '— No organisation —')}</option>
                                    {organizations.map(org => (
                                        <option key={org.id} value={org.id}>{org.name}</option>
                                    ))}
                                </select>
                                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none text-[var(--text-muted)]" />
                            </div>
                        )}
                    </div>

                    {/* Org role selector */}
                    {userData.organizationId && (
                        <div>
                            <label className="block text-xs font-medium mb-1.5 text-[var(--text-muted)]">{t('admin_org.user_modal_org_role', 'Organisation Role')}</label>
                            <div className="grid grid-cols-2 gap-2">
                                {ORG_ROLES.map((r) => {
                                    const isSelected = userData.orgRole === r.id;
                                    return (
                                        <button
                                            key={r.id}
                                            type="button"
                                            onClick={() => setUserData(p => ({ ...p, orgRole: r.id }))}
                                            className={`flex items-start gap-2 p-2.5 rounded-lg border-2 text-left transition-all ${isSelected ? 'border-[var(--accent-primary)]' : 'border-[var(--border-default)] hover:border-[var(--accent-primary)]/40'}`}
                                            style={{ background: isSelected ? `${r.color}08` : 'transparent' }}
                                        >
                                            <div className={`w-3 h-3 rounded-full border-2 mt-0.5 shrink-0 flex items-center justify-center ${isSelected ? 'border-[var(--accent-primary)]' : 'border-[var(--border-default)]'}`}>
                                                {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)]" />}
                                            </div>
                                            <div>
                                                <div className="text-xs font-semibold" style={{ color: isSelected ? r.color : 'var(--text-primary)' }}>{r.label}</div>
                                                <div className="text-[10px] text-[var(--text-muted)]">{r.description}</div>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {!userData.organizationId && (
                        <p className="text-xs text-[var(--text-muted)]">{t('admin_org.user_modal_select_org', 'Select an organisation to assign this user and set their role.')}</p>
                    )}
                </div>

                {/* ── Groups ── */}
                <div>
                    <label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">{t('admin_org.user_modal_groups', 'Groups')}</label>
                    <div className="max-h-48 overflow-auto p-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                        {/* Global Groups */}
                        {groups.filter(g => !g.organizationId).length > 0 && (
                            <div className="mb-2">
                                <div className="text-xs font-semibold uppercase tracking-wider mb-1.5 px-1 text-[var(--text-muted)]">{t('admin_org.user_modal_global_groups', 'Global Groups')}</div>
                                <div className="space-y-0.5">
                                    {groups.filter(g => !g.organizationId).map(g => (
                                        <label key={g.id} className="flex items-center gap-2.5 cursor-pointer px-2 py-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors">
                                            <input type="checkbox" checked={(userData.groups || []).includes(g.id)} onChange={e => setUserData(prev => ({ ...prev, groups: e.target.checked ? [...(prev.groups || []), g.id] : (prev.groups || []).filter(x => x !== g.id) }))} className="accent-[var(--accent-primary)] w-4 h-4" />
                                            <div className="flex-1 min-w-0">
                                                <span className="text-sm font-medium block text-[var(--text-primary)]">{g.name}</span>
                                                {g.description && <span className="text-xs text-[var(--text-muted)]">{g.description}</span>}
                                            </div>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        )}
                        {/* Groups by organization */}
                        {organizations.map(org => {
                            const orgGroups = groups.filter(g => g.organizationId === org.id);
                            if (orgGroups.length === 0) return null;
                            return (
                                <div key={org.id} className="mb-2">
                                    <div className="text-xs font-semibold uppercase tracking-wider mb-1.5 px-1 text-[var(--text-muted)]">{org.name}</div>
                                    <div className="space-y-0.5">
                                        {orgGroups.map(g => (
                                            <label key={g.id} className="flex items-center gap-2.5 cursor-pointer px-2 py-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors">
                                                <input type="checkbox" checked={(userData.groups || []).includes(g.id)} onChange={e => setUserData(prev => ({ ...prev, groups: e.target.checked ? [...(prev.groups || []), g.id] : (prev.groups || []).filter(x => x !== g.id) }))} className="accent-[var(--accent-primary)] w-4 h-4" />
                                                <div className="flex-1 min-w-0">
                                                    <span className="text-sm font-medium block text-[var(--text-primary)]">{g.name}</span>
                                                    {g.description && <span className="text-xs text-[var(--text-muted)]">{g.description}</span>}
                                                </div>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                        {groups.length === 0 && <p className="text-sm px-2 py-1 text-[var(--text-muted)]">{t('admin_org.user_modal_no_groups', 'No groups available')}</p>}
                    </div>
                </div>
            </div>
        </Modal>
    );
}

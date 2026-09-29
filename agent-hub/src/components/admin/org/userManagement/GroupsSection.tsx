import { Edit2, Shield, Trash2 } from 'lucide-react';
import type { AdminGroup, AdminOrganization, AdminUser } from './types';

export interface GroupsSectionProps {
    groups: AdminGroup[];
    organizations: AdminOrganization[];
    users: AdminUser[];
    canManageUsers: boolean;
    onAddGroup: () => void;
    onEditGroup: (group: AdminGroup) => void;
    onDeleteGroup: (groupId: string) => void;
}

export default function GroupsSection({ groups, organizations, users, canManageUsers, onAddGroup, onEditGroup, onDeleteGroup }: GroupsSectionProps) {
    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between mb-6">
                <div><h3 className="text-lg font-semibold text-[var(--text-primary)]">Groups</h3><p className="text-sm text-[var(--text-muted)]">Organize users and assign permissions</p></div>
                {canManageUsers && <button onClick={onAddGroup} className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium bg-[var(--accent-primary)] text-white"><Shield className="w-4 h-4" /> Add Group</button>}
            </div>
            <div className="space-y-6">
                {/* Groups without organization */}
                {groups.filter(g => !g.organizationId).length > 0 && (
                    <div className="space-y-4">
                        <h4 className="font-medium text-sm uppercase tracking-wider pl-2 text-[var(--text-muted)]">Global Groups</h4>
                        <div className="grid gap-4">
                            {groups.filter(g => !g.organizationId).map(group => (
                                <div key={group.id} className="p-4 rounded-xl border group hover:border-[var(--accent-primary)] bg-[var(--bg-secondary)] border-[var(--border-default)]">
                                    <div className="flex items-start justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(139, 92, 246, 0.15)' }}><Shield className="w-5 h-5 text-purple-400" /></div>
                                            <div><h4 className="font-semibold text-[var(--text-primary)]">{group.name}</h4><p className="text-sm text-[var(--text-muted)]">{group.description}</p></div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(139, 92, 246, 0.12)', color: '#a78bfa' }}>
                                                {users.filter(u => (u.groups || []).includes(group.id)).length} members
                                            </span>
                                            <div className="flex items-center gap-2 opacity-100 xl:opacity-0 xl:group-hover:opacity-100">
                                                <button onClick={() => onEditGroup(group)} className="p-1.5 rounded hover:bg-blue-500/10 text-blue-500"><Edit2 className="w-4 h-4" /></button>
                                                {group.id !== 'admins' && group.id !== 'users' && <button onClick={() => onDeleteGroup(group.id)} className="p-1.5 rounded hover:bg-red-500/10 text-red-500"><Trash2 className="w-4 h-4" /></button>}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        {group.permissions?.map(p => <span key={p} className="text-xs px-2 py-1 rounded-full bg-[var(--accent-primary)]/20 text-[var(--accent-primary)]">{p}</span>)}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Groups by organization */}
                {organizations.map(org => {
                    const orgGroups = groups.filter(g => g.organizationId === org.id);
                    if (orgGroups.length === 0) return null;
                    return (
                        <div key={org.id} className="space-y-4">
                            <h4 className="font-medium text-sm uppercase tracking-wider pl-2 flex items-center gap-2 text-[var(--text-muted)]">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" /><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" /><path d="M10 6h4" /><path d="M10 10h4" /><path d="M10 14h4" /><path d="M10 18h4" /></svg>
                                {org.name}
                            </h4>
                            <div className="grid gap-4">
                                {orgGroups.map(group => (
                                    <div key={group.id} className="p-4 rounded-xl border group hover:border-[var(--accent-primary)] ml-4 bg-[var(--bg-secondary)] border-[var(--border-default)]">
                                        <div className="flex items-start justify-between">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(139, 92, 246, 0.15)' }}><Shield className="w-5 h-5 text-purple-400" /></div>
                                                <div><h4 className="font-semibold text-[var(--text-primary)]">{group.name}</h4><p className="text-sm text-[var(--text-muted)]">{group.description}</p></div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(139, 92, 246, 0.12)', color: '#a78bfa' }}>
                                                    {users.filter(u => (u.groups || []).includes(group.id)).length} members
                                                </span>
                                                <div className="flex items-center gap-2 opacity-100 xl:opacity-0 xl:group-hover:opacity-100">
                                                    <button onClick={() => onEditGroup(group)} className="p-1.5 rounded hover:bg-blue-500/10 text-blue-500"><Edit2 className="w-4 h-4" /></button>
                                                    <button onClick={() => onDeleteGroup(group.id)} className="p-1.5 rounded hover:bg-red-500/10 text-red-500"><Trash2 className="w-4 h-4" /></button>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            {group.permissions?.map(p => <span key={p} className="text-xs px-2 py-1 rounded-full bg-[var(--accent-primary)]/20 text-[var(--accent-primary)]">{p}</span>)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

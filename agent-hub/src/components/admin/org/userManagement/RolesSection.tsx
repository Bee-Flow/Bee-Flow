import { Edit2, Tag, Trash2 } from 'lucide-react';
import type { AdminRole } from './types';

export interface RolesSectionProps {
    roles: AdminRole[];
    onAddRole: () => void;
    onEditRole: (role: AdminRole) => void;
    onDeleteRole: (roleId: string) => void;
}

export default function RolesSection({ roles, onAddRole, onEditRole, onDeleteRole }: RolesSectionProps) {
    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between mb-6">
                <div><h3 className="text-lg font-semibold text-[var(--text-primary)]">Roles</h3><p className="text-sm text-[var(--text-muted)]">Define role templates with permissions</p></div>
                <button onClick={onAddRole} className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium bg-[var(--accent-primary)] text-white"><Tag className="w-4 h-4" /> Add Role</button>
            </div>
            <div className="grid gap-4">
                {roles.map(role => (
                    <div key={role.id} className="p-4 rounded-xl border group hover:border-[var(--accent-primary)] bg-[var(--bg-secondary)] border-[var(--border-default)]">
                        <div className="flex items-start justify-between">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(245, 158, 11, 0.15)' }}><Tag className="w-5 h-5 text-amber-400" /></div>
                                <div><h4 className="font-semibold text-[var(--text-primary)]">{role.name}</h4><p className="text-sm text-[var(--text-muted)]">{role.description}</p></div>
                            </div>
                            <div className="flex items-center gap-2 opacity-100 xl:opacity-0 xl:group-hover:opacity-100">
                                <button onClick={() => onEditRole(role)} className="p-1.5 rounded hover:bg-blue-500/10 text-blue-500"><Edit2 className="w-4 h-4" /></button>
                                {role.id !== 'admin' && role.id !== 'user' && <button onClick={() => onDeleteRole(role.id)} className="p-1.5 rounded hover:bg-red-500/10 text-red-500"><Trash2 className="w-4 h-4" /></button>}
                            </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                            {role.permissions?.map(p => <span key={p} className="text-xs px-2 py-1 rounded-full bg-amber-500/20 text-amber-400">{p}</span>)}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

import React, { useMemo, useState } from 'react';
import { Users } from 'lucide-react';

export interface OrgUser {
    id: string;
    displayName?: string;
    email?: string;
    phone?: string | null;
    orgRole?: string | null;
}

interface UserPickerProps {
    users?: OrgUser[] | null;
    mode?: 'single' | 'multi';
    label?: string;
    placeholder?: string;
    onSelect?: (user: OrgUser) => void;
    excludeEmails?: string[];
    disabled?: boolean;
}

/**
 * UserPicker — org-member <select> for the compliance forms (DPO, breach
 * recipients). Purely presentational: the caller fetches the directory
 * (GET /api/compliance/org-users) and handles the selection.
 *
 * Renders null when `users` is null or empty (endpoint failed, 403, or no
 * members) so the surrounding free-text inputs always remain the fallback —
 * an external DPO or a shared mailbox must stay possible.
 *
 * props:
 *   users         Array<{id, displayName, email, phone, orgRole}> | null
 *   mode          'single' | 'multi' — multi resets the select after each
 *                 pick (add-as-chip usage) and hides already-added emails
 *   label         already-translated label text
 *   placeholder   already-translated text for the disabled first option
 *   onSelect(u)   called with the full user object
 *   excludeEmails string[] — multi only; case-insensitive
 *   disabled      boolean
 */
export default function UserPicker({ users, mode = 'single', label, placeholder, onSelect, excludeEmails = [], disabled = false }: UserPickerProps) {
    const [value, setValue] = useState('');

    const visible = useMemo(() => {
        if (!Array.isArray(users)) return [];
        if (mode !== 'multi' || !excludeEmails.length) return users;
        const taken = new Set(excludeEmails.map((e: string) => String(e).toLowerCase()));
        return users.filter((u: OrgUser) => !taken.has(String(u.email).toLowerCase()));
    }, [users, mode, excludeEmails]);

    if (!visible.length) return null;

    const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const id = e.target.value;
        const user = visible.find((u: OrgUser) => u.id === id);
        if (!user) return;
        onSelect?.(user);
        setValue(mode === 'multi' ? '' : id);
    };

    return (
        <label className="[display:flex] [flex-direction:column] [gap:4px]">
            <span style={labelStyle}>
                <Users size={11} className="[margin-right:4px] [vertical-align:-1px]" />
                {label}
            </span>
            <select value={value} onChange={handleChange} disabled={disabled} style={selectStyle}>
                <option value="" disabled>{placeholder}</option>
                {visible.map((u: OrgUser) => (
                    <option key={u.id} value={u.id}>{u.displayName} — {u.email}</option>
                ))}
            </select>
        </label>
    );
}

const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
    color: 'var(--text-muted)',
};
const selectStyle: React.CSSProperties = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 8, padding: '9px 12px', fontSize: 13,
    color: 'var(--text-primary)', width: '100%',
    outline: 'none', fontFamily: 'inherit',
};

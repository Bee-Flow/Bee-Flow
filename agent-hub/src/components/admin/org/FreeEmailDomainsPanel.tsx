import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { freeEmailDomainsKey, useFreeEmailDomains, type FreeEmailDomains } from '../../../api/queries/orgAdminReads';
import type { KeyboardEvent } from 'react';
import { TranslateParams, useTranslation } from '../../../hooks/useTranslation';
import { API_BASE } from '../../../utils/helpers';
import { Loader2, Plus, Trash2, AtSign, ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import { mutate, errorBody, RefusedError } from '../../../api/mutate';

interface DomainMessage {
    type: 'success' | 'error';
    text: string;
}

/**
 * FreeEmailDomainsPanel — super-admin editor for the free/public email-provider
 * blocklist. Domains on this list can never auto-bind a user to an organisation
 * via email-domain matching (OAuth login, Nextcloud connector, password signup).
 *
 * The built-in floor (gmail.com, …) is shown read-only and can never be removed;
 * admins add extra domains, persisted via PUT /auth/free-email-domains.
 */
/** The error note of a failed first read, or none. */
function loadFailedNote(failed: boolean, text: string): DomainMessage | null {
    return failed ? { type: 'error', text } : null;
}

export default function FreeEmailDomainsPanel() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const { builtin, extra, loading, loadFailed } = useFreeEmailDomains();
    const [newDomain, setNewDomain] = useState('');
    const [saving, setSaving] = useState(false);
    const [actionMessage, setMessage] = useState<DomainMessage | null>(null);
    // A refused or failed read shows its note for as long as the read stays failed.
    const message = actionMessage ?? loadFailedNote(loadFailed, t('admin.fed_load_failed', 'Failed to load email domains'));
    const [showBuiltin, setShowBuiltin] = useState(false);

    const notify = (type: DomainMessage['type'], text: string) => {
        setMessage({ type, text });
        setTimeout(() => setMessage(null), 3000);
    };


    // Persist a new extra list. Sends {extra} and adopts the server-normalised
    // list from the response so the UI reflects exactly what was stored.
    const persist = async (nextExtra: string[]) => {
        setSaving(true);
        try {
            const res = await mutate(`${API_BASE}/auth/free-email-domains`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ extra: nextExtra }),
            });
            const data = await res.json().catch(() => ({}));
            queryClient.setQueryData<FreeEmailDomains | null>(freeEmailDomainsKey, (prev) => ({ builtin: prev?.builtin ?? [], extra: Array.isArray(data.extra) ? data.extra : nextExtra }));
            notify('success', t('admin.fed_saved', 'Email-domain blocklist updated'));
            return true;
        } catch (err) {
            if (err instanceof RefusedError) {
                notify('error', (errorBody(err) ?? {}).error || t('admin.fed_save_failed', 'Failed to save'));
                return false;
            }
            notify('error', t('admin.fed_save_failed', 'Failed to save'));
            return false;
        } finally {
            setSaving(false);
        }
    };

    const addDomain = async () => {
        const raw = newDomain.trim().toLowerCase();
        if (!raw) return;
        // split() always returns ≥1 element, so pop() is a string.
        const domain = raw.includes('@') ? raw.split('@').pop() as string : raw;
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
            notify('error', t('admin.fed_invalid', 'Not a valid domain: "{domain}"').replace('{domain}', domain));
            return;
        }
        if (builtin.includes(domain)) {
            notify('error', t('admin.fed_builtin_dup', '"{domain}" is already a built-in domain').replace('{domain}', domain));
            return;
        }
        if (extra.includes(domain)) {
            notify('error', t('admin.fed_dup', '"{domain}" is already on the list').replace('{domain}', domain));
            return;
        }
        const ok = await persist([...extra, domain]);
        if (ok) setNewDomain('');
    };

    const removeDomain = async (domain: string) => {
        await persist(extra.filter(d => d !== domain));
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); addDomain(); }
    };

    if (loading) {
        return (
            <div className="[display:flex] [align-items:center] [gap:0.5rem] [color:var(--text-secondary,#6b7280)] [padding:1rem]">
                <Loader2 size={18} className="animate-spin" />
                {t('admin.fed_loading', 'Loading email domains…')}
            </div>
        );
    }

    return (
        <div className="max-w-[760px]">
            {message && (
                <div style={{
                    position: 'sticky', top: 0, zIndex: 10, marginBottom: '1rem',
                    padding: '0.65rem 0.9rem', borderRadius: 8, fontSize: '0.875rem',
                    background: message.type === 'success' ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
                    color: message.type === 'success' ? '#059669' : '#dc2626',
                    border: `1px solid ${message.type === 'success' ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                }}>
                    {message.text}
                </div>
            )}

            <div className="[display:flex] [align-items:center] [gap:0.6rem] [margin-bottom:0.35rem]">
                <AtSign size={20} className="[color:#8b5cf6]" />
                <h2 className="[font-size:1.15rem] [font-weight:600] [margin:0]">
                    {t('admin.fed_title', 'Free email-provider domains')}
                </h2>
            </div>
            <p className="[color:var(--text-secondary,#6b7280)] [font-size:0.9rem] [line-height:1.5] [margin-top:0] [margin-bottom:1.25rem]">
                {t('admin.fed_desc', 'Users signing in with an address at one of these domains are never automatically added to an organisation by email-domain matching. This stops a shared consumer domain (like gmail.com) from binding a stranger into someone else’s workspace. The built-in list always applies; add any extra domains your organisation should also treat as public.')}
            </p>

            {/* Add domain */}
            <div className="[display:flex] [gap:0.5rem] [margin-bottom:1.25rem]">
                <input
                    type="text"
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={t('admin.fed_placeholder', 'e.g. proton.me or someone@proton.me')}
                    disabled={saving}
                    className="[flex:1] [padding:0.55rem_0.75rem] [border-radius:8px] [border:1px_solid_var(--border-color,#d1d5db)] [font-size:0.9rem] [background:var(--bg-tertiary)] [color:var(--text-primary,#111827)]"
                />
                <button
                    onClick={addDomain}
                    disabled={saving || !newDomain.trim()}
                    style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                        padding: '0.55rem 0.9rem', borderRadius: 8, border: 'none',
                        background: '#8b5cf6', color: '#fff', fontSize: '0.9rem', fontWeight: 500,
                        cursor: saving || !newDomain.trim() ? 'not-allowed' : 'pointer',
                        opacity: saving || !newDomain.trim() ? 0.6 : 1,
                    }}
                >
                    {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                    {t('admin.fed_add', 'Add')}
                </button>
            </div>

            {/* Extra (editable) domains */}
            <FreeEmailDomainsPanelSection t={t} extra={extra} removeDomain={removeDomain} saving={saving} />

            {/* Built-in (read-only) domains */}
            <div>
                <button
                    onClick={() => setShowBuiltin(v => !v)}
                    className="[display:inline-flex] [align-items:center] [gap:0.4rem] [border:none] [background:transparent] [cursor:pointer] [font-size:0.8rem] [font-weight:600] [text-transform:uppercase] [letter-spacing:0.03em] [color:var(--text-secondary,#6b7280)] [padding:0]"
                >
                    {showBuiltin ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <ShieldCheck size={14} />
                    {t('admin.fed_builtin', 'Built-in domains')} ({builtin.length})
                </button>
                {showBuiltin && (
                    <div className="[display:flex] [flex-wrap:wrap] [gap:0.4rem] [margin-top:0.6rem]">
                        {builtin.map(domain => (
                            <span key={domain} className="[padding:0.3rem_0.55rem] [border-radius:999px] [font-size:0.8rem] [background:var(--surface-2,#f3f4f6)] [color:var(--text-secondary,#6b7280)] [border:1px_solid_var(--border-color,#e5e7eb)]">
                                {domain}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function FreeEmailDomainsPanelSection({ t, extra, removeDomain, saving }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; extra: string[]; removeDomain: (domain: string) => Promise<void>; saving: boolean; }) {
    return <div className="[margin-bottom:1.5rem]">
        <div className="[font-size:0.8rem] [font-weight:600] [text-transform:uppercase] [letter-spacing:0.03em] [color:var(--text-secondary,#6b7280)] [margin-bottom:0.5rem]">
            {t('admin.fed_custom', 'Custom domains')} ({extra.length})
        </div>
        {extra.length === 0 ? (
            <div className="[color:var(--text-secondary,#9ca3af)] [font-size:0.875rem] [font-style:italic]">
                {t('admin.fed_none', 'No custom domains added.')}
            </div>
        ) : (
            <div className="[display:flex] [flex-wrap:wrap] [gap:0.5rem]">
                {extra.map(domain => (
                    <span key={domain} className="[display:inline-flex] [align-items:center] [gap:0.4rem] [padding:0.35rem_0.6rem] [border-radius:999px] [font-size:0.85rem] [background:rgba(139,92,246,0.12)] [color:#7c3aed] [border:1px_solid_rgba(139,92,246,0.3)]">
                        {domain}
                        <button
                            onClick={() => removeDomain(domain)}
                            disabled={saving}
                            title={t('admin.fed_remove', 'Remove')}
                            className="[display:inline-flex] [border:none] [background:transparent] [cursor:pointer] [color:#7c3aed] [padding:0]"
                        >
                            <Trash2 size={14} />
                        </button>
                    </span>
                ))}
            </div>
        )}
    </div>;
}

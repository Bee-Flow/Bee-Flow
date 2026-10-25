import { Trash2, Share2, Star, Check, X } from 'lucide-react';
import { useState } from 'react';
import useConfirm from '../../components/shared/useConfirm';
import { useTranslation } from '../../hooks/useTranslation';
import { authFetch } from '../../utils/helpers';
import type { Grant, ErrorLineProps, SharePanelProps, ConnectionRowProps } from './ConnectionsManager.types';
import { BASE, EMERALD, EXPIRY_OPTIONS, inputStyle, inputCls, daysFromNowIso, errorFrom, httpMetaSummary } from './ConnectionsManager.helpers';

export const ErrorLine = ({ children }: ErrorLineProps) => (
    <p role="alert" className="text-[11px] mt-1 [color:#dc2626]!">{children}</p>
);

// ── Share panel for a single connection ─────────────────────────────
const SharePanel = ({ connection, grants, onChanged }: SharePanelProps) => {
    const { t } = useTranslation();
    const [email, setEmail] = useState('');
    const [expiry, setExpiry] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const mine = grants.filter((g) => g.connection_id === connection.id);

    const share = async (body: { granteeType: string; granteeEmail: string; } | { granteeType: string; }) => {
        setBusy(true); setErr(null);
        try {
            const res = await authFetch(`${BASE}/${connection.id}/grants`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, expiresAt: daysFromNowIso(expiry ? Number(expiry) : 0) }),
            });
            if (!res.ok) setErr(await errorFrom(res, t('connections.share_failed', 'Share failed')));
            else { setEmail(''); onChanged(); }
        } catch (e) { setErr((e as Error).message); }
        setBusy(false);
    };

    const revoke = async (grantId: string) => {
        setBusy(true); setErr(null);
        try {
            const res = await authFetch(`${BASE}/grants/${grantId}`, { method: 'DELETE' });
            if (!res.ok) setErr(await errorFrom(res, t('connections.revoke_failed', 'Could not revoke this share')));
            else onChanged();
        } catch (e) { setErr((e as Error).message); }
        setBusy(false);
    };

    // The server returns grantee_label (email or group name); fall back to the
    // raw id only when it could not be resolved.
    const granteeName = (g: Grant) => {
        if (g.grantee_type === 'org') return t('connections.grantee_org', 'Everyone in org');
        if (g.grantee_label) return g.grantee_label;
        return g.grantee_type === 'group'
            ? t('connections.grantee_group', 'Group')
            : t('connections.grantee_user', 'User');
    };

    return (
        <div className="mt-2 p-3 rounded-lg space-y-2.5 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
            <p className="text-[11px] text-[var(--text-muted)]">
                {t('connections.lend_explainer', "Lending shares this connection with full delegation — the recipient's runs use your credentials.")}
            </p>
            {connection.provider === 'http' && (
                <p className="text-[11px] [color:#d97706]!">
                    {t('connections.lend_http_warning', 'Sharing lends the full credential — recipients can call any URL with it.')}
                </p>
            )}
            <div className="flex flex-wrap gap-2 items-center">
                <input
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder={t('connections.teammate_email_placeholder', 'teammate@company.com')}
                    aria-label={t('connections.teammate_email_label', 'Teammate email')}
                    className={`flex-1 min-w-[180px] ${inputCls}`} style={inputStyle}
                    onKeyDown={e => e.key === 'Enter' && email.trim() && share({ granteeType: 'user', granteeEmail: email.trim() })}
                />
                <select
                    value={expiry} onChange={e => setExpiry(e.target.value)}
                    aria-label={t('connections.expiry_label', 'Expiry')}
                    className={inputCls} style={inputStyle}
                >
                    {EXPIRY_OPTIONS.map(o => <option key={o.label} value={o.value}>{t(o.labelKey, o.label)}</option>)}
                </select>
                <button
                    onClick={() => share({ granteeType: 'user', granteeEmail: email.trim() })}
                    disabled={busy || !email.trim()}
                    className="px-3 py-2 rounded-lg text-[13px] font-medium text-white disabled:opacity-40 bg-[var(--accent-primary)]"
                >{t('connections.lend_to_teammate', 'Lend to teammate')}</button>
            </div>
            <button
                onClick={() => share({ granteeType: 'org' })}
                disabled={busy}
                className="text-[12px] underline disabled:opacity-40 text-[var(--text-muted)]"
            >{t('connections.lend_to_org', 'Lend to everyone in my organization')}</button>
            {err && <ErrorLine>{err}</ErrorLine>}

            {mine.length > 0 && (
                <div className="space-y-1 pt-1">
                    {mine.map(g => (
                        <div key={g.id} className="flex items-center justify-between text-[12px] px-2 py-1.5 rounded bg-[var(--bg-secondary)]">
                            <span className="text-[var(--text-primary)]">
                                {granteeName(g)}
                                {g.resource_type ? ` · ${g.resource_type}` : ''}
                                {g.expires_at ? ` · ${t('connections.expires_on', 'expires')} ${new Date(g.expires_at).toLocaleDateString()}` : ''}
                            </span>
                            <button onClick={() => revoke(g.id)} disabled={busy} title={t('connections.revoke', 'Revoke')} className="opacity-70 hover:opacity-100">
                                <Trash2 size={13} />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ── A single named connection row ───────────────────────────────────
export const ConnectionRow = ({ connection, grants, onChanged }: ConnectionRowProps) => {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [renaming, setRenaming] = useState(false);
    const [label, setLabel] = useState(connection.label);
    const [sharing, setSharing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    // Keep the rename box in step with the server's value — without this a
    // reopened box still shows whatever was typed before the last reload.
    const [prevLabel, setPrevLabel] = useState(connection.label);
    if (prevLabel !== connection.label) {
        setPrevLabel(connection.label);
        setLabel(connection.label);
    }

    const patch = async (body: { makeDefault: boolean } | { label: string }, fallbackMsg: string) => {
        setBusy(true); setErr(null);
        try {
            const res = await authFetch(`${BASE}/${connection.id}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            if (!res.ok) setErr(await errorFrom(res, fallbackMsg));
            else onChanged();
        } catch (e) { setErr((e as Error).message); }
        setBusy(false);
    };

    const saveRename = async () => {
        const next = label.trim();
        if (!next || next === connection.label) { setRenaming(false); setLabel(connection.label); return; }
        await patch({ label: next }, t('connections.rename_failed', 'Could not rename this connection'));
        setRenaming(false);
    };

    // Deleting a credential is destructive and cannot be undone, so it always
    // confirms. A 409 means the connection backs active shares — that needs a
    // second, more explicit confirmation before forcing.
    const remove = async () => {
        if (!(await confirm({ title: t('connections.confirm_delete', 'Delete this connection? Any automation using it will stop working.'), confirmLabel: t('connections.delete', 'Delete'), destructive: true }))) return;
        setBusy(true); setErr(null);
        try {
            let res = await authFetch(`${BASE}/${connection.id}`, { method: 'DELETE' });
            if (res.status === 409) {
                if (!(await confirm({ title: t('connections.confirm_delete_shared', 'This connection is shared. Delete anyway and revoke all shares?'), confirmLabel: t('connections.delete', 'Delete'), destructive: true }))) {
                    setBusy(false);
                    return; // nothing changed — don't reload the list
                }
                res = await authFetch(`${BASE}/${connection.id}?force=1`, { method: 'DELETE' });
            }
            if (!res.ok) setErr(await errorFrom(res, t('connections.delete_failed', 'Could not delete this connection')));
            else onChanged();
        } catch (e) { setErr((e as Error).message); }
        setBusy(false);
    };

    const sharedCount = grants.filter(g => g.connection_id === connection.id).length;

    return (
        <div className="px-3 py-2.5 [border-top:1px_solid_var(--border-subtle)]">
            <div className="flex items-center gap-2">
                {renaming ? (
                    <>
                        <input
                            value={label} onChange={e => setLabel(e.target.value)} autoFocus
                            aria-label={t('connections.name_label', 'Connection name')}
                            className={`flex-1 ${inputCls}`} style={inputStyle}
                            onKeyDown={e => {
                                if (e.key === 'Enter') saveRename();
                                if (e.key === 'Escape') { setLabel(connection.label); setRenaming(false); }
                            }}
                        />
                        <button onClick={saveRename} disabled={busy} className="p-1" title={t('connections.save', 'Save')}><Check size={14} /></button>
                        <button onClick={() => { setLabel(connection.label); setRenaming(false); }} className="p-1" title={t('connections.cancel', 'Cancel')}><X size={14} /></button>
                    </>
                ) : (
                    <>
                        <span className="text-[13px] font-medium flex-1 text-[var(--text-primary)]">
                            {connection.label}
                            {connection.provider === 'http' && (
                                <span className="block text-[11px] font-normal text-[var(--text-muted)]">
                                    {httpMetaSummary(connection)}
                                </span>
                            )}
                        </span>
                        {connection.isDefault && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium flex items-center gap-1" style={{ background: 'rgba(5,150,105,0.1)', color: EMERALD }}>
                                <Star size={9} /> {t('connections.default', 'Default')}
                            </span>
                        )}
                        {sharedCount > 0 && (
                            <span className="text-[10px] text-[var(--text-muted)]">
                                {t('connections.share_count', '{count} shared', { count: sharedCount })}
                            </span>
                        )}
                        {!connection.isDefault && (
                            <button
                                onClick={() => patch({ makeDefault: true }, t('connections.set_default_failed', 'Could not set this as the default'))}
                                disabled={busy} className="text-[11px] underline text-[var(--text-muted)]"
                            >{t('connections.set_default', 'Set default')}</button>
                        )}
                        <button onClick={() => setRenaming(true)} className="text-[11px] underline text-[var(--text-muted)]">{t('connections.rename', 'Rename')}</button>
                        <button type="button" onClick={() => setSharing(v => !v)} aria-expanded={sharing} className="p-1" title={t('connections.share', 'Share')} style={{ color: sharing ? 'var(--accent-primary)' : 'var(--text-muted)' }}><Share2 size={14} /></button>
                        <button onClick={remove} disabled={busy} className="p-1 text-[var(--text-muted)]" title={t('connections.delete', 'Delete')}><Trash2 size={14} /></button>
                    </>
                )}
            </div>
            {err && <ErrorLine>{err}</ErrorLine>}
            {sharing && <SharePanel connection={connection} grants={grants} onChanged={onChanged} />}
            {confirmDialog}
        </div>
    );
};

import { Loader2, Pencil, Trash2, Usb } from 'lucide-react';
import { useState } from 'react';
import { isUsableHere, type SecurityKey } from '../../api/queries/securityKeys';
import { useTranslation } from '../../hooks/useTranslation';

interface Props {
    securityKey: SecurityKey;
    busy: boolean;
    onRename: (name: string) => Promise<unknown>;
    onRemove: () => Promise<unknown>;
}

const formatDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString() : '');
const iconButton = 'p-1.5 rounded-md';

/** Name, dates, and a warning when the key belongs to another address. */
function KeyDetails({ securityKey }: { securityKey: SecurityKey }) {
    const { t } = useTranslation();
    return (
        <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--text-primary)] truncate">{securityKey.name}</div>
            <div className="text-xs text-[var(--text-muted)]">
                {t('mfa.security_key_added_on', 'Added {date}', { date: formatDate(securityKey.createdAt) })}
                {' · '}
                {securityKey.lastUsedAt
                    ? t('mfa.security_key_last_used', 'Last used {date}', { date: formatDate(securityKey.lastUsedAt) })
                    : t('mfa.security_key_never_used', 'Not used yet')}
            </div>
            {!isUsableHere(securityKey.rpId) && (
                <div className="text-xs text-amber-500">
                    {t('mfa.security_key_other_host', 'Registered on {host}; it does not work on this address.', { host: securityKey.rpId })}
                </div>
            )}
        </div>
    );
}

/** The second step of removing: say what is left, then do it. */
function RemoveConfirm({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="ml-7 p-3 rounded-lg border border-red-500/30 bg-red-500/5 space-y-2">
            <p className="text-xs text-[var(--text-secondary)]">
                {t('mfa.security_key_remove_confirm', 'Remove this key? You can still sign in with your other second factors.')}
            </p>
            <div className="flex gap-2">
                <button onClick={onCancel} className="px-3 py-1.5 rounded-md border border-[var(--border-default)] text-xs font-medium text-[var(--text-secondary)]">
                    {t('common.cancel', 'Cancel')}
                </button>
                <button
                    onClick={onConfirm}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-md text-xs font-semibold text-white bg-red-600 disabled:opacity-50 flex items-center gap-1.5"
                >
                    {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                    {t('mfa.security_key_remove', 'Remove')}
                </button>
            </div>
        </div>
    );
}

/** One registered key: name, when it was added and last used, rename, remove. */
export default function SecurityKeyRow({ securityKey, busy, onRename, onRemove }: Props) {
    const { t } = useTranslation();
    const [mode, setMode] = useState<'view' | 'rename' | 'remove'>('view');
    const [name, setName] = useState(securityKey.name);

    const saveName = async () => {
        const trimmed = name.trim();
        if (trimmed && trimmed !== securityKey.name) await onRename(trimmed);
        setMode('view');
    };

    return (
        <li className="py-3 flex flex-col gap-2" data-testid="security-key-row">
            <div className="flex items-center gap-3">
                <Usb className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
                {mode === 'rename' ? (
                    <>
                        <input
                            className="flex-1 px-2 py-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] text-sm text-[var(--text-primary)]"
                            value={name}
                            maxLength={60}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setMode('view'); }}
                            aria-label={t('mfa.security_key_name_label', 'Name')}
                            autoFocus
                        />
                        <button onClick={saveName} disabled={busy} className="px-3 py-1 rounded-md text-xs font-semibold text-white bg-[var(--accent-primary)] disabled:opacity-50">
                            {t('mfa.security_key_save', 'Save')}
                        </button>
                    </>
                ) : (
                    <KeyDetails securityKey={securityKey} />
                )}
                {mode === 'view' && (
                    <div className="flex gap-1">
                        <button
                            onClick={() => { setName(securityKey.name); setMode('rename'); }}
                            className={`${iconButton} text-[var(--text-muted)] hover:text-[var(--text-primary)]`}
                            aria-label={t('mfa.security_key_rename', 'Rename')}
                            title={t('mfa.security_key_rename', 'Rename')}
                        >
                            <Pencil className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setMode('remove')}
                            className={`${iconButton} text-red-400 hover:text-red-500`}
                            aria-label={t('mfa.security_key_remove', 'Remove')}
                            title={t('mfa.security_key_remove', 'Remove')}
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                )}
            </div>
            {mode === 'remove' && <RemoveConfirm busy={busy} onCancel={() => setMode('view')} onConfirm={() => { onRemove(); }} />}
        </li>
    );
}

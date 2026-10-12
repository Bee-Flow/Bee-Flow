// A document could not be sealed or opened because this session holds no
// encryption key (zero-knowledge: the key is derived at sign-in, or from the
// PIN of a single-sign-on account). Instead of a dead-end error the person
// unlocks here, with the same PIN screen as at sign-in, and the action that
// was refused carries on.

import React from 'react';
import Modal from '../../../components/shared/Modal';
import { projectErrorInfo } from '../../../api/queries/projectErrors';
import useTranslation from '../../../hooks/useTranslation';
import { apiClient } from '../../../api/client';
import { API_BASE, authFetch } from '../../../utils/helpers';
import EncryptionSetupJs from '../../EncryptionSetup';

const EncryptionSetup = EncryptionSetupJs as unknown as React.ComponentType<{ mode: 'unlock'; onComplete: () => void }>;

export const KEY_UNAVAILABLE = 'document_encryption_key_unavailable';

/** Whether a refusal means "this session holds no key for that document". */
export function isKeyUnavailable(error: unknown): boolean {
    if (!error) return false;
    const { code } = projectErrorInfo(error);
    return code === KEY_UNAVAILABLE;
}

/** Whether the signed-in account unlocks with a PIN (single sign-on) rather than the password it signed in with. */
async function usesPin(): Promise<boolean> {
    try {
        const body = await apiClient.get<{ user?: { provider?: string } }>('/auth/user');
        const provider = body?.user?.provider;
        return !!provider && provider !== 'local';
    } catch {
        return false;
    }
}

export interface EncryptionUnlockProps {
    open: boolean;
    onUnlocked: () => void;
    onClose: () => void;
}

export default function EncryptionUnlock({ open, onUnlocked, onClose }: EncryptionUnlockProps) {
    const { t } = useTranslation();
    const [pin, setPin] = React.useState<boolean | null>(null);
    React.useEffect(() => {
        if (!open) return;
        let alive = true;
        setPin(null);
        usesPin().then((v) => { if (alive) setPin(v); });
        return () => { alive = false; };
    }, [open]);

    const signInAgain = async () => {
        try { await authFetch(`${API_BASE}/auth/logout`, { method: 'POST' }); } catch { /* the reload below shows the sign-in either way */ }
        window.location.reload();
    };

    if (!open || pin === null) return null;
    if (pin) {
        return (
            <div className="fixed inset-0 z-[1000] overflow-auto bg-[var(--bg-primary)]" data-testid="encryption-unlock">
                <EncryptionSetup mode="unlock" onComplete={onUnlocked} />
                <button type="button" onClick={onClose} className="fixed top-4 right-4 text-sm underline text-[var(--text-secondary)]">
                    {t('documents.encryption.cancel', 'Cancel')}
                </button>
            </div>
        );
    }
    return (
        <Modal open onClose={onClose} title={t('documents.encryption.locked_title', 'Unlock encryption')} size="sm">
            <div className="space-y-4" data-testid="encryption-unlock">
                <p className="text-sm text-[var(--text-secondary)]">
                    {t('documents.encryption.locked_signin', 'Your encryption key is not loaded in this session, so this document cannot be encrypted. Sign in again to unlock it, then start the document again.')}
                </p>
                <div className="flex justify-end gap-2">
                    <button type="button" onClick={onClose} className="h-8 px-3 rounded-[10px] border border-[var(--border-default)] text-xs font-medium">{t('documents.encryption.cancel', 'Cancel')}</button>
                    <button type="button" onClick={signInAgain} className="h-8 px-3 rounded-[10px] text-xs font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]">{t('documents.encryption.sign_in_again', 'Sign in again')}</button>
                </div>
            </div>
        </Modal>
    );
}

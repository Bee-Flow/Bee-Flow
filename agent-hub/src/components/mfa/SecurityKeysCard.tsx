import { AlertCircle, Loader2, Plus, Usb } from 'lucide-react';
import { useState } from 'react';
import {
    isUsableHere,
    proveWithSecurityKey,
    securityKeyErrorCode,
    securityKeysSupported,
    useAddSecurityKey,
    useRemoveSecurityKey,
    useRenameSecurityKey,
    useSecurityKeys,
} from '../../api/queries/securityKeys';
import { useTranslation } from '../../hooks/useTranslation';
import AddSecurityKeyForm, { type AddKeyProof } from './AddSecurityKeyForm';
import { securityKeyMessage } from './securityKeyMessages';
import SecurityKeyRow from './SecurityKeyRow';

const Spinner = () => <div className="flex justify-center py-3"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>;

interface Props {
    /** Whether two-factor authentication is on (by app, keys, or both). */
    mfaEnabled: boolean;
    totpEnabled: boolean;
    /** The first key turns 2FA on and returns recovery codes, to show once. */
    onRecoveryCodes?: (codes: string[]) => void;
    /** Called after a key was added or removed, so the MFA status can refresh. */
    onChange?: () => void;
}

/**
 * Settings → Security: the YubiKeys and other FIDO2 keys on this account. A
 * key is a second factor on its own; the first one turns two-factor
 * authentication on, and an authenticator app is optional next to it.
 */
export default function SecurityKeysCard({ mfaEnabled, totpEnabled, onRecoveryCodes, onChange }: Props) {
    const { t } = useTranslation();
    const supported = securityKeysSupported();
    const keysQuery = useSecurityKeys();
    const add = useAddSecurityKey();
    const rename = useRenameSecurityKey();
    const remove = useRemoveSecurityKey();
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState('');

    const keys = keysQuery.data ?? [];
    const canProveWithKey = supported && keys.some((k) => isUsableHere(k.rpId));
    const fail = (err: unknown) => setError(securityKeyMessage(securityKeyErrorCode(err), t));

    const submitAdd = async ({ name, proof }: { name: string; proof: AddKeyProof }) => {
        setError('');
        try {
            const resolved = proof === 'none' ? undefined : proof === 'key' ? await proveWithSecurityKey() : proof;
            const { recoveryCodes } = await add.mutateAsync({ name, proof: resolved });
            setAdding(false);
            if (recoveryCodes?.length) onRecoveryCodes?.(recoveryCodes);
            onChange?.();
        } catch (err) { fail(err); throw err; }
    };

    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5 space-y-3" data-testid="security-keys-card">
            <div className="flex items-start gap-2">
                <Usb className="w-5 h-5 mt-0.5 text-[var(--accent-primary)]" />
                <div>
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('mfa.security_keys_title', 'Security keys')}</h3>
                    <p className="text-xs text-[var(--text-muted)]">
                        {t('mfa.security_keys_desc', 'Sign in with a touch of a YubiKey or another FIDO2 security key, instead of or next to an authenticator app.')}
                    </p>
                </div>
            </div>

            {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-500 text-sm flex items-center gap-2" role="alert">
                    <AlertCircle className="w-4 h-4 shrink-0" /> {error}
                </div>
            )}

            {keysQuery.isLoading ? <Spinner /> : keys.length > 0 ? (
                <ul className="divide-y divide-[var(--border-subtle)]">
                    {keys.map((key) => (
                        <SecurityKeyRow
                            key={key.id}
                            securityKey={key}
                            busy={rename.isPending || remove.isPending}
                            onRename={(name) => rename.mutateAsync({ id: key.id, name }).catch(fail)}
                            onRemove={() => remove.mutateAsync(key.id).then(() => onChange?.()).catch(fail)}
                        />
                    ))}
                </ul>
            ) : (
                <p className="text-xs text-[var(--text-muted)]">{t('mfa.security_keys_none', 'No security keys yet.')}</p>
            )}

            {!supported ? (
                <p className="text-xs text-amber-500 flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {t('mfa.security_key_unsupported', 'This browser cannot use security keys here. Use a current Chrome, Edge, Firefox or Safari on the HTTPS address of Bee Flow.')}
                </p>
            ) : adding ? (
                <AddSecurityKeyForm
                    onSubmit={submitAdd}
                    onCancel={() => { setAdding(false); setError(''); }}
                    pending={add.isPending}
                    mfaEnabled={mfaEnabled}
                    totpEnabled={totpEnabled}
                    canProveWithKey={canProveWithKey}
                />
            ) : (
                <button
                    onClick={() => { setAdding(true); setError(''); }}
                    className="px-3 py-2 rounded-lg border border-[var(--border-default)] text-sm font-medium text-[var(--text-primary)] flex items-center gap-1.5"
                >
                    <Plus className="w-4 h-4" /> {t('mfa.security_key_add', 'Add security key')}
                </button>
            )}
        </div>
    );
}

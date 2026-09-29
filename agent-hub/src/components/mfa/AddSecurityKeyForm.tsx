import { Loader2, Usb } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';

/** How the form proves an existing factor: not at all, a code, or a key tap. */
export type AddKeyProof = 'none' | 'key' | { code: string };

interface Props {
    /** Resolves once the key is registered; rejects with the ceremony's error. */
    onSubmit: (input: { name: string; proof: AddKeyProof }) => Promise<unknown>;
    onCancel: () => void;
    pending: boolean;
    /** Off: this key becomes the account's first factor and needs no proof. */
    mfaEnabled: boolean;
    totpEnabled: boolean;
    /** A key the account already has works on this address. */
    canProveWithKey: boolean;
}

const field = 'w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]';
const label = 'block text-xs font-medium text-[var(--text-secondary)] mb-1';
const link = 'text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] underline underline-offset-2';

interface ProofFieldProps {
    mode: 'code' | 'key';
    setMode: (mode: 'code' | 'key') => void;
    code: string;
    setCode: (code: string) => void;
    totpEnabled: boolean;
    canProveWithKey: boolean;
}

/** How an account whose 2FA is on proves it: a code field, or a note that a key tap comes first. */
function ProofField({ mode, setMode, code, setCode, totpEnabled, canProveWithKey }: ProofFieldProps) {
    const { t } = useTranslation();
    return (
        <>
            {mode === 'code' ? (
                <div>
                    <label className={label} htmlFor="security-key-code">
                        {totpEnabled
                            ? t('mfa.security_key_code_label', 'Code from your authenticator app, or a recovery code')
                            : t('mfa.recovery_code', 'Recovery code')}
                    </label>
                    <input
                        id="security-key-code"
                        className={`${field} text-center tracking-[0.25em]`}
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        placeholder={totpEnabled ? '000000' : 'xxxx-xxxx'}
                        autoComplete="one-time-code"
                        maxLength={16}
                    />
                </div>
            ) : (
                <p className="text-xs text-[var(--text-secondary)]">
                    {t('mfa.security_key_prove_with_key', 'First touch a key you already registered, then the new one.')}
                </p>
            )}
            {canProveWithKey && (
                <button type="button" className={link} onClick={() => { setMode(mode === 'key' ? 'code' : 'key'); setCode(''); }}>
                    {mode === 'key'
                        ? t('mfa.security_key_prove_with_code', 'Confirm with a code instead')
                        : t('mfa.security_key_prove_with_key_instead', 'Confirm with a key you already have instead')}
                </button>
            )}
        </>
    );
}

/**
 * Name the key, prove an existing factor when 2FA is already on, then touch
 * the new key. The proof is what stops a stolen session from planting a key
 * of its own; the account's first factor needs none.
 */
export default function AddSecurityKeyForm({ onSubmit, onCancel, pending, mfaEnabled, totpEnabled, canProveWithKey }: Props) {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [code, setCode] = useState('');
    const [mode, setMode] = useState<'code' | 'key'>(!totpEnabled && canProveWithKey ? 'key' : 'code');
    const needsCode = mfaEnabled && mode === 'code';
    const ready = !pending && (!needsCode || code.trim().length >= 6);

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!ready) return;
        const proof: AddKeyProof = !mfaEnabled ? 'none' : mode === 'key' ? 'key' : { code: code.trim() };
        onSubmit({ name: name.trim(), proof })
            .then(() => { setCode(''); setName(''); })
            .catch(() => { setCode(''); });
    };

    return (
        <form onSubmit={submit} className="space-y-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-4" data-testid="add-security-key-form">
            <div>
                <label className={label} htmlFor="security-key-name">{t('mfa.security_key_name_label', 'Name')}</label>
                <input
                    id="security-key-name"
                    className={field}
                    value={name}
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('mfa.security_key_name_placeholder', 'e.g. YubiKey 5C NFC')}
                    autoFocus
                />
            </div>
            {!mfaEnabled && (
                <p className="text-xs text-[var(--text-secondary)]">
                    {t('mfa.security_key_first_hint', 'This key turns on two-factor authentication. You will get recovery codes to keep somewhere safe.')}
                </p>
            )}
            {mfaEnabled && (
                <ProofField mode={mode} setMode={setMode} code={code} setCode={setCode} totpEnabled={totpEnabled} canProveWithKey={canProveWithKey} />
            )}
            {pending && (
                <p className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5" role="status">
                    <Usb className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
                    {t('mfa.security_key_touch', 'Insert your security key and touch it when it flashes.')}
                </p>
            )}
            <div className="flex gap-2">
                <button type="button" onClick={onCancel} className="flex-1 py-2 rounded-lg border border-[var(--border-default)] text-sm font-medium text-[var(--text-secondary)]">
                    {t('common.cancel', 'Cancel')}
                </button>
                <button
                    type="submit"
                    disabled={!ready}
                    className="flex-1 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--accent-primary)] disabled:opacity-50 flex items-center justify-center gap-2"
                >
                    {pending && <Loader2 className="w-4 h-4 animate-spin" />}
                    {t('mfa.security_key_continue', 'Continue')}
                </button>
            </div>
        </form>
    );
}

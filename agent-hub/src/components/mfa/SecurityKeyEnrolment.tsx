import { AlertCircle, ArrowLeft, Loader2, Usb } from 'lucide-react';
import { useState } from 'react';
import { addSecurityKey, securityKeyErrorCode } from '../../api/queries/securityKeys';
import { useTranslation } from '../../hooks/useTranslation';
import { securityKeyMessage } from './securityKeyMessages';

interface Props {
    /** The key turned two-factor authentication on; these codes are shown once. */
    onEnrolled: (recoveryCodes: string[]) => void;
    onBack: () => void;
}

/**
 * The forced 2FA setup, done with a security key instead of an authenticator
 * app: name it, touch it. This is the account's first factor, so no proof is
 * asked; the server turns 2FA on and returns recovery codes.
 *
 * Calls addSecurityKey directly rather than through the React Query hook: the
 * gate renders before the app shell, and needs nothing cached.
 */
export default function SecurityKeyEnrolment({ onEnrolled, onBack }: Props) {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');

    const enrol = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setPending(true);
        try {
            const result = await addSecurityKey({ name: name.trim() });
            onEnrolled(result.recoveryCodes ?? []);
        } catch (err) {
            setError(securityKeyMessage(securityKeyErrorCode(err), t));
        } finally {
            setPending(false);
        }
    };

    return (
        <form onSubmit={enrol} className="space-y-4 text-left" data-testid="security-key-enrolment">
            {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-500 text-sm flex items-center gap-2" role="alert">
                    <AlertCircle className="w-4 h-4 shrink-0" /> {error}
                </div>
            )}
            <p className="text-sm text-[var(--text-secondary)]">
                {t('mfa.security_key_enrol_intro', 'Insert your YubiKey or other security key, give it a name, and touch it when it flashes.')}
            </p>
            <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1" htmlFor="security-key-enrol-name">
                    {t('mfa.security_key_name_label', 'Name')}
                </label>
                <input
                    id="security-key-enrol-name"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    value={name}
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('mfa.security_key_name_placeholder', 'e.g. YubiKey 5C NFC')}
                    autoFocus
                />
            </div>
            <button
                type="submit"
                disabled={pending}
                className="w-full py-2.5 rounded-lg text-sm font-semibold text-white bg-[var(--accent-primary)] disabled:opacity-50 flex items-center justify-center gap-2"
            >
                {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Usb className="w-4 h-4" />}
                {t('mfa.security_key_add', 'Add security key')}
            </button>
            <button
                type="button"
                onClick={onBack}
                className="w-full py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center gap-1.5"
            >
                <ArrowLeft className="w-4 h-4" /> {t('mfa.use_authenticator_setup', 'Use an authenticator app instead')}
            </button>
        </form>
    );
}

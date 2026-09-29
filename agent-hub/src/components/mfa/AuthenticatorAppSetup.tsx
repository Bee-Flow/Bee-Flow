import { Smartphone } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';

interface Props {
    /** The otpauth:// URI from POST /auth/mfa/setup. It carries the secret. */
    otpauthUrl?: string;
    /** The same URI as a QR image (data: URL). */
    qr: string;
    /** The same secret in base32, for typing into the app by hand. */
    secret: string;
}

/** A touch screen or a phone-sized window: where the QR is on the device that would scan it. */
const HANDHELD_QUERY = '(pointer: coarse), (max-width: 639px)';

function isHandheld(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    try {
        return !!window.matchMedia(HANDHELD_QUERY)?.matches;
    } catch {
        return false;
    }
}

/**
 * The authenticator-app half of 2FA enrolment, shared by the forced setup gate
 * (pages/login/MfaSetupGate.jsx) and Settings > Security: the steps, the QR
 * code, a tap-to-add link and the manual setup key.
 *
 * On a phone the QR is on the screen of the very device that would have to
 * scan it (BFSF-280). There the otpauth:// link comes first, since it opens
 * the authenticator app on the same device, and the setup key is shown
 * unfolded. On a desktop the link stays secondary (a desktop often has no
 * otpauth handler) and the key stays folded.
 *
 * The otpauth URL holds the same secret the key shows: it is rendered here
 * and nowhere else, never handed to the help assistant, logs or telemetry.
 */
export default function AuthenticatorAppSetup({ otpauthUrl, qr, secret }: Props) {
    const { t } = useTranslation();
    const [handheld] = useState(isHandheld);
    // Only a real otpauth URI becomes a link.
    const addUrl = typeof otpauthUrl === 'string' && /^otpauth:\/\//i.test(otpauthUrl) ? otpauthUrl : null;

    const addLink = addUrl && (
        <a
            href={addUrl}
            data-testid="mfa-add-to-app"
            className={handheld
                ? 'w-full py-2.5 rounded-lg text-sm font-semibold text-white bg-[var(--accent-primary)] flex items-center justify-center gap-2'
                : 'text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] underline flex items-center justify-center gap-1.5'}
        >
            <Smartphone className="w-4 h-4" /> {t('mfa.add_to_app_on_device', 'Add to the authenticator app on this device')}
        </a>
    );

    return (
        <>
            <ol className="text-sm text-left text-[var(--text-secondary)] space-y-1.5 list-decimal pl-5">
                <li>{t('mfa.setup_step1', 'Install an authenticator app on your phone — for example Google Authenticator, Microsoft Authenticator, 1Password or Bitwarden (any TOTP app works).')}</li>
                <li>{t('mfa.setup_step2', 'In the app, choose “Scan QR code” and scan the code below.')}</li>
                <li>{t('mfa.setup_step3', 'Enter the 6-digit code the app shows to confirm.')}</li>
            </ol>
            {handheld && addLink}
            <div className="flex justify-center">
                <img src={qr} alt="MFA QR code" width={200} height={200} className="rounded-lg border border-[var(--border-subtle)] bg-white p-2" />
            </div>
            {!handheld && addLink}
            <details className="text-xs text-[var(--text-muted)]" open={handheld}>
                <summary className="cursor-pointer">{t('mfa.cant_scan', 'Can’t scan? Enter this key manually')}</summary>
                <code className="block mt-2 p-2 rounded bg-[var(--bg-primary)] break-all select-all">{secret}</code>
            </details>
        </>
    );
}

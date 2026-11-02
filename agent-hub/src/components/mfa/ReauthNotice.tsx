import { AlertCircle } from 'lucide-react';
import { postLogout } from '@/api/queries/coreAuthSession';
import { useTranslation } from '@/hooks/useTranslation';
import { logger } from '@/utils/logger';

/** The code a step-up route answers when the session holds no recent sign-in. */
const REAUTH_REQUIRED = 'reauth_required';

/** True for an error (or error body) carrying the step-up refusal code. */
export function isReauthRequired(e: unknown): boolean {
    return !!e && typeof e === 'object' && (e as { code?: unknown }).code === REAUTH_REQUIRED;
}

/** End this session and show the sign-in, which records a fresh sign-in time. */
async function signInAgain(): Promise<void> {
    try { await postLogout(); } catch (err) { logger.debug('the reload below shows the sign-in either way', err); }
    window.location.reload();
}

/**
 * Shown when a change needs a recent sign-in (server auth/recentAuth.js):
 * the reason, and the way to sign in again.
 */
export default function ReauthNotice() {
    const { t } = useTranslation();
    return (
        <div role="alert" className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-[var(--text-primary)] flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{t('login.reauth_required', 'For your security, sign in again before making this change.')}</span>
            <button type="button" onClick={signInAgain} className="h-8 px-3 rounded-[10px] text-xs font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]">
                {t('mfa.reauth_sign_in', 'Sign in again')}
            </button>
        </div>
    );
}

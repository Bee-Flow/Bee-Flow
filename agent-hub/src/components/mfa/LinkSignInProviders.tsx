import { Link2 } from 'lucide-react';
import { useState } from 'react';
import { linkStartUrl, useLinkableProvidersQuery, type LinkableProvider } from '@/api/queries/ssoLink';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import ReauthNotice from './ReauthNotice';

const PROVIDER_NAMES: Record<LinkableProvider, string> = { google: 'Google', nextcloud: 'Nextcloud' };
const LINK_ERRORS = ['sso_identity_taken', 'sso_link_failed', 'sso_link_unsupported', 'reauth_required'];

type LinkResult = { linked: string } | { error: string } | null;

/** The outcome the link callback put in the address, removed from it once read. */
function takeLinkResult(): LinkResult {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get('linked');
    const error = params.get('error');
    let result: LinkResult = null;
    if (linked) result = { linked };
    else if (error && LINK_ERRORS.includes(error)) result = { error };
    if (result) {
        params.delete('linked');
        params.delete('error');
        const qs = params.toString();
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
    }
    return result;
}

function resultText(result: Exclude<LinkResult, null>, t: TranslateFn): string {
    if ('linked' in result) {
        const name = PROVIDER_NAMES[result.linked as LinkableProvider] || result.linked;
        return t('login.sso_linked', '{provider} sign-in is now linked to your account.', { provider: name });
    }
    if (result.error === 'sso_identity_taken') return t('login.sso_identity_taken', 'This sign-in is already linked to another account.');
    return t('login.sso_link_failed', 'The sign-in could not be linked. Please try again.');
}

/**
 * Account settings: link a configured sign-in provider (Google, Nextcloud)
 * to this account, so it can sign in with it. Starting a link needs a recent
 * sign-in; the server answers the outcome in the address it returns to.
 */
export default function LinkSignInProviders() {
    const { t } = useTranslation();
    const { data: providers = [] } = useLinkableProvidersQuery();
    const [result] = useState(takeLinkResult);

    if (!providers.length && !result) return null;
    return (
        <div className="space-y-3 rounded-xl border border-[var(--border-default)] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <Link2 className="w-4 h-4" /> {t('mfa.link_providers_title', 'Sign-in providers')}
            </div>
            {result && ('error' in result && result.error === 'reauth_required'
                ? <ReauthNotice />
                : <p role="status" className="text-sm text-[var(--text-secondary)]">{resultText(result, t)}</p>)}
            <div className="flex flex-wrap gap-2">
                {providers.map((provider) => (
                    <button
                        key={provider}
                        type="button"
                        onClick={() => window.location.assign(linkStartUrl(provider))}
                        className="h-8 px-3 rounded-[10px] border border-[var(--border-default)] text-xs font-medium text-[var(--text-primary)]"
                    >
                        {t('login.sso_link_button', 'Link {provider} sign-in', { provider: PROVIDER_NAMES[provider] })}
                    </button>
                ))}
            </div>
        </div>
    );
}

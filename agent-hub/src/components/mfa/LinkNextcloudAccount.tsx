import { Link2 } from 'lucide-react';
import { useState } from 'react';
import { API_BASE, mutate, RefusedError, errorBody } from '@/api/mutate';
import { useTranslation } from '@/hooks/useTranslation';
import ReauthNotice from './ReauthNotice';

/** The fragment key the connector's link page carries the ticket in (server auth/connector/ncLinkTicket.mts). */
const FRAGMENT_KEY = 'nc_link';

interface LinkTicket {
    ticket: string;
    uid: string;
    host: string;
}

/**
 * The ticket in the address (`#nc_link=<ticket>`), with the Nextcloud account
 * and host it names, for display only: the server checks the signature.
 */
export function readLinkTicket(hash: string): LinkTicket | null {
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const ticket = params.get(FRAGMENT_KEY);
    if (!ticket) return null;
    try {
        const part = ticket.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
        const claims = JSON.parse(atob(part)) as { n?: unknown; h?: unknown };
        const uid = typeof claims.n === 'string' ? claims.n : '';
        if (!uid) return null;
        return { ticket, uid, host: typeof claims.h === 'string' && claims.h ? claims.h : 'Nextcloud' };
    } catch {
        return null;
    }
}

/** Remove the ticket from the address once it was used or refused. */
function clearTicket() {
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', `${pathname}${search}`);
}

type State = 'idle' | 'working' | 'done' | 'failed' | 'other_account' | 'reauth';

/**
 * Account settings: link the Nextcloud account named in the address to this
 * account, once. The Bee Flow app inside Nextcloud sends a person here when
 * its sign-in found this account by e-mail address but may not use it before
 * its owner, signed in normally, confirms the link.
 */
export default function LinkNextcloudAccount() {
    const { t } = useTranslation();
    const [link] = useState(() => readLinkTicket(window.location.hash));
    const [state, setState] = useState<State>('idle');
    if (!link) return null;

    const confirmLink = async () => {
        setState('working');
        try {
            await mutate(`${API_BASE}/auth/connector/link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticket: link.ticket }),
            });
            setState('done');
            clearTicket();
        } catch (err) {
            const code = err instanceof RefusedError ? (errorBody(err) as { code?: string } | null)?.code : null;
            if (code === 'reauth_required') { setState('reauth'); return; }
            setState(code === 'nc_link_other_account' ? 'other_account' : 'failed');
            clearTicket();
        }
    };

    return (
        <div className="space-y-3 rounded-xl border border-[var(--border-default)] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <Link2 className="w-4 h-4" /> {t('mfa.nc_link_title', 'Link your Nextcloud account')}
            </div>
            {state === 'reauth' && <ReauthNotice />}
            {state === 'done' && <p role="status" className="text-sm text-[var(--text-secondary)]">{t('mfa.nc_link_done', 'Your Nextcloud account is linked. Go back to Nextcloud and reload Bee Flow.')}</p>}
            {state === 'failed' && <p role="alert" className="text-sm text-[var(--text-secondary)]">{t('mfa.nc_link_failed', 'The Nextcloud account could not be linked. Open Bee Flow in Nextcloud again for a new link.')}</p>}
            {state === 'other_account' && <p role="alert" className="text-sm text-[var(--text-secondary)]">{t('mfa.nc_link_other_account', 'This link is for another Bee Flow account. Sign in with the account it was made for.')}</p>}
            {(state === 'idle' || state === 'working') && (
                <>
                    <p className="text-sm text-[var(--text-secondary)]">
                        {t('mfa.nc_link_body', 'Link the Nextcloud account {uid} on {host} to this Bee Flow account. Bee Flow inside Nextcloud then signs you in as this account. Continue only if you opened this page yourself from Bee Flow in Nextcloud.', { uid: link.uid, host: link.host })}
                    </p>
                    <button
                        type="button"
                        disabled={state === 'working'}
                        onClick={confirmLink}
                        className="h-8 px-3 rounded-[10px] text-xs font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-60"
                    >
                        {t('mfa.nc_link_button', 'Link Nextcloud account')}
                    </button>
                </>
            )}
        </div>
    );
}

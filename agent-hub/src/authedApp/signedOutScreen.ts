/**
 * Which full-screen state a person without a session gets.
 *
 * Standalone that is the sign-in form. Inside Nextcloud (the connector embed)
 * the connector vouches for the person's Nextcloud account on every request,
 * so the embed first says what the connector's sign-in answered:
 *
 *   - the organisation's administrator has not finished the setup wizard
 *     (/auth/user answers 403 NC_ONBOARDING_PENDING): the "setup in progress"
 *     screen;
 *   - the connector is waiting for the e-mail verification code: that screen;
 *   - anything else: a short explanation with a retry, and a second action
 *     that opens the sign-in form (`formRequested`). A person with a Bee Flow
 *     account of their own signs in with it there; the session that sign-in
 *     hands to the embed takes precedence over the connector's.
 */
type SignedOutScreen = 'nc_onboarding_pending' | 'email_verification' | 'nc_sign_in_failed' | 'login';

/** The code the connector sign-in answers while the setup wizard is unfinished. */
export const NC_ONBOARDING_PENDING_CODE = 'NC_ONBOARDING_PENDING';

/** What a non-ok /auth/user said. */
export interface SignInRefusal {
    status: number;
    code: string | null;
    message: string | null;
    /**
     * With `nc_link_required`: the Bee Flow page (an http(s) address) where
     * the account's owner signs in and links this Nextcloud account once.
     */
    linkUrl?: string | null;
}

/** The code the connector sign-in answers for an account that is linked after a normal sign-in. */
const NC_LINK_REQUIRED_CODE = 'nc_link_required';

/** An http(s) address, or null: nothing else is ever opened. */
function webAddress(value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
    } catch { return null; }
}

/** Statuses on which the server's own sentence is meant for the person (the provisioning gates). */
const PERSONAL_STATUSES = new Set([403, 409]);

/**
 * Read a non-ok /auth/user answer. Never throws: a body that is not JSON (a
 * proxy's HTML page) is a refusal without code or message.
 */
export async function readSignInRefusal(res: Pick<Response, 'status' | 'json'>): Promise<SignInRefusal> {
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    const fields = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const code = typeof fields.code === 'string' && fields.code ? fields.code : null;
    const text = typeof fields.error === 'string' && fields.error.trim() ? fields.error.trim() : null;
    const linkUrl = code === NC_LINK_REQUIRED_CODE ? webAddress(fields.linkUrl) : null;
    return { status: res.status, code, message: PERSONAL_STATUSES.has(res.status) ? text : null, ...(linkUrl ? { linkUrl } : {}) };
}

export function signedOutScreen({ ncOnboardingState, diagnosticsState, embedded, formRequested = false }: {
    ncOnboardingState: string | null;
    diagnosticsState?: string | null;
    embedded: boolean;
    /** The person chose "Sign in with a Bee Flow account" on the embed's screen. */
    formRequested?: boolean;
}): SignedOutScreen {
    if (ncOnboardingState === 'pending') return 'nc_onboarding_pending';
    if (diagnosticsState === 'awaiting_email_verification') return 'email_verification';
    return embedded && !formRequested ? 'nc_sign_in_failed' : 'login';
}

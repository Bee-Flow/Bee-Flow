/** Facts about the signed-in account, in words. */

import { translate } from '@/core/i18n';
import { humanise } from '@/shared/lib/display';

/** 'local' means a password or OPAQUE login; anything else is an SSO provider. */
export function signInMethod(provider: string | undefined): string {
    if (!provider || provider === 'local') return translate('login.password', 'Password');
    return translate('mobile.account.sso_method', '{provider} single sign-on', { provider: humanise(provider) });
}

/** A name worth saving: changed, ignoring surrounding space, and not blank. */
export function nameChanged(name: string, current: string): boolean {
    return name.trim() !== current.trim() && name.trim().length > 0;
}

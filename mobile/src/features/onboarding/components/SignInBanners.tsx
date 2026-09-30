/**
 * What went wrong with the last sign-in, above the form: the password
 * sign-in's error, an SSO flow's error, or an SSO sign-in that succeeded on
 * the server but whose session had expired before this app claimed it.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Banner } from '@/shared/ui';

export function SignInBanners({
    error,
    ssoError,
    stranded,
}: {
    error: string | null;
    ssoError: string | null;
    /** Who signed in, when the session was lost on the way to the app. */
    stranded: string | null;
}) {
    const t = useTranslation();
    return (
        <>
            {error ? <Banner tone="error">{error}</Banner> : null}
            {ssoError ? <Banner tone="error">{ssoError}</Banner> : null}
            {stranded ? (
                <Banner tone="warning" icon="TriangleAlert">
                    {t(
                        'mobile.onboarding.sso_stranded',
                        '{name} signed in, but the session had already expired by the time this app claimed it. Try again — it usually works second time.',
                        { name: stranded },
                    )}
                </Banner>
            ) : null}
        </>
    );
}

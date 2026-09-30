/**
 * The public address's one line of facts: who can open it, how often it was
 * opened, and until when it works. Pure, so the two ways it used to be wrong
 * are tested: "1 views", and an expiry a week away read "expires now" (the
 * relative-age helper clamped a future time to zero). A deadline is a date.
 */

import { formatWhen, type TranslateFn } from '@/core/i18n';
import { nOf } from '@/shared/lib/plural';

import type { WebpageAudience } from './audienceTypes';

function accessLabel(audience: WebpageAudience, t: TranslateFn): string {
    const mode = audience.public.accessMode;
    if (mode === 'password') return t('mobile.webpages.public.state_password', 'Password protected');
    if (mode === 'email') {
        return t('mobile.webpages.public.state_email', 'Only {count} invited addresses', {
            count: audience.public.allowedEmails.length,
        });
    }
    return t('mobile.webpages.public.state_unlisted', 'Anyone with the address');
}

export function publicFacts(audience: WebpageAudience, t: TranslateFn): string[] {
    const facts = [
        accessLabel(audience, t),
        nOf(t, 'mobile.webpages.public.views', audience.public.viewCount, ['{count} view', '{count} views']),
        audience.public.expiresAt
            ? t('mobile.webpages.public.expires', 'expires {when}', { when: formatWhen(audience.public.expiresAt) })
            : null,
    ];
    return facts.filter((fact): fact is string => Boolean(fact));
}

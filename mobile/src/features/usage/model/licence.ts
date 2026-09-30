/** How a licence reads on screen: its tier's badge, and where it came from. */

import type { TranslateFn } from '@/core/i18n';
import { humanise } from '@/shared/lib/display';

import type { LicenseStatus } from './types';

/** The tier badge: accented for anything above Community, which is the default. */
export function tierBadge(license: LicenseStatus | null | undefined): {
    label: string;
    tone: 'accent' | 'neutral';
} {
    return {
        label: humanise(license?.tier ?? 'community'),
        tone: license && license.tier !== 'community' ? 'accent' : 'neutral',
    };
}

/** Where the tier came from, in words rather than in the server's enum. */
export function licenceSource(source: string | undefined, t: TranslateFn): string {
    switch (source) {
        case 'license_key':
            return t('mobile.usage.source_key', 'A licence key');
        case 'stripe_subscription':
            return t('mobile.usage.source_stripe', 'Your subscription');
        case 'server_license':
            return t('mobile.usage.source_server', 'This installation’s licence');
        default:
            return t('mobile.usage.source_default', 'Bee Flow Community');
    }
}

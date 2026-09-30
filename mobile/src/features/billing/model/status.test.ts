import type { TranslateFn } from '@/core/i18n';

import { subscriptionStatusLabel } from './status';

const t = ((_key: string, fallback: string) => fallback) as TranslateFn;

describe('subscriptionStatusLabel', () => {
    it('says the known statuses in words', () => {
        expect(subscriptionStatusLabel('active', t)).toBe('Active');
        expect(subscriptionStatusLabel('past_due', t)).toBe('Payment overdue');
        expect(subscriptionStatusLabel('canceled', t)).toBe('Cancelled');
    });

    it('makes an unknown enum readable instead of printing it raw', () => {
        expect(subscriptionStatusLabel('incomplete_expired', t)).not.toBe('incomplete_expired');
    });
});

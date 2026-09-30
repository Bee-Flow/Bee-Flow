import { _reset, setCatalogue, translate } from '@/core/i18n';

import { approvalStatusLabel, approvalWhenLine } from './status';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

beforeEach(() => _reset());

describe('approvalStatusLabel', () => {
    it('says the web’s words, not the server’s token', () => {
        expect(approvalStatusLabel('pending', translate)).toBe('Waiting');
        expect(approvalStatusLabel('approved', translate)).toBe('Approved');
        expect(approvalStatusLabel('rejected', translate)).toBe('Declined');
        expect(approvalStatusLabel('expired', translate)).toBe('Expired');
        expect(approvalStatusLabel('cancelled', translate)).toBe('Closed');
    });

    it('is translated through the web’s keys', () => {
        setCatalogue('nl', { 'approvals.status_rejected': 'Afgewezen' });
        expect(approvalStatusLabel('rejected', translate)).toBe('Afgewezen');
    });

    it('humanises a status it has never heard of rather than hiding it', () => {
        expect(approvalStatusLabel('on_hold', translate)).toBe('On hold');
    });
});

describe('approvalWhenLine', () => {
    it('says a deadline a week away as a date, never as "now"', () => {
        const line = approvalWhenLine({ status: 'pending', expiresAt: inDays(7), createdAt: inDays(-1) }, translate, NOW);
        expect(line.startsWith('Decide before ')).toBe(true);
        expect(line).toMatch(/Oct/);
        expect(line).not.toMatch(/now/i);
    });

    it('says a waiting approval without a deadline has none', () => {
        expect(approvalWhenLine({ status: 'pending', expiresAt: null, createdAt: inDays(-1) }, translate, NOW)).toBe('No deadline');
    });

    it('says when a settled approval was asked', () => {
        const line = approvalWhenLine({ status: 'rejected', expiresAt: inDays(-3), createdAt: inDays(-5) }, translate, NOW);
        expect(line.startsWith('Requested ')).toBe(true);
        expect(line).toMatch(/Sep/);
    });

    it('writes the date in the app’s language', () => {
        setCatalogue('nl', { 'approvals.decide_before_cap': 'Beslis vóór' });
        const line = approvalWhenLine({ status: 'pending', expiresAt: inDays(7), createdAt: inDays(-1) }, translate, NOW);
        expect(line.startsWith('Beslis vóór ')).toBe(true);
        expect(line).toMatch(/okt/);
    });
});

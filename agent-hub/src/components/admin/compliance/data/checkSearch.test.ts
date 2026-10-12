import { describe, it, expect } from 'vitest';
import { searchChecks } from './checkSearch';

const t = (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key);

const CHECKS = [
    { check_id: 'AIA-Art50-content-marking', regulation: 'AIA', article: '50(2)', titleKey: 'k1', scope_id: 'auto_1' },
    { check_id: 'AIA-Art50-content-marking', regulation: 'AIA', article: '50(2)', titleKey: 'k1', scope_id: 'auto_2' },
    { check_id: 'ISO27001-A.5.20-suppliers', regulation: 'ISO27001', article: 'A.5.20', titleKey: 'k2' },
    { check_id: 'GDPR-Art5-principles', regulation: 'GDPR', article: '5', titleKey: 'k3' },
];

const ids = (q: string) => searchChecks(CHECKS, q, t).map(h => h.check.check_id);

describe('searchChecks', () => {
    it('matches the article as written, with or without its dots, and the ISO control id', () => {
        expect(ids('Art. 50')).toEqual(['AIA-Art50-content-marking']);
        expect(ids('AI Act Art. 50')).toEqual(['AIA-Art50-content-marking']);
        expect(ids('art 50')).toEqual(['AIA-Art50-content-marking']);
        expect(ids('A.5.20')).toEqual(['ISO27001-A.5.20-suppliers']);
        expect(ids('GDPR Art. 5')).toEqual(['GDPR-Art5-principles']);
    });

    it('is one hit per check, counting its subjects', () => {
        const [hit] = searchChecks(CHECKS, 'marking', t);
        expect(hit.scopes).toBe(2);
        expect(hit.title).toBe('AIA-Art50-content-marking'); // t falls back to the id
        expect(searchChecks(CHECKS, 'suppliers', t)[0].scopes).toBe(1);
    });

    it('needs two characters and caps the list', () => {
        expect(searchChecks(CHECKS, 'a', t)).toEqual([]);
        expect(searchChecks(CHECKS, '  ', t)).toEqual([]);
        expect(searchChecks(null, 'art', t)).toEqual([]);
        expect(searchChecks(CHECKS, 'art', t, 1)).toHaveLength(1);
    });
});

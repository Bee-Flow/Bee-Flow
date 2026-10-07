import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCatalogue, quarterEndMs } from './check-legal-catalogue.mjs';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const good = (over = {}) => ({
    id: 'gdpr',
    sources: [{ label: 'Regulation (EU) 2016/679 — EUR-Lex', url: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj' }],
    legal_status_verified: '2026-10-01',
    ...over,
});

test('a well-formed, recently checked catalogue passes clean', () => {
    assert.deepEqual(assessCatalogue({ frameworks: [good()], nowMs: NOW }), { errors: [], warnings: [] });
});

test('malformed entries are errors', () => {
    const { errors } = assessCatalogue({
        frameworks: [
            good({ id: 'a', sources: [] }),
            good({ id: 'b', sources: [{ label: 'x', url: 'http://example.org' }] }),
            good({ id: 'c', legal_status_verified: 'last week' }),
            good({ id: 'd', legal_status_verified: '2027-01-01' }),
        ],
        nowMs: NOW,
    });
    assert.equal(errors.length, 4);
    assert.match(errors.join('\n'), /a: no sources/);
    assert.match(errors.join('\n'), /b: source "http:\/\/example.org" is not an https link/);
    assert.match(errors.join('\n'), /c: legal_status_verified "last week"/);
    assert.match(errors.join('\n'), /d: legal_status_verified 2027-01-01 is in the future/);
});

test('an old check is a warning, never an error', () => {
    const r = assessCatalogue({ frameworks: [good({ legal_status_verified: '2026-06-01' })], nowMs: NOW, staleAfterDays: 90 });
    assert.deepEqual(r.errors, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /127 days ago, limit 90/);
});

test('undated milestones must be uncertain with a quarter, and a passed quarter is a warning', () => {
    const r = assessCatalogue({
        frameworks: [],
        milestones: [
            { id: 'dated', date: '2026-12-02' },
            { id: 'fine', date: null, kind: 'uncertain', expected: '2026-Q4' },
            { id: 'past', date: null, kind: 'uncertain', expected: '2026-Q2' },
            { id: 'bad', date: null, kind: 'phase' },
        ],
        nowMs: NOW,
    });
    assert.deepEqual(r.errors.map(e => e.split(':')[0]), ['bad']);
    assert.deepEqual(r.warnings.map(w => w.split(':')[0]), ['past']);
});

test('quarterEndMs is the last moment of the quarter', () => {
    assert.equal(new Date(quarterEndMs('2026-Q4')).toISOString(), '2026-12-31T23:59:59.999Z');
    assert.ok(Number.isNaN(quarterEndMs('Q4 2026')));
});

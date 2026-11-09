'use strict';

/**
 * The AI Act register in the RoPA lists the newest attestation first. The
 * stamps come from the database as Date objects; ordering their text put
 * "Wed" before "Mon" whatever the dates were.
 *
 * Run: cd server && node --test routes/compliance/ropa.order.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { _test_byAttestedDesc: byAttestedDesc } = require('./ropa');

test('attestations sort by instant, newest first, as Dates and as ISO text', () => {
    const rows = [
        { id: 'mon', attested_at: new Date('2026-11-02T10:00:00Z') },   // a Monday
        { id: 'wed', attested_at: new Date('2026-10-28T10:00:00Z') },   // a Wednesday, older
        { id: 'fri', attested_at: '2026-11-06T10:00:00.000Z' },         // newest, as text
        { id: 'none', attested_at: null },
    ];
    assert.deepStrictEqual([...rows].sort(byAttestedDesc).map((r) => r.id), ['fri', 'mon', 'wed', 'none']);
});

'use strict';

/**
 * mail-security connector — a resolver failure on the SPF or DMARC lookup
 * fails the sweep (the collector keeps the last snapshot) instead of reading
 * as "no record"; NXDOMAIN does read as absent; the DMARC policy is the p=
 * tag, not the p= inside sp=; a revoked DKIM key (empty p=) is not a key.
 *
 * resolveTxt is replaced on node:dns's promises singleton, the object the
 * connector holds.
 *
 * Run: cd server && node --test compliance/connectors/mail-security.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns').promises;

const connector = require('./mail-security');

const realResolveTxt = dns.resolveTxt;
afterEach(() => { dns.resolveTxt = realResolveTxt; });

const dnsError = (code) => Object.assign(new Error(`queryTxt ${code}`), { code });

/** Answer from a name → rows map; a name not in it is NXDOMAIN. */
function zone(records, { fail = {} } = {}) {
    dns.resolveTxt = async (name) => {
        if (fail[name]) throw dnsError(fail[name]);
        if (records[name]) return records[name];
        throw dnsError('ENOTFOUND');
    };
}

test('a SERVFAIL on the domain fails the sweep instead of reading as "SPF absent"', async () => {
    zone({}, { fail: { 'example.com': 'ESERVFAIL' } });
    await assert.rejects(connector.collect({ settings: { domain: 'example.com' } }), /ESERVFAIL/);
});

test('a timeout on the DMARC lookup fails the sweep too', async () => {
    zone({ 'example.com': [['v=spf1 -all']] }, { fail: { '_dmarc.example.com': 'ETIMEOUT' } });
    await assert.rejects(connector.collect({ settings: { domain: 'example.com' } }), /ETIMEOUT/);
});

test('NXDOMAIN everywhere is a domain without SPF, DMARC or DKIM', async () => {
    zone({});
    const [row] = await connector.collect({ settings: { domain: 'example.com' } });
    assert.equal(row.payload.spf.present, false);
    assert.equal(row.payload.dmarc.present, false);
    assert.deepEqual(row.payload.dkim.found_selectors, []);
});

test('a failing DKIM selector probe never fails the sweep', async () => {
    zone({ 'example.com': [['v=spf1 -all']] }, { fail: { 'default._domainkey.example.com': 'ESERVFAIL' } });
    const [row] = await connector.collect({ settings: { domain: 'example.com' } });
    assert.equal(row.payload.spf.present, true);
});

test('the DMARC policy is the p= tag, not the one inside sp=; an empty p= is a revoked DKIM key', async () => {
    zone({
        'example.com': [['v=spf1 -all']],
        '_dmarc.example.com': [['v=DMARC1; sp=none; p=reject']],
        'default._domainkey.example.com': [['v=DKIM1; k=rsa; p=']],
        'google._domainkey.example.com': [['v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GN']],
    });
    const [row] = await connector.collect({ settings: { domain: 'example.com' } });
    assert.equal(row.payload.dmarc.policy, 'reject');
    assert.deepEqual(row.payload.dkim.found_selectors, ['google']);
});

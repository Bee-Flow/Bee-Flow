'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rangeToWindow, buildReportBody, createAnalyticsQueries } = require('./analyticsQueries');

const NOW = Date.parse('2026-10-11T15:30:00Z');
const DAY = 86400000;

test('rangeToWindow: tokens, today from UTC midnight, custom, unknown falls back to 7d', () => {
    assert.deepEqual(rangeToWindow('24h', { now: NOW }), { startAt: NOW - DAY, endAt: NOW, unit: 'hour' });
    assert.deepEqual(rangeToWindow('30d', { now: NOW }), { startAt: NOW - 30 * DAY, endAt: NOW, unit: 'day' });
    assert.deepEqual(rangeToWindow('today', { now: NOW }), { startAt: Date.parse('2026-10-11T00:00:00Z'), endAt: NOW, unit: 'hour' });
    assert.deepEqual(rangeToWindow('nonsense', { now: NOW }), { startAt: NOW - 7 * DAY, endAt: NOW, unit: 'day' });
    assert.equal(rangeToWindow('custom', { start: 0, end: DAY }).unit, 'hour');
    assert.equal(rangeToWindow('custom', { start: 0, end: 5 * DAY }).unit, 'day');
    assert.equal(rangeToWindow('custom', { start: 5, end: 1, now: NOW }).endAt, NOW);
});

test('buildReportBody: the envelope Umami 3 expects, extra options inside parameters', () => {
    const body = buildReportBody({
        type: 'breakdown', websiteId: 'w1', window: { startAt: 0, endAt: DAY, unit: 'hour' }, extra: { fields: ['path'] },
    });
    assert.equal(body.type, 'breakdown');
    assert.deepEqual(body.filters, {});
    assert.equal(body.dateRange.startDate, '1970-01-01T00:00:00.000Z');
    assert.deepEqual(body.parameters, {
        startDate: '1970-01-01T00:00:00.000Z', endDate: '1970-01-02T00:00:00.000Z', timezone: 'UTC', unit: 'hour', fields: ['path'],
    });
});

test('preflight walks enabled, configured, provisioned and resolves live before first', async () => {
    const store = new Map([['cms_analytics_enabled', true], ['cms_analytics_site_map', { pj_aaaa: 'w1', pj_bbbb: 'w2' }]]);
    let configured = true;
    const q = createAnalyticsQueries({
        configStore: { getConfig: async (k) => (store.has(k) ? store.get(k) : null) },
        umamiClient: { KEY_URL: 'u', isConfigured: async () => configured },
        getLiveSiteId: async () => 'pj_bbbb',
        siteIdRe: /^pj_[a-f0-9]+$/,
    });
    assert.deepEqual(await q.preflight(), { ok: true, target: { siteId: 'pj_bbbb', websiteId: 'w2' } });
    assert.deepEqual(await q.preflight('pj_aaaa'), { ok: true, target: { siteId: 'pj_aaaa', websiteId: 'w1' } });
    configured = false;
    assert.deepEqual(await q.preflight(), { ok: false, state: 'unconfigured' });
    store.set('cms_analytics_enabled', false);
    assert.deepEqual(await q.preflight(), { ok: false, state: 'disabled' });
    store.set('cms_analytics_enabled', true);
    configured = true;
    store.set('cms_analytics_site_map', {});
    assert.deepEqual(await q.preflight(), { ok: false, state: 'unprovisioned' });
});

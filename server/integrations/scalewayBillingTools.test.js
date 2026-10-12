/**
 * Unit tests for the Scaleway billing tool module.
 *
 * Run: node --test integrations/scalewayBillingTools.test.js
 *
 * No network, no DB: runScalewayBillingTool takes its `request` and `keepFile`
 * as arguments, so nothing here mocks a module.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    SCALEWAY_BILLING_TOOLS,
    isScalewayBillingTool,
    executeScalewayBillingTool,
    runScalewayBillingTool,
    moneyToNumber,
    periodWindow,
    invoiceFileName,
    billingMonth,
    shapeInvoice,
    describeError,
    clampLimit,
    SECRET_KEY_RE,
    ORG_ID_RE,
} = require('./scalewayBillingTools');

const KEY = '7d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const ORG = '11111111-2222-4333-8444-555555555555';
const INV_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = new Date('2026-10-06T12:00:00Z');

function rawInvoice(overrides = {}) {
    return {
        id: INV_ID,
        organization_id: ORG,
        organization_name: 'Bee Flow B.V.',
        number: 4815162,
        billing_period: '2026-09-01T00:00:00Z', // the live API's form, not YYYY-MM
        start_date: '2026-09-01T00:00:00Z',
        stop_date: '2026-09-30T23:59:59Z',
        issued_date: '2026-10-01T03:12:00Z',
        due_date: '2026-10-31T00:00:00Z',
        total_untaxed: { currency_code: 'EUR', units: 100, nanos: 0 },
        total_tax: { currency_code: 'EUR', units: 21, nanos: 0 },
        total_taxed: { currency_code: 'EUR', units: 121, nanos: 0 },
        type: 'periodic',
        state: 'paid',
        seller_name: 'Scaleway SAS',
        ...overrides,
    };
}

/** A scripted `request`: answers by path, records every call. */
function scriptedRequest(routes) {
    const calls = [];
    const request = async (url, opts) => {
        calls.push({ url, opts });
        const u = new URL(url);
        for (const [match, answer] of routes) {
            if (match(u)) return typeof answer === 'function' ? answer(u) : answer;
        }
        throw Object.assign(new Error(`unscripted ${u.pathname}`), { status: 599 });
    };
    return { request, calls };
}

const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1');

describe('tool definitions', () => {
    it('declares exactly the two read-only tools', () => {
        const names = SCALEWAY_BILLING_TOOLS.map(t => t.function.name).sort();
        assert.deepStrictEqual(names, ['scaleway_download_invoice', 'scaleway_list_invoices']);
        for (const n of names) assert.ok(isScalewayBillingTool(n));
        assert.ok(!isScalewayBillingTool('scaleway_delete_invoice'));
    });
});

describe('credential regexes', () => {
    it('accept UUIDs and refuse anything that could inject a header', () => {
        assert.ok(SECRET_KEY_RE.test(KEY));
        assert.ok(ORG_ID_RE.test(ORG));
        assert.ok(!SECRET_KEY_RE.test(`${KEY}\r\nX-Evil: 1`));
        assert.ok(!SECRET_KEY_RE.test('SCWXXXXXXXXXXXXXXXXX'));
        assert.ok(!ORG_ID_RE.test(`${ORG}&page=2`));
    });
});

describe('pure helpers', () => {
    it('moneyToNumber adds nanos and rounds to cents, negatives included', () => {
        assert.strictEqual(moneyToNumber({ currency_code: 'EUR', units: 12, nanos: 340000000 }), 12.34);
        assert.strictEqual(moneyToNumber({ currency_code: 'EUR', units: '7', nanos: 5000000 }), 7.01);
        assert.strictEqual(moneyToNumber({ currency_code: 'EUR', units: -3, nanos: -250000000 }), -3.25);
        assert.strictEqual(moneyToNumber(null), null);
    });

    it('periodWindow defaults to the last 12 months, the running month capped at its last second', () => {
        const w = periodWindow({}, NOW);
        assert.strictEqual(w.after, '2025-11-01T00:00:00.000Z');
        assert.strictEqual(w.before, '2026-10-31T23:59:59.000Z', 'never past the end of the running month');
    });

    it('periodWindow sends month starts: after = first day of periodFrom, before = first day after periodTo', () => {
        const w = periodWindow({ periodFrom: '2025-12', periodTo: '2026-01' }, NOW);
        assert.strictEqual(w.after, '2025-12-01T00:00:00.000Z');
        assert.strictEqual(w.before, '2026-02-01T00:00:00.000Z');
        const one = periodWindow({ periodFrom: '2026-09', periodTo: '2026-09' }, NOW);
        assert.deepStrictEqual(one, { after: '2026-09-01T00:00:00.000Z', before: '2026-10-01T00:00:00.000Z' });
    });

    it('periodWindow clamps a future periodTo to the running month', () => {
        assert.strictEqual(periodWindow({ periodTo: '2027-03' }, NOW).before, '2026-10-31T23:59:59.000Z');
    });

    it('periodWindow refuses malformed or reversed periods', () => {
        assert.throws(() => periodWindow({ periodFrom: '2026-13' }, NOW), /YYYY-MM/);
        assert.throws(() => periodWindow({ periodTo: 'september' }, NOW), /YYYY-MM/);
        assert.throws(() => periodWindow({ periodFrom: '2026-09', periodTo: '2026-01' }, NOW), /after/);
    });

    it('billingMonth reads YYYY-MM from a timestamp, a bare month or the start date', () => {
        assert.strictEqual(billingMonth({ billing_period: '2026-09-01T00:00:00Z' }), '2026-09');
        assert.strictEqual(billingMonth({ billing_period: '2026-09' }), '2026-09');
        assert.strictEqual(billingMonth({ start_date: '2025-11-01T00:00:00Z' }), '2025-11');
        assert.strictEqual(billingMonth({}), null);
    });

    it('invoiceFileName is stable and marks credit notes', () => {
        assert.strictEqual(invoiceFileName(rawInvoice()), 'Scaleway-2026-09-4815162.pdf');
        assert.strictEqual(invoiceFileName(rawInvoice({ type: 'credit_note' })), 'Scaleway-2026-09-4815162-credit-note.pdf');
        // A junk period falls back to start_date; path characters never survive.
        assert.strictEqual(invoiceFileName(rawInvoice({ billing_period: '../../etc', number: '1/2' })), 'Scaleway-2026-09-12.pdf');
        assert.strictEqual(invoiceFileName({ id: INV_ID, billing_period: '../../etc', number: '1/2' }), 'Scaleway-unknown-period-12.pdf');
    });

    it('shapeInvoice flattens amounts and drops the organisation name', () => {
        const s = shapeInvoice(rawInvoice());
        assert.deepStrictEqual(s, {
            id: INV_ID, number: 4815162, billingPeriod: '2026-09',
            issuedDate: '2026-10-01', dueDate: '2026-10-31',
            type: 'periodic', state: 'paid', currency: 'EUR',
            totalExclVat: 100, totalVat: 21, totalInclVat: 121,
            fileName: 'Scaleway-2026-09-4815162.pdf',
        });
    });

    it('clampLimit defaults and caps', () => {
        assert.strictEqual(clampLimit(undefined), 50);
        assert.strictEqual(clampLimit(0), 50);
        assert.strictEqual(clampLimit(500), 100);
        assert.strictEqual(clampLimit(7), 7);
    });

    it('describeError points a 403 at BillingReadOnly', () => {
        assert.match(describeError({ status: 403, message: 'x' }), /BillingReadOnly/);
        assert.match(describeError({ status: 401, message: 'x' }), /secret key/);
    });
});

describe('scaleway_list_invoices', () => {
    it('sends the key as X-Auth-Token, GET only, scoped to the organisation', async () => {
        const { request, calls } = scriptedRequest([
            [u => u.pathname.endsWith('/invoices'), { total_count: 1, invoices: [rawInvoice()] }],
        ]);
        const out = await runScalewayBillingTool('scaleway_list_invoices', {}, { secretKey: KEY, orgId: ORG }, { request, now: NOW });
        assert.strictEqual(out.count, 1);
        assert.strictEqual(out.invoices[0].fileName, 'Scaleway-2026-09-4815162.pdf');
        assert.strictEqual(calls.length, 1);
        const { url, opts } = calls[0];
        assert.strictEqual(opts.method, 'GET');
        assert.strictEqual(opts.headers['X-Auth-Token'], KEY);
        const u = new URL(url);
        assert.strictEqual(u.origin + u.pathname, 'https://api.scaleway.com/billing/v2beta1/invoices');
        assert.strictEqual(u.searchParams.get('organization_id'), ORG);
        assert.strictEqual(u.searchParams.get('order_by'), 'invoice_number_desc');
        assert.strictEqual(u.searchParams.get('billing_period_start_before'), '2026-10-31T23:59:59.000Z');
    });

    it('leaves voided invoices out unless asked for', async () => {
        const voided = rawInvoice({ id: 'v', number: 0, state: 'voided', billing_period: '2025-11-01T00:00:00Z' });
        const routes = () => scriptedRequest([
            [u => u.pathname.endsWith('/invoices'), { total_count: 2, invoices: [voided, rawInvoice()] }],
        ]);
        const out = await runScalewayBillingTool('scaleway_list_invoices', {}, { secretKey: KEY }, { request: routes().request, now: NOW });
        assert.deepStrictEqual(out.invoices.map(i => i.id), [INV_ID]);
        const all = await runScalewayBillingTool('scaleway_list_invoices', { includeVoided: true }, { secretKey: KEY }, { request: routes().request, now: NOW });
        assert.strictEqual(all.count, 2);
    });

    it('omits organization_id when none is stored and filters the type itself', async () => {
        const { request, calls } = scriptedRequest([
            [u => u.pathname.endsWith('/invoices'), { total_count: 2, invoices: [rawInvoice(), rawInvoice({ id: 'cn', type: 'credit_note' })] }],
        ]);
        const out = await runScalewayBillingTool('scaleway_list_invoices', { type: 'credit_note' }, { secretKey: KEY, orgId: null }, { request, now: NOW });
        const u = new URL(calls[0].url);
        assert.strictEqual(u.searchParams.get('organization_id'), null);
        assert.strictEqual(u.searchParams.get('invoice_type'), null, 'the API 400s on invoice_type=credit_note');
        assert.deepStrictEqual(out.invoices.map(i => i.id), ['cn']);
    });

    it('refuses an unknown invoice type before calling Scaleway', async () => {
        const { request, calls } = scriptedRequest([]);
        await assert.rejects(
            runScalewayBillingTool('scaleway_list_invoices', { type: 'refund' }, { secretKey: KEY }, { request, now: NOW }),
            /type must be one of/,
        );
        assert.strictEqual(calls.length, 0);
    });

    it('asks for a full page, sorts newest first and cuts at `limit` after dropping voided ones', async () => {
        const voided = rawInvoice({ id: 'v', number: 0, state: 'voided', billing_period: '2025-11-01T00:00:00Z' });
        const months = Array.from({ length: 5 }, (_, i) => rawInvoice({ id: `id-${i}`, number: 1000 + i, billing_period: `2026-0${i + 1}-01T00:00:00Z` }));
        const { request, calls } = scriptedRequest([
            [u => u.pathname.endsWith('/invoices'), { total_count: 6, invoices: [voided, ...months] }],
        ]);
        const out = await runScalewayBillingTool('scaleway_list_invoices', { limit: 3 }, { secretKey: KEY }, { request, now: NOW });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(new URL(calls[0].url).searchParams.get('page_size'), '100');
        assert.deepStrictEqual(out.invoices.map(i => i.billingPeriod), ['2026-05', '2026-04', '2026-03'], 'a voided first row does not cost a place');
        assert.strictEqual(out.count, 3);
        assert.strictEqual(out.total, 6);
    });
});

describe('scaleway_download_invoice', () => {
    function downloadRoutes(content = pdfBytes.toString('base64')) {
        return scriptedRequest([
            [u => u.pathname.endsWith('/download'), { name: 'invoice.pdf', content_type: 'application/pdf', content }],
            [u => u.pathname.endsWith(`/invoices/${INV_ID}`), rawInvoice()],
        ]);
    }

    it('decodes the PDF, keeps it for the run and returns a generated_file handle', async () => {
        const { request, calls } = downloadRoutes();
        const kept = [];
        const keepFile = async (f) => { kept.push(f); return { id: 'gf_1' }; };
        const out = await runScalewayBillingTool('scaleway_download_invoice', { invoiceId: INV_ID }, { secretKey: KEY }, { request, keepFile });

        assert.strictEqual(kept.length, 1);
        assert.ok(kept[0].buffer.equals(pdfBytes));
        assert.strictEqual(kept[0].mimeType, 'application/pdf');
        assert.strictEqual(kept[0].filename, 'Scaleway-2026-09-4815162.pdf');
        assert.deepStrictEqual(out.sourceHandle, { kind: 'generated_file', fileId: 'gf_1' });
        assert.strictEqual(out.size, pdfBytes.length);
        assert.strictEqual(out.invoiceNumber, 4815162);
        assert.ok(!('content' in out), 'the bytes never land in the step output');

        const dl = calls.find(c => c.url.includes('/download'));
        assert.strictEqual(new URL(dl.url).searchParams.get('file_type'), 'pdf');
        for (const c of calls) assert.strictEqual(c.opts.method, 'GET');
    });

    it('refuses outside an automation run without calling Scaleway', async () => {
        const { request, calls } = downloadRoutes();
        await assert.rejects(
            runScalewayBillingTool('scaleway_download_invoice', { invoiceId: INV_ID }, { secretKey: KEY }, { request, keepFile: null }),
            /only works inside an automation/,
        );
        assert.strictEqual(calls.length, 0);
    });

    it('refuses an id that is not a UUID', async () => {
        const { request, calls } = downloadRoutes();
        await assert.rejects(
            runScalewayBillingTool('scaleway_download_invoice', { invoiceId: '../invoices' }, { secretKey: KEY }, { request, keepFile: async () => ({ id: 'x' }) }),
            /UUID/,
        );
        assert.strictEqual(calls.length, 0);
    });

    it('refuses content that is not a PDF', async () => {
        const { request } = downloadRoutes(Buffer.from('<html>login</html>').toString('base64'));
        const keepFile = async () => { throw new Error('must not be called'); };
        await assert.rejects(
            runScalewayBillingTool('scaleway_download_invoice', { invoiceId: INV_ID }, { secretKey: KEY }, { request, keepFile }),
            /not a PDF/,
        );
    });
});

describe('executeScalewayBillingTool', () => {
    it('needs a user and a known tool', async () => {
        assert.match((await executeScalewayBillingTool('scaleway_list_invoices', {}, null)).error, /User context/);
        assert.match((await executeScalewayBillingTool('scaleway_nope', {}, 'u1')).error, /Unknown/);
    });
});

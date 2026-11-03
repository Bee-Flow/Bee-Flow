/**
 * The payslips of a payroll run (nmbrsPayslips.mts), over SOAP and REST, through
 * executeNmbrsTool as the agent calls it. The NMBRS transport is scripted, the clock
 * is fake (no real waiting), the OAuth vault is a stub.
 */

const test = require('node:test');
const assert = require('node:assert');

const { useConfigRows } = require('../testUtils/configRows');
const SECRETS = useConfigRows().rows;

const { executeNmbrsTool, SOAP_METHODS_READONLY } = require('./nmbrsTools');
const { nmbrsTransport } = require('./nmbrsTransport.mts');
const { oauthDeps } = require('./nmbrsOAuth.mts');
const { parsePayslipXml, pollUntilReady, readPollConfig, executeRunPayslips } = require('./nmbrsPayslips.mts');

const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const TASK = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
const RUN_UUID = '11111111-2222-3333-4444-555555555555';

SECRETS.nmbrs_api_mode_user_soapU = 'soap';
SECRETS.nmbrs_subdomain_user_soapU = 'acme';
SECRETS.nmbrs_email_user_soapU = 'me@acme.nl';
SECRETS.nmbrs_token_user_soapU = TOKEN;
SECRETS.nmbrs_api_mode_user_restU = 'rest';
SECRETS.nmbrs_subscription_key_user_restU = 'sub-key-0123456789abcdef';
oauthDeps.credentials = () => ({
    getCredential: async () => ({ userId: 'restU', orgId: 'o1', accessToken: TOKEN, refreshToken: 'r', expiresAt: Date.now() + 3600_000, scope: null, status: 'active' }),
    upsertCredential: async () => {},
    markNeedsReauth: async () => {},
});

// A payslip with the documented footer, plus the personal block that must never reach the model.
const PAYSLIP_XML = '<payslips>'
    + '<payslip><employeeid>101</employeeid><bsn>123456782</bsn><name>Alice Jansen</name><address><street>Dorpsstraat 1</street></address>'
    + '<footer><footerItem><key>Uren Gewerkt</key><value>160</value></footerItem><footerItem><key>Fiscaalloon</key><value>3000,00</value></footerItem></footer></payslip>'
    + '<payslip><employeeid>102</employeeid><iban>NL91ABNA0417164300</iban><footer><footerItem><key>Dagen Gewerkt</key><value>20</value></footerItem></footer></payslip>'
    + '</payslips>';

function xmlEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function soapResponse(method, innerXml) {
    return '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
        + `<${method}Response><${method}Result>${innerXml}</${method}Result></${method}Response></soap:Body></soap:Envelope>`;
}

let calls = [];
function script(responses) {
    calls = [];
    nmbrsTransport.fetch = async (url, opts) => {
        calls.push({ url, opts });
        const r = responses[calls.length - 1];
        if (r === undefined) throw new Error(`Unexpected request #${calls.length}: ${url}`);
        return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json, text: async () => r.text ?? JSON.stringify(r.json ?? {}) };
    };
}

// No real waiting: a fake clock that advances on sleep.
function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; }, slept: () => t };
}

test('the payslip XML passes an allow-list: employee id and footer totals only', () => {
    const rows = parsePayslipXml(PAYSLIP_XML);
    assert.deepStrictEqual(rows, [
        { employeeId: '101', footer: { 'Uren Gewerkt': '160', Fiscaalloon: '3000,00' } },
        { employeeId: '102', footer: { 'Dagen Gewerkt': '20' } },
    ]);
    assert.ok(!/123456782|Alice|Dorpsstraat|NL91ABNA/.test(JSON.stringify(rows)));
    assert.deepStrictEqual(parsePayslipXml('<payslips/>'), []);
    assert.throws(() => parsePayslipXml('<report><row>1</row></report>'), /unexpected format/);
    assert.throws(() => parsePayslipXml('JVBERi0xLjQK'), /unexpected format/);
});

test('polling stops at the timeout and never waits past it', async () => {
    const clock = fakeClock();
    let asked = 0;
    await assert.rejects(
        pollUntilReady(async () => { asked += 1; return { done: false }; }, { intervalMs: 2000, timeoutMs: 7000 }, clock),
        /not ready within 7s/,
    );
    assert.ok(clock.slept() <= 7000, `waited ${clock.slept()}ms`);
    assert.strictEqual(asked, 4);
    assert.strictEqual(await pollUntilReady(async () => ({ done: true, value: 'x' }), { intervalMs: 2000, timeoutMs: 1 }, clock), 'x');
});

test('the poll settings are configurable, 0 timeout means no limit, garbage falls back', () => {
    assert.deepStrictEqual(readPollConfig({}), { intervalMs: 2000, timeoutMs: 60000 });
    assert.deepStrictEqual(readPollConfig({ NMBRS_REPORT_POLL_MS: '500', NMBRS_REPORT_TIMEOUT_MS: '0' }), { intervalMs: 500, timeoutMs: 0 });
    assert.deepStrictEqual(readPollConfig({ NMBRS_REPORT_POLL_MS: '1', NMBRS_REPORT_TIMEOUT_MS: 'abc' }), { intervalMs: 250, timeoutMs: 60000 });
});

test('SOAP: run picked by period, background report polled, footer rows returned', async () => {
    assert.ok(SOAP_METHODS_READONLY.has('ReportService/Reports_GetPayslipByRunCompany_v2_Background'));
    assert.ok(SOAP_METHODS_READONLY.has('ReportService/Reports_BackgroundTask_Result'));
    script([
        { text: soapResponse('Run_GetList', '<RunInfo><ID>77</ID><Number>1</Number><Year>2026</Year><PeriodStart>1</PeriodStart><PeriodEnd>1</PeriodEnd></RunInfo><RunInfo><ID>78</ID><Number>2</Number><Year>2026</Year><PeriodStart>2</PeriodStart><PeriodEnd>3</PeriodEnd></RunInfo>') },
        { text: soapResponse('Reports_GetPayslipByRunCompany_v2_Background', TASK) },
        { text: soapResponse('Reports_BackgroundTask_Result', `<TaskId>${TASK}</TaskId><Status>Executing</Status>`) },
        { text: soapResponse('Reports_BackgroundTask_Result', `<TaskId>${TASK}</TaskId><Status>Success</Status><Content>${xmlEscape(PAYSLIP_XML)}</Content>`) },
    ]);
    process.env.NMBRS_REPORT_POLL_MS = '250';
    const r = await executeNmbrsTool('nmbrs_get_company_run_payslips', { companyId: '9', year: 2026, period: 3 }, 'soapU');
    delete process.env.NMBRS_REPORT_POLL_MS;
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.runId, '78');
    assert.deepStrictEqual(r.items.map((p) => p.employeeId), ['101', '102']);
    const actions = calls.map((c) => c.opts.headers.SOAPAction.split('/').slice(-2).join('/'));
    assert.deepStrictEqual(actions, ['CompanyService/Run_GetList', 'ReportService/Reports_GetPayslipByRunCompany_v2_Background', 'ReportService/Reports_BackgroundTask_Result', 'ReportService/Reports_BackgroundTask_Result']);
    // WSDL parameter names and order: companyId, runId, year; TaskId.
    assert.ok(calls[1].opts.body.includes('<tns:Reports_GetPayslipByRunCompany_v2_Background><tns:companyId>9</tns:companyId><tns:runId>78</tns:runId><tns:year>2026</tns:year></tns:Reports_GetPayslipByRunCompany_v2_Background>'));
    assert.ok(calls[2].opts.body.includes(`<tns:TaskId>${TASK}</tns:TaskId>`));
    assert.strictEqual(calls[1].url, 'https://api.nmbrs.nl/soap/v3/ReportService.asmx');
    assert.ok(!/123456782|Alice|NL91ABNA/.test(JSON.stringify(r)));
});

test('SOAP: an employee filter, and a later page comes from the cache (one report per read)', async () => {
    script([
        { text: soapResponse('Reports_GetPayslipByRunCompany_v2_Background', TASK) },
        { text: soapResponse('Reports_BackgroundTask_Result', `<Status>Success</Status><Content>${xmlEscape(PAYSLIP_XML)}</Content>`) },
    ]);
    const first = await executeNmbrsTool('nmbrs_get_company_run_payslips', { companyId: '9', year: 2026, runId: '78', limit: 1 }, 'soapU');
    assert.deepStrictEqual([first.total, first.hasMore, first.nextOffset], [2, true, 1]);
    const second = await executeNmbrsTool('nmbrs_get_company_run_payslips', { companyId: '9', year: 2026, runId: '78', limit: 1, offset: 1 }, 'soapU');
    assert.strictEqual(second.items[0].employeeId, '102');
    assert.strictEqual(calls.length, 2, 'the second page made no request');
    script([
        { text: soapResponse('Reports_GetPayslipByRunCompany_v2_Background', TASK) },
        { text: soapResponse('Reports_BackgroundTask_Result', `<Status>Success</Status><Content>${xmlEscape(PAYSLIP_XML)}</Content>`) },
    ]);
    const one = await executeNmbrsTool('nmbrs_get_company_run_payslips', { companyId: '9', year: 2026, runId: '78', employeeId: '102' }, 'soapU');
    assert.deepStrictEqual(one.items, [{ employeeId: '102', footer: { 'Dagen Gewerkt': '20' } }]);
});

test('SOAP: a failed report, an ambiguous period and bad input are clear errors', async () => {
    script([
        { text: soapResponse('Reports_GetPayslipByRunCompany_v2_Background', TASK) },
        { text: soapResponse('Reports_BackgroundTask_Result', '<Status>Error</Status>') },
    ]);
    const failed = await executeNmbrsTool('nmbrs_get_company_run_payslips', { companyId: '9', year: 2025, runId: '78' }, 'soapU');
    assert.match(failed.error, /could not generate/);

    script([{ text: soapResponse('Run_GetList', '<RunInfo><ID>1</ID><PeriodStart>1</PeriodStart><PeriodEnd>2</PeriodEnd></RunInfo><RunInfo><ID>2</ID><PeriodStart>2</PeriodStart><PeriodEnd>2</PeriodEnd></RunInfo>') }]);
    const several = await executeNmbrsTool('nmbrs_get_company_run_payslips', { companyId: '9', year: 2024, period: 2 }, 'soapU');
    assert.match(several.error, /Several .*runIds 1, 2/);

    for (const args of [{ companyId: '../x', year: 2026, runId: '1' }, { companyId: '9', year: 26, runId: '1' }, { companyId: '9', year: 2026 }, { companyId: '9', year: 2026, runId: 'a/b' }, { companyId: '9', year: 2026, period: 14 }]) {
        script([]);
        const r = await executeNmbrsTool('nmbrs_get_company_run_payslips', args, 'soapU');
        assert.ok(r.error, JSON.stringify(args));
        assert.strictEqual(calls.length, 0);
    }
});

test('a task id that is not a GUID is refused before polling', async () => {
    const deps = {
        creds: { mode: 'soap' },
        soapRequest: async () => 'not-a-guid',
        coerceArray: (n) => n,
        log: { info: () => {} },
        clock: fakeClock(),
        pollConfig: { intervalMs: 250, timeoutMs: 1000 },
    };
    await assert.rejects(executeRunPayslips({ companyId: '9', year: 2026, runId: '1' }, deps), /did not start/);
});

test('REST: the documented endpoints, 202 until the XML is there', async () => {
    script([
        { json: { pagination: { totalPages: 1 }, data: [{ payrollRunId: RUN_UUID, number: 1, year: 2026, periodStart: 4, periodEnd: 4 }] } },
        { json: { taskId: TASK } },
        { status: 202, text: '' },
        { status: 200, text: PAYSLIP_XML },
    ]);
    process.env.NMBRS_REPORT_POLL_MS = '250';
    const r = await executeNmbrsTool('nmbrs_get_company_run_payslips', { companyId: 'c-1', year: 2026, period: 4 }, 'restU');
    delete process.env.NMBRS_REPORT_POLL_MS;
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.runId, RUN_UUID);
    const paths = calls.map((c) => new URL(c.url).pathname);
    assert.deepStrictEqual(paths, ['/api/companies/c-1/runs', `/api/companies/c-1/runs/${RUN_UUID}/payslips`, `/api/documents/${TASK}`, `/api/documents/${TASK}`]);
    assert.strictEqual(new URL(calls[1].url).searchParams.get('year'), '2026');
    assert.ok(calls.every((c) => c.opts.method === 'GET' && c.opts.headers['X-Subscription-Key'] === 'sub-key-0123456789abcdef'));
    assert.deepStrictEqual(r.items.map((p) => p.employeeId), ['101', '102']);
});

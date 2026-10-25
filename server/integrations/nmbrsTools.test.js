/**
 * Unit tests for the NMBRS tool module.
 *
 * Run: node integrations/nmbrsTools.test.js
 *
 * No network/DB needed — `configStore` is stubbed (same trick as
 * afasTools.test.js) and `global.fetch` is scripted per case. Covers BOTH api
 * modes (soap + rest), SSRF/validation guards and error sanitization.
 */

const assert = require('assert');

// Stub configStore before requiring the module under test.
const SECRETS = {};
const configStorePath = require.resolve('../stores/configStore');
require.cache[configStorePath] = {
    id: configStorePath,
    filename: configStorePath,
    loaded: true,
    exports: {
        getSecret: async (key) => SECRETS[key] ?? null,
    },
};

const {
    executeNmbrsTool,
    isNmbrsTool,
    escapeXml,
    buildSoapUrl,
    buildRestUrl,
    buildSoapEnvelope,
    coerceArray,
    restListFrom,
    extractSoapResult,
    truncateRows,
    extractNmbrsErrorMessage,
    SUBDOMAIN_RE,
    TOKEN_RE,
    EMAIL_RE,
    SOAP_METHODS_READONLY,
} = require('./nmbrsTools');

const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2'; // 24 printable chars

function setCreds(userId, { mode = 'soap', subdomain = 'acme', email = 'me@acme.nl', token = TOKEN, env = 'production' } = {}) {
    SECRETS[`nmbrs_api_mode_user_${userId}`] = mode;
    SECRETS[`nmbrs_subdomain_user_${userId}`] = subdomain;
    SECRETS[`nmbrs_email_user_${userId}`] = email;
    SECRETS[`nmbrs_token_user_${userId}`] = token;
    SECRETS[`nmbrs_env_user_${userId}`] = env;
}
function clearCreds(userId) {
    for (const k of ['api_mode', 'subdomain', 'email', 'token', 'env']) delete SECRETS[`nmbrs_${k}_user_${userId}`];
}

// ── fetch stub ─────────────────────────────────────────────────────────
let fetchCalls = [];
function scriptFetch(responses) {
    fetchCalls = [];
    global.fetch = async (url, opts) => {
        fetchCalls.push({ url, opts });
        const r = responses[fetchCalls.length - 1];
        if (r === undefined) throw new Error(`Unexpected upstream request #${fetchCalls.length}: ${url}`);
        return {
            ok: r.ok !== false,
            status: r.status || 200,
            json: async () => r.json,
            text: async () => r.text ?? JSON.stringify(r.json ?? {}),
        };
    };
}

// Build a SOAP response envelope wrapping the given inner XML as {method}Result.
function soapResponse(method, innerXml) {
    return `<?xml version="1.0" encoding="utf-8"?>` +
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
        `<soap:Body>` +
        `<${method}Response xmlns="https://api.nmbrs.nl/soap/v3/EmployeeService">` +
        `<${method}Result>${innerXml}</${method}Result>` +
        `</${method}Response>` +
        `</soap:Body></soap:Envelope>`;
}

(async () => {
    // ── validation regexes ────────────────────────────────────────────
    for (const ok of ['acme', 'a', 'my-company', 'ABC123']) assert.ok(SUBDOMAIN_RE.test(ok), `subdomain ok: ${ok}`);
    for (const bad of ['', 'a.b', 'evil.host/', 'a/b', '-x', 'x-', 'a b', 'a;rm']) assert.ok(!SUBDOMAIN_RE.test(bad), `subdomain rejected: ${JSON.stringify(bad)}`);
    assert.ok(TOKEN_RE.test(TOKEN));
    for (const bad of ['short', 'has space here xxxxxxx', `crlf\r\ninjection${TOKEN}`, '']) assert.ok(!TOKEN_RE.test(bad), `token rejected: ${JSON.stringify(bad)}`);
    assert.ok(EMAIL_RE.test('me@acme.nl'));
    for (const bad of ['noat', 'a@', '@b', 'a b@c', 'a@b,c']) assert.ok(!EMAIL_RE.test(bad), `email rejected: ${JSON.stringify(bad)}`);

    // ── escapeXml ─────────────────────────────────────────────────────
    assert.strictEqual(escapeXml(`<a>&"'`), '&lt;a&gt;&amp;&quot;&apos;');

    // ── buildSoapUrl / buildRestUrl: host pinning + SSRF guard ─────────
    assert.strictEqual(buildSoapUrl('acme', 'EmployeeService', 'production'), 'https://api.nmbrs.nl/soap/v3/EmployeeService.asmx');
    assert.strictEqual(buildSoapUrl('acme', 'EmployeeService', 'sandbox'), 'https://api-sandbox.nmbrs.nl/soap/v3/EmployeeService.asmx');
    assert.strictEqual(buildRestUrl('acme', 'companies/9/employees', 'production'), 'https://api.nmbrsapp.com/companies/9/employees');
    assert.strictEqual(buildRestUrl('acme', 'debtors', 'sandbox'), 'https://api-sandbox.nmbrsapp.com/debtors');
    for (const bad of ['a.b', 'evil/', '']) {
        assert.throws(() => buildSoapUrl(bad, 'EmployeeService', 'production'), /subdomain/, `soap url rejects subdomain ${JSON.stringify(bad)}`);
        assert.throws(() => buildRestUrl(bad, 'debtors', 'production'), /subdomain/, `rest url rejects subdomain ${JSON.stringify(bad)}`);
    }
    assert.throws(() => buildSoapUrl('acme', 'EvilService', 'production'), /service/, 'soap url rejects unknown service');
    assert.throws(() => buildRestUrl('acme', '../secrets', 'production'), /path/, 'rest url rejects bad path');

    // ── buildSoapEnvelope ─────────────────────────────────────────────
    {
        const env = buildSoapEnvelope({ email: 'me@acme.nl', token: TOKEN, subdomain: 'acme' }, 'EmployeeService', 'Employee_GetByCompany', { CompanyId: 9 });
        assert.ok(env.includes('<tns:Username>me@acme.nl</tns:Username>'));
        assert.ok(env.includes(`<tns:Token>${TOKEN}</tns:Token>`));
        assert.ok(env.includes('<tns:Domain>acme</tns:Domain>'));
        assert.ok(env.includes('<tns:Employee_GetByCompany><tns:CompanyId>9</tns:CompanyId></tns:Employee_GetByCompany>'));
        assert.ok(env.includes('xmlns:tns="https://api.nmbrs.nl/soap/v3/EmployeeService"'));
    }

    // ── coerceArray (flat, nested, single, empty) ─────────────────────
    assert.deepStrictEqual(coerceArray({ Debtor: [{ Id: 1 }, { Id: 2 }] }), [{ Id: 1 }, { Id: 2 }]);
    assert.deepStrictEqual(coerceArray({ Debtors: { Debtor: [{ Id: 1 }] } }), [{ Id: 1 }]);
    assert.deepStrictEqual(coerceArray({ Employee: { Id: 1, Name: 'A' } }), [{ Id: 1, Name: 'A' }]);
    assert.deepStrictEqual(coerceArray(''), []);
    assert.deepStrictEqual(coerceArray(null), []);
    assert.deepStrictEqual(coerceArray([{ a: 1 }]), [{ a: 1 }]);

    // ── restListFrom ──────────────────────────────────────────────────
    assert.deepStrictEqual(restListFrom([{ a: 1 }]), [{ a: 1 }]);
    assert.deepStrictEqual(restListFrom({ data: [{ a: 1 }] }), [{ a: 1 }]);
    assert.deepStrictEqual(restListFrom({ items: [{ a: 1 }] }), [{ a: 1 }]);
    assert.deepStrictEqual(restListFrom({ id: 1 }), [{ id: 1 }]);

    // ── extractSoapResult: result + fault ─────────────────────────────
    {
        const parsed = require('fast-xml-parser');
        const { XMLParser } = parsed;
        const p = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true });
        const r = extractSoapResult(p.parse(soapResponse('Debtor_GetList', '<Debtor><Id>1</Id></Debtor>')), 'Debtor_GetList');
        assert.deepStrictEqual(coerceArray(r), [{ Id: '1' }]);
        assert.throws(() => extractSoapResult(p.parse(
            `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultstring>Geen rechten</faultstring></soap:Fault></soap:Body></soap:Envelope>`
        ), 'Debtor_GetList'), /Geen rechten/);
    }

    // ── truncateRows ──────────────────────────────────────────────────
    {
        const small = [{ a: 1 }, { a: 2 }];
        assert.deepStrictEqual(truncateRows(small, 1000), { rows: small, truncated: false });
        const big = Array.from({ length: 100 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
        const r = truncateRows(big, 2000);
        assert.strictEqual(r.truncated, true);
        assert.ok(r.rows.length > 0 && r.rows.length < 100 && JSON.stringify(r.rows).length <= 2000);
    }

    // ── extractNmbrsErrorMessage ──────────────────────────────────────
    assert.strictEqual(extractNmbrsErrorMessage('<soap:Fault><faultstring>Token ongeldig</faultstring></soap:Fault>'), 'Token ongeldig');
    assert.strictEqual(extractNmbrsErrorMessage('{"message":"Not allowed"}'), 'Not allowed');
    assert.strictEqual(extractNmbrsErrorMessage('<html><body>dump</body></html>'), null);
    assert.strictEqual(extractNmbrsErrorMessage(`<faultstring>${'x'.repeat(500)}</faultstring>`).length, 300);

    // ── not configured / null user / unknown tool ─────────────────────
    assert.deepStrictEqual(await executeNmbrsTool('nmbrs_list_debtors', {}, null), { error: 'User context required for NMBRS.' });
    assert.ok((await executeNmbrsTool('nmbrs_list_debtors', {}, 'nobody')).error.includes('not configured'));
    // SOAP without email is treated as not configured.
    setCreds('noemail', { mode: 'soap', email: '' });
    SECRETS['nmbrs_email_user_noemail'] = null;
    assert.ok((await executeNmbrsTool('nmbrs_list_debtors', {}, 'noemail')).error.includes('not configured'));
    setCreds('u1');
    assert.ok((await executeNmbrsTool('nmbrs_nope', {}, 'u1')).error.includes('Unknown NMBRS tool'));

    // ── SOAP mode: list employees ─────────────────────────────────────
    setCreds('soapU', { mode: 'soap', subdomain: 'acme', email: 'me@acme.nl', token: TOKEN, env: 'production' });
    scriptFetch([{ text: soapResponse('List_GetByCompany', '<Employee><Id>1</Id><Name>Alice</Name></Employee><Employee><Id>2</Id><Name>Bob</Name></Employee>') }]);
    {
        const r = await executeNmbrsTool('nmbrs_list_employees', { companyId: '9' }, 'soapU');
        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(fetchCalls[0].url, 'https://api.nmbrs.nl/soap/v3/EmployeeService.asmx');
        assert.strictEqual(fetchCalls[0].opts.method, 'POST');
        assert.strictEqual(fetchCalls[0].opts.redirect, 'error');
        assert.strictEqual(fetchCalls[0].opts.headers.SOAPAction, 'https://api.nmbrs.nl/soap/v3/EmployeeService/List_GetByCompany');
        const body = fetchCalls[0].opts.body;
        assert.ok(body.includes('<tns:Username>me@acme.nl</tns:Username>') && body.includes('<tns:Domain>acme</tns:Domain>'));
        assert.ok(body.includes('List_GetByCompany') && body.includes('<tns:CompanyId>9</tns:CompanyId>'));
        // Active only: Nmbrs EmployeeType 2, payroll employees in service.
        assert.ok(body.includes('<tns:EmployeeType>2</tns:EmployeeType>'));
        // Read-only: the envelope must contain no mutation verb.
        assert.ok(!/Insert|Update|Delete|Create|Set_|_Save/.test(body), 'SOAP body contains no mutation verb');
        assert.strictEqual(r.count, 2);
        assert.deepStrictEqual(r.items, [{ Id: '1', Name: 'Alice' }, { Id: '2', Name: 'Bob' }]);
    }
    // activeOnly:false asks for payroll (2) and former payroll (4) employees, de-duplicated by Id.
    scriptFetch([
        { text: soapResponse('List_GetByCompany', '<Employee><Id>1</Id></Employee><Employee><Id>3</Id></Employee>') },
        { text: soapResponse('List_GetByCompany', '<Employee><Id>3</Id></Employee><Employee><Id>4</Id></Employee>') },
    ]);
    {
        const r = await executeNmbrsTool('nmbrs_list_employees', { companyId: '9', activeOnly: false }, 'soapU');
        assert.strictEqual(fetchCalls.length, 2);
        assert.ok(fetchCalls.every((c) => c.opts.headers.SOAPAction.endsWith('EmployeeService/List_GetByCompany')));
        assert.ok(fetchCalls[0].opts.body.includes('<tns:EmployeeType>2</tns:EmployeeType>'));
        assert.ok(fetchCalls[1].opts.body.includes('<tns:EmployeeType>4</tns:EmployeeType>'));
        assert.deepStrictEqual(r.items.map((e) => e.Id), ['1', '3', '4']);
    }

    // ── SOAP mode: debtors and companies use the WSDL's List_* names ───
    scriptFetch([{ text: soapResponse('List_GetAll', '<Debtor><Id>1</Id></Debtor>') }]);
    {
        await executeNmbrsTool('nmbrs_list_debtors', {}, 'soapU');
        assert.strictEqual(fetchCalls[0].opts.headers.SOAPAction, 'https://api.nmbrs.nl/soap/v3/DebtorService/List_GetAll');
    }
    scriptFetch([{ text: soapResponse('List_GetAll', '<Company><Id>56665</Id></Company>') }]);
    {
        await executeNmbrsTool('nmbrs_list_companies', {}, 'soapU');
        assert.strictEqual(fetchCalls[0].opts.headers.SOAPAction, 'https://api.nmbrs.nl/soap/v3/CompanyService/List_GetAll');
    }
    scriptFetch([{ text: soapResponse('List_GetByDebtor', '<Company><Id>56664</Id></Company>') }]);
    {
        await executeNmbrsTool('nmbrs_list_companies', { debtorId: '1' }, 'soapU');
        assert.strictEqual(fetchCalls[0].opts.headers.SOAPAction, 'https://api.nmbrs.nl/soap/v3/CompanyService/List_GetByDebtor');
        assert.ok(fetchCalls[0].opts.body.includes('<tns:DebtorId>1</tns:DebtorId>'));
    }
    // Payslips have no per-employee SOAP call: a clear error, and no request is sent.
    scriptFetch([]);
    {
        const r = await executeNmbrsTool('nmbrs_list_payslips', { employeeId: '3', year: 2026 }, 'soapU');
        assert.ok(String(r.error).includes('REST'));
        assert.strictEqual(fetchCalls.length, 0);
    }

    // ── REST mode: same logical call, backend-agnostic result shape ───
    setCreds('restU', { mode: 'rest', subdomain: 'acme', token: TOKEN, env: 'production' });
    scriptFetch([{ json: { data: [{ Id: '1', Name: 'Alice' }, { Id: '2', Name: 'Bob' }] } }]);
    {
        const r = await executeNmbrsTool('nmbrs_list_employees', { companyId: '9' }, 'restU');
        const u = new URL(fetchCalls[0].url);
        assert.strictEqual(u.origin, 'https://api.nmbrsapp.com');
        assert.strictEqual(u.pathname, '/companies/9/employees');
        assert.strictEqual(u.searchParams.get('active'), 'true');
        assert.strictEqual(fetchCalls[0].opts.method, 'GET');
        assert.strictEqual(fetchCalls[0].opts.redirect, 'error');
        assert.strictEqual(fetchCalls[0].opts.headers.Authorization, `Bearer ${TOKEN}`);
        assert.strictEqual(fetchCalls[0].opts.headers['X-Subdomain'], 'acme');
        // Mode isolation: identical normalized shape to the SOAP call above.
        assert.deepStrictEqual(r.items, [{ Id: '1', Name: 'Alice' }, { Id: '2', Name: 'Bob' }]);
    }
    // Sandbox env hits the sandbox host.
    setCreds('restSandbox', { mode: 'rest', subdomain: 'acme', token: TOKEN, env: 'sandbox' });
    scriptFetch([{ json: [] }]);
    {
        await executeNmbrsTool('nmbrs_list_debtors', {}, 'restSandbox');
        assert.strictEqual(new URL(fetchCalls[0].url).origin, 'https://api-sandbox.nmbrsapp.com');
        assert.strictEqual(new URL(fetchCalls[0].url).pathname, '/debtors');
    }

    // ── REST companies by debtor + year/period query ──────────────────
    scriptFetch([{ json: { items: [{ Id: '5' }] } }]);
    {
        await executeNmbrsTool('nmbrs_list_companies', { debtorId: '7' }, 'restU');
        assert.strictEqual(new URL(fetchCalls[0].url).pathname, '/debtors/7/companies');
    }
    scriptFetch([{ json: [] }]);
    {
        await executeNmbrsTool('nmbrs_list_payslips', { employeeId: '3', year: 2026, period: 5 }, 'restU');
        const u = new URL(fetchCalls[0].url);
        assert.strictEqual(u.pathname, '/employees/3/payslips');
        assert.strictEqual(u.searchParams.get('year'), '2026');
        assert.strictEqual(u.searchParams.get('period'), '5');
    }

    // ── SSRF / validation guards reject bad IDs before any fetch ──────
    for (const [tool, args] of [
        ['nmbrs_list_employees', { companyId: '../x' }],
        ['nmbrs_get_employee', { employeeId: 'a/b' }],
        ['nmbrs_list_companies', { debtorId: 'a;rm' }],
        ['nmbrs_list_employee_salaries', { employeeId: 'x'.repeat(80) }],
    ]) {
        scriptFetch([]);
        const r = await executeNmbrsTool(tool, args, 'restU');
        assert.ok(r.error && /Invalid/.test(r.error), `${tool} rejects bad id: ${r.error}`);
        assert.strictEqual(fetchCalls.length, 0, `${tool} made no upstream request`);
    }
    // Bad year / period.
    scriptFetch([]);
    assert.ok((await executeNmbrsTool('nmbrs_list_payslips', { employeeId: '3', year: 99 }, 'restU')).error.includes('year'));
    assert.strictEqual(fetchCalls.length, 0);
    scriptFetch([]);
    assert.ok((await executeNmbrsTool('nmbrs_list_payslips', { employeeId: '3', year: 2026, period: 99 }, 'restU')).error.includes('period'));
    assert.strictEqual(fetchCalls.length, 0);

    // ── error mapping: no body / URL / secret leakage ─────────────────
    scriptFetch([{ ok: false, status: 401, text: '<html>secret dump https://evil acme me@acme.nl</html>' }]);
    {
        const r = await executeNmbrsTool('nmbrs_list_debtors', {}, 'restU');
        assert.ok(r.error.includes('invalid or the token was revoked'), r.error);
        assert.ok(!r.error.includes('evil') && !r.error.includes('https://'), 'raw body/URL never surfaces');
    }
    scriptFetch([{ ok: false, status: 500, text: '<soap:Fault><faultstring>Index onbekend</faultstring></soap:Fault>' }]);
    {
        const r = await executeNmbrsTool('nmbrs_list_employees', { companyId: '9' }, 'soapU');
        assert.ok(r.error.includes('server error') && r.error.includes('Index onbekend'), r.error);
    }

    // ── isNmbrsTool / read-only method allow-list ─────────────────────
    assert.ok(isNmbrsTool('nmbrs_list_debtors') && isNmbrsTool('nmbrs_get_employee'));
    assert.ok(!isNmbrsTool('nmbrs_update_employee') && !isNmbrsTool('afas_query'));
    for (const m of SOAP_METHODS_READONLY) assert.ok(/Get|List|Reports_/.test(m), `read-only method name: ${m}`);

    // ── salaries: Period and Year are required and sent (WSDL order) ───
    scriptFetch([{ text: soapResponse('Salary_GetList', '<Salary><Value>3000</Value></Salary>') }]);
    {
        const r = await executeNmbrsTool('nmbrs_list_employee_salaries', { employeeId: '3', year: 2026, period: 5 }, 'soapU');
        assert.strictEqual(fetchCalls[0].opts.headers.SOAPAction, 'https://api.nmbrs.nl/soap/v3/EmployeeService/Salary_GetList');
        assert.ok(fetchCalls[0].opts.body.includes('<tns:Salary_GetList><tns:EmployeeId>3</tns:EmployeeId><tns:Period>5</tns:Period><tns:Year>2026</tns:Year></tns:Salary_GetList>'));
        assert.deepStrictEqual(r.items, [{ Value: '3000' }]);
    }
    for (const args of [{ employeeId: '3', year: 2026 }, { employeeId: '3', period: 5 }, { employeeId: '3', year: 2026, period: 14 }, { employeeId: '3', year: 99, period: 5 }]) {
        scriptFetch([]);
        const r = await executeNmbrsTool('nmbrs_list_employee_salaries', args, 'soapU');
        assert.ok(/Invalid (year|period)/.test(r.error), `salaries validation: ${JSON.stringify(args)} -> ${r.error}`);
        assert.strictEqual(fetchCalls.length, 0);
    }
    // Wage components over SOAP: period required, WSDL order Period then Year.
    scriptFetch([{ text: soapResponse('WageComponentFixed_Get', '') }, { text: soapResponse('WageComponentVar_Get', '') }]);
    {
        await executeNmbrsTool('nmbrs_list_employee_wage_components', { employeeId: '3', year: 2026, period: 5 }, 'soapU');
        assert.ok(fetchCalls[0].opts.body.includes('<tns:EmployeeId>3</tns:EmployeeId><tns:Period>5</tns:Period><tns:Year>2026</tns:Year>'));
    }
    scriptFetch([]);
    assert.ok((await executeNmbrsTool('nmbrs_list_employee_wage_components', { employeeId: '3', year: 2026 }, 'soapU')).error.includes('period'));
    assert.strictEqual(fetchCalls.length, 0);

    // ── bulk per-company tools: SOAPAction, parameter casing and order ──
    const BULK_CASES = [
        ['nmbrs_list_company_employments', {}, 'EmployeeService', 'Employment_GetAll_AllEmployeesByCompany', '<tns:CompanyID>9</tns:CompanyID>'],
        ['nmbrs_list_company_lease_cars', { year: 2026, period: 3 }, 'EmployeeService', 'LeaseCar_GetAll_EmployeesByCompany', '<tns:CompanyId>9</tns:CompanyId><tns:Period>3</tns:Period><tns:Year>2026</tns:Year>'],
        ['nmbrs_list_company_svw_settings', {}, 'EmployeeService', 'SVW_GetAll_AllEmployeesByCompany', '<tns:CompanyID>9</tns:CompanyID>'],
        ['nmbrs_list_company_runs', { year: 2026 }, 'CompanyService', 'Run_GetList', '<tns:CompanyId>9</tns:CompanyId><tns:Year>2026</tns:Year>'],
        ['nmbrs_list_company_personal_info', {}, 'EmployeeService', 'PersonalInfoContractSalaryAddress_GetAll_AllEmployeesByCompany', '<tns:CompanyID>9</tns:CompanyID>'],
        ['nmbrs_list_company_contracts', {}, 'EmployeeService', 'Contract_GetAll_AllEmployeesByCompany', '<tns:CompanyID>9</tns:CompanyID>'],
    ];
    for (const [tool, extra, service, method, params] of BULK_CASES) {
        assert.ok(isNmbrsTool(tool) && SOAP_METHODS_READONLY.has(`${service}/${method}`), `${tool} registered and allow-listed`);
        scriptFetch([{ text: soapResponse(method, '<Item><Id>1</Id></Item><Item><Id>2</Id></Item>') }]);
        const r = await executeNmbrsTool(tool, { companyId: '9', ...extra }, 'soapU');
        assert.strictEqual(fetchCalls[0].opts.headers.SOAPAction, `https://api.nmbrs.nl/soap/v3/${service}/${method}`, tool);
        assert.strictEqual(fetchCalls[0].url, `https://api.nmbrs.nl/soap/v3/${service}.asmx`);
        assert.ok(fetchCalls[0].opts.body.includes(`<tns:${method}>${params}</tns:${method}>`), `${tool} envelope: ${fetchCalls[0].opts.body}`);
        assert.ok(r.total === 2 && r.count === 2 && r.hasMore === false && r.nextOffset === null, tool);
        // Validation: bad company id, missing year/period, bad paging: no request.
        for (const bad of [{ companyId: '../x' }, { offset: -1 }, { limit: 0 }, { limit: 501 }, { offset: 'abc' }]) {
            scriptFetch([]);
            const e = await executeNmbrsTool(tool, { companyId: '9', ...extra, ...bad }, 'soapU');
            assert.ok(/Invalid/.test(e.error), `${tool} ${JSON.stringify(bad)}: ${e.error}`);
            assert.strictEqual(fetchCalls.length, 0);
        }
        if (extra.year) {
            scriptFetch([]);
            assert.ok((await executeNmbrsTool(tool, { companyId: '9', period: 3 }, 'soapU')).error.includes('year'));
            assert.strictEqual(fetchCalls.length, 0);
        }
        if (extra.period) {
            scriptFetch([]);
            assert.ok((await executeNmbrsTool(tool, { companyId: '9', year: 2026 }, 'soapU')).error.includes('period'));
            assert.strictEqual(fetchCalls.length, 0);
        }
        // REST mode: a clear message and no request.
        scriptFetch([]);
        const rest = await executeNmbrsTool(tool, { companyId: '9', ...extra }, 'restU');
        assert.ok(/SOAP API/.test(rest.error), rest.error);
        assert.strictEqual(fetchCalls.length, 0);
    }

    // Nested SOAP shape (one item per employee with a nested list) comes through.
    scriptFetch([{ text: soapResponse('Employment_GetAll_AllEmployeesByCompany',
        '<EmployeeEmploymentItem><EmployeeId>1</EmployeeId><EmployeeEmployments><Employment><EmploymentId>7</EmploymentId><InitialStartDate>2019-02-01T00:00:00</InitialStartDate></Employment></EmployeeEmployments></EmployeeEmploymentItem>') }]);
    {
        const r = await executeNmbrsTool('nmbrs_list_company_employments', { companyId: '9' }, 'soapU');
        assert.strictEqual(r.items[0].EmployeeId, '1');
        assert.strictEqual(r.items[0].EmployeeEmployments.Employment.InitialStartDate, '2019-02-01T00:00:00');
    }

    // ── privacy: BSN, address and private contact never leave the bulk personal-info tool ──
    scriptFetch([{ text: soapResponse('PersonalInfoContractSalaryAddress_GetAll_AllEmployeesByCompany',
        '<PersonalInfoContractSalaryAddress><EmployeeID>1</EmployeeID><FirstName>Alice</FirstName><LastName>Jansen</LastName><BSN>123456782</BSN><Street>Dorpsstraat</Street><HouseNumber>1</HouseNumber><City>Gouda</City><EmailPrivate>a@home.nl</EmailPrivate><TelephonePrivate>0612345678</TelephonePrivate><SalaryValue>3000</SalaryValue><ContractStartDate>2024-01-01T00:00:00</ContractStartDate></PersonalInfoContractSalaryAddress>') }]);
    {
        const r = await executeNmbrsTool('nmbrs_list_company_personal_info', { companyId: '9' }, 'soapU');
        assert.deepStrictEqual(r.items, [{ EmployeeID: '1', FirstName: 'Alice', LastName: 'Jansen', ContractStartDate: '2024-01-01T00:00:00', SalaryValue: '3000' }]);
        const flat = JSON.stringify(r);
        for (const leak of ['123456782', 'Dorpsstraat', 'Gouda', 'a@home.nl', '0612345678']) assert.ok(!flat.includes(leak), `${leak} must not leak`);
    }
    // Row contents are never logged.
    {
        const logged = [];
        const logPath = require.resolve('../telemetry/log');
        const log = require(logPath);
        const saved = {};
        for (const k of ['info', 'warn', 'error', 'debug']) { saved[k] = log[k]; log[k] = (...a) => logged.push(a.join(' ')); }
        scriptFetch([{ text: soapResponse('Contract_GetAll_AllEmployeesByCompany', '<EmployeeContractItemGlobal><EmployeeId>1</EmployeeId><Secret>TOPSECRETROW</Secret></EmployeeContractItemGlobal>') }]);
        await executeNmbrsTool('nmbrs_list_company_contracts', { companyId: '9' }, 'soapU');
        for (const k of Object.keys(saved)) log[k] = saved[k];
        assert.ok(logged.length > 0 && !logged.join('\n').includes('TOPSECRETROW'), 'row contents are not logged');
    }

    // ── paging: employees page by page, nextOffset / hasMore ───────────
    {
        const xml = Array.from({ length: 5 }, (_, i) => `<Employee><Id>${i + 1}</Id></Employee>`).join('');
        scriptFetch([{ text: soapResponse('List_GetByCompany', xml) }]);
        const p1 = await executeNmbrsTool('nmbrs_list_employees', { companyId: '9', limit: 2 }, 'soapU');
        assert.deepStrictEqual(p1.items.map((e) => e.Id), ['1', '2']);
        assert.deepStrictEqual([p1.total, p1.offset, p1.hasMore, p1.nextOffset], [5, 0, true, 2]);
        scriptFetch([{ text: soapResponse('List_GetByCompany', xml) }]);
        const p3 = await executeNmbrsTool('nmbrs_list_employees', { companyId: '9', limit: 2, offset: 4 }, 'soapU');
        assert.deepStrictEqual(p3.items.map((e) => e.Id), ['5']);
        assert.deepStrictEqual([p3.hasMore, p3.nextOffset], [false, null]);
        scriptFetch([{ text: soapResponse('List_GetByCompany', xml) }]);
        const past = await executeNmbrsTool('nmbrs_list_employees', { companyId: '9', offset: 50 }, 'soapU');
        assert.deepStrictEqual([past.items.length, past.hasMore, past.nextOffset], [0, false, null]);
        scriptFetch([]);
        assert.ok((await executeNmbrsTool('nmbrs_list_employees', { companyId: '9', limit: 9999 }, 'soapU')).error.includes('limit'));
    }
    // A page is always cut to fit under the size cap, and continuing reads everything.
    {
        const pad = 'x'.repeat(1000);
        const xml = Array.from({ length: 200 }, (_, i) => `<Employee><Id>${i + 1}</Id><Pad>${pad}</Pad></Employee>`).join('');
        const seen = [];
        let offset = 0;
        for (let guard = 0; guard < 20; guard++) {
            scriptFetch([{ text: soapResponse('List_GetByCompany', xml) }]);
            const page = await executeNmbrsTool('nmbrs_list_employees', { companyId: '9', limit: 500, offset }, 'soapU');
            assert.ok(JSON.stringify(page.items).length <= 30000, 'page under the cap');
            assert.ok(page.items.length > 0 && page.items.length < 500);
            seen.push(...page.items.map((e) => e.Id));
            if (!page.hasMore) break;
            assert.strictEqual(page.truncated, true);
            offset = page.nextOffset;
        }
        assert.strictEqual(seen.length, 200, 'every record is reachable page by page');
        assert.strictEqual(new Set(seen).size, 200);
    }

    // ── nmbrs_get_employee: an allow-list, never the raw record (#349) ──
    scriptFetch([{ text: soapResponse('PersonalInfo_GetCurrent', [
        '<EmployeeNumber>42</EmployeeNumber><BSN>123456782</BSN><FirstName>Alice</FirstName><LastName>Jansen</LastName>',
        '<Gender>female</Gender><Birthday>1990-01-02</Birthday><EmailPrivate>alice@home.nl</EmailPrivate>',
        '<TelephonePrivate>0612345678</TelephonePrivate><EmailWork>alice@work.nl</EmailWork><IdentificationNumber>NX1234</IdentificationNumber>',
        '<InCaseOfEmergency>Bob</InCaseOfEmergency><PartnerLastName>Pietersen</PartnerLastName>',
    ].join('')) }]);
    {
        const r = await executeNmbrsTool('nmbrs_get_employee', { employeeId: '7' }, 'soapU');
        assert.deepStrictEqual(r.employee, {
            EmployeeNumber: '42', FirstName: 'Alice', LastName: 'Jansen', Gender: 'female', Birthday: '1990-01-02', EmailWork: 'alice@work.nl',
        });
        const text = JSON.stringify(r);
        for (const leak of ['123456782', 'alice@home.nl', '0612345678', 'NX1234', 'Bob', 'Pietersen']) assert.ok(!text.includes(leak), `${leak} must not reach the model`);
    }
    // REST nests and camel-cases: the same allow-list applies at any depth.
    scriptFetch([{ json: { employeeId: '7', bsn: '123456782', basicInfo: { firstName: 'Alice', lastName: 'Jansen', privateEmail: 'alice@home.nl' }, address: { street: 'Dorpsstraat', city: 'Utrecht' } } }]);
    {
        const r = await executeNmbrsTool('nmbrs_get_employee', { employeeId: '7' }, 'restU');
        assert.deepStrictEqual(r.employee, { EmployeeId: '7', FirstName: 'Alice', LastName: 'Jansen' });
        assert.ok(!/123456782|Dorpsstraat|Utrecht|alice@home/.test(JSON.stringify(r)));
    }

    clearCreds('noemail');
    console.log('nmbrsTools.test.js: all tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

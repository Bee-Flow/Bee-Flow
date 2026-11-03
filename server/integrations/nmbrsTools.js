// @typecheck noImplicitAny
/**
 * NMBRS Tools — Built-in READ-ONLY tools for AI to read NMBRS (Visma Nmbrs)
 * payroll/HR data: debtors, companies, employees, contracts, salaries, wage
 * components and payslip summaries.
 *
 * NMBRS exposes two APIs and a connection may use either:
 *   - SOAP   (legacy; Visma discontinues it 2027-03-01): AuthHeaderWithDomain
 *            with Username (login email) + Token + Domain (subdomain). Services
 *            live at https://api.nmbrs.nl/soap/v3/<Service>.asmx.
 *   - REST   (modern): OAuth 2.0 (authorisation code + PKCE, nmbrsOAuth.mts)
 *            against https://api.nmbrsapp.com/api/..., with the X-Subscription-Key
 *            header on every call (nmbrsRest.mts cites the documentation per fact).
 *
 * The tool surface is identical regardless of backend — each handler calls a
 * backend-agnostic per-entity fetcher that branches on the configured api mode.
 *
 * READ-ONLY BY CONSTRUCTION: only read tools exist, the REST path hard-codes
 * GET, and the SOAP path only emits methods in SOAP_METHODS_READONLY (all
 * *_Get*). There is no mutation code path anywhere in this module.
 *
 * Transport, timeouts, redirect refusal and leak-free error messages live in
 * nmbrsTransport.mts (every call goes through the SSRF-guarded safeFetch).
 * SOAP XML is parsed with fast-xml-parser (already a dependency).
 */

const configStore = require('../stores/configStore');
const { XMLParser } = require('fast-xml-parser');
const log = require('../telemetry/log');
const { nmbrsFetch, safeText, mapNmbrsError, extractNmbrsErrorMessage, soapFaultMessage } = require('./nmbrsTransport.mts');
const rest = require('./nmbrsRest.mts');
const { accessTokenFor, subscriptionKeyFor } = require('./nmbrsOAuth.mts');
const { RUN_PAYSLIPS_TOOL, RUN_PAYSLIPS_TOOL_DEF, executeRunPayslips } = require('./nmbrsPayslips.mts');

// Environment → SOAP host. A fixed map: the env value never reaches the hostname.
// The REST API has one documented host and no sandbox host (nmbrsRest.mts).
const SOAP_HOST = { production: 'api.nmbrs.nl', sandbox: 'api-sandbox.nmbrs.nl' };

// SOAP XML namespace base. Per-service namespace is `${SOAP_NS_BASE}/${service}`
// (also used to build the SOAPAction). This is a fixed identifier, independent
// of the request host (so it stays api.nmbrs.nl even for sandbox).
const SOAP_NS_BASE = 'https://api.nmbrs.nl/soap/v3';

const SOAP_SERVICES = new Set(['DebtorService', 'CompanyService', 'EmployeeService', 'ReportService']);

const { NMBRS_TOOLS: BASE_TOOLS } = require('./nmbrsToolDefs');
const { NMBRS_BULK_TOOLS, isBulkTool, executeBulkTool, pickFieldsDeep, EMPLOYEE_FIELDS } = require('./nmbrsBulkTools');
const { truncateRows, shapeList, parsePaging, shapePage } = require('./nmbrsPaging');
const { cachedRowsFor, clearNmbrsPageCacheForUser } = require('./nmbrsPageCacheBinding');
const { validId, parseYear, parsePeriod } = require('./nmbrsArgs');

const NMBRS_TOOLS = [...BASE_TOOLS, ...NMBRS_BULK_TOOLS, RUN_PAYSLIPS_TOOL_DEF];

const { SOAP_METHODS_READONLY, EMPLOYEE_TYPE_PAYROLL, EMPLOYEE_TYPE_FORMER_PAYROLL } = require('./nmbrsSoapMethods');

// Validation regexes. These are the load-bearing input guards.
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i; // single DNS label, no dots/slashes
const TOKEN_RE = /^[\x21-\x7E]{16,512}$/;                     // printable ASCII, no whitespace/CRLF
const EMAIL_RE = /^[^\s@,;]{1,128}@[^\s@,;]{1,128}$/;

const xmlParser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
});


// ─── Pure helpers (exported for tests) ─────────────────────────

/**
 * @typedef {{ mode: 'soap' | 'rest', subdomain: string, email: string, token: string, env: string, subscriptionKey?: string }} NmbrsCreds
 * A parsed SOAP answer (fast-xml-parser, namespace prefixes removed); only the parts read here.
 * @typedef {{ Envelope?: { Body?: { Fault?: { faultstring?: string, Reason?: { Text?: string } },
 *   [element: string]: unknown } } }} SoapEnvelope
 */

/** @param {unknown} value */
function escapeXml(value) {
    return String(value).replace(/[&<>"']/g, (c) => (
        /** @type {Record<string, string>} */
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
    ));
}

/** @param {unknown} env */
function resolveEnv(env) {
    return String(env || 'production').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
}

/**
 * Build a SOAP service endpoint. The subdomain is validated here (it travels in
 * the SOAP Domain header, not the host) and `service` must be allow-listed —
 * together these are the SSRF guard.
 * @param {string} subdomain
 * @param {string} service
 * @param {string} env
 */
function buildSoapUrl(subdomain, service, env) {
    if (!SUBDOMAIN_RE.test(String(subdomain || '').trim())) {
        throw new Error('Invalid NMBRS subdomain.');
    }
    if (!SOAP_SERVICES.has(service)) {
        throw new Error('Unknown NMBRS service.');
    }
    const host = SOAP_HOST[resolveEnv(env)];
    return `https://${host}/soap/v3/${service}.asmx`;
}

/**
 * Coerce a parsed SOAP result node into an array of rows. NMBRS serializes a
 * list either flat under the Result element ({ Debtor: [..] }) or behind one
 * typed wrapper ({ Debtors: { Debtor: [..] } }); a single row collapses to an
 * object ({ Employee: {..} }). Unwrap single-key wrappers until we reach the
 * rows, but never unwrap a multi-field row object (a real entity).
 * @param {unknown} node
 * @returns {unknown[]}
 */
function coerceArray(node) {
    if (node == null || node === '') return [];
    if (Array.isArray(node)) return node;
    if (typeof node !== 'object') return [];
    const keys = Object.keys(node);
    if (keys.length !== 1) return [node];
    const inner = /** @type {Record<string, unknown>} */ (node)[keys[0]];
    if (Array.isArray(inner)) return inner;
    if (inner && typeof inner === 'object') {
        // Single-key wrapper around another single-key list/wrapper → keep
        // unwrapping. Otherwise `inner` is the (single) row itself.
        const innerKeys = Object.keys(inner);
        if (innerKeys.length === 1) {
            const deep = /** @type {Record<string, unknown>} */ (inner)[innerKeys[0]];
            if (Array.isArray(deep) || (deep && typeof deep === 'object')) {
                return coerceArray(inner);
            }
        }
        return [inner];
    }
    return [];
}

/**
 * Navigate Envelope→Body→{method}Response→{method}Result, throwing on a SOAP
 * Fault (NMBRS may return a Fault with HTTP 200).
 * @param {SoapEnvelope} parsed
 * @param {string} method
 * @returns {unknown}
 */
function extractSoapResult(parsed, method) {
    const env = parsed && parsed.Envelope;
    const body = env && env.Body;
    if (!body || typeof body !== 'object') {
        throw mapNmbrsError(502, 'NMBRS returned a malformed SOAP response.');
    }
    if (body.Fault) {
        const f = body.Fault;
        throw new Error(`NMBRS rejected the request: ${soapFaultMessage(f.faultstring || (f.Reason && f.Reason.Text) || 'SOAP fault')}`);
    }
    const resp = body[`${method}Response`];
    if (resp == null) return null;
    if (typeof resp === 'object' && Object.prototype.hasOwnProperty.call(resp, `${method}Result`)) {
        return /** @type {Record<string, unknown>} */ (resp)[`${method}Result`];
    }
    return resp;
}

// ─── Transport ─────────────────────────────────────────────────

/**
 * @param {NmbrsCreds} creds
 * @param {string} service
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 */
function buildSoapEnvelope(creds, service, method, params) {
    const ns = `${SOAP_NS_BASE}/${service}`;
    const inner = Object.entries(params || {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `<tns:${k}>${escapeXml(v)}</tns:${k}>`)
        .join('');
    return `<?xml version="1.0" encoding="utf-8"?>` +
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${ns}">` +
        `<soap:Header>` +
        `<tns:AuthHeaderWithDomain>` +
        `<tns:Username>${escapeXml(creds.email)}</tns:Username>` +
        `<tns:Token>${escapeXml(creds.token)}</tns:Token>` +
        `<tns:Domain>${escapeXml(creds.subdomain)}</tns:Domain>` +
        `</tns:AuthHeaderWithDomain>` +
        `</soap:Header>` +
        `<soap:Body><tns:${method}>${inner}</tns:${method}></soap:Body>` +
        `</soap:Envelope>`;
}

/**
 * SOAP request — only read methods (SOAP_METHODS_READONLY) may be issued.
 * @param {NmbrsCreds} creds
 * @param {string} service
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 */
async function soapRequest(creds, service, method, params = {}) {
    if (!SOAP_METHODS_READONLY.has(`${service}/${method}`)) {
        throw new Error('Refused: non-read NMBRS method.');
    }
    const url = buildSoapUrl(creds.subdomain, service, creds.env);
    const response = await nmbrsFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': `${SOAP_NS_BASE}/${service}/${method}`,
        },
        body: buildSoapEnvelope(creds, service, method, params),
    });
    const text = await safeText(response);
    if (!response.ok) throw mapNmbrsError(response.status, text);
    let parsed;
    try {
        parsed = xmlParser.parse(text);
    } catch {
        throw new Error('NMBRS returned an unexpected non-XML response.');
    }
    return extractSoapResult(parsed, method);
}

// ─── Backend-agnostic entity fetchers ──────────────────────────
// Each returns an array of rows (or a single object for get_employee). The
// model never sees mode/service/path/method. REST paths come from nmbrsRest.mts.

/** @param {NmbrsCreds} creds */
function restCreds(creds) {
    return { token: creds.token, subscriptionKey: creds.subscriptionKey || '' };
}

/** @param {NmbrsCreds} creds */
async function fetchDebtors(creds) {
    if (creds.mode === 'rest') return rest.restGetAll(restCreds(creds), rest.restPaths.debtors());
    return coerceArray(await soapRequest(creds, 'DebtorService', 'List_GetAll'));
}

/** @param {NmbrsCreds} creds @param {string|null} debtorId */
async function fetchCompanies(creds, debtorId) {
    if (creds.mode === 'rest') {
        return rest.restGetAll(restCreds(creds), debtorId ? rest.restPaths.companiesByDebtor(debtorId) : rest.restPaths.companies());
    }
    if (debtorId) {
        return coerceArray(await soapRequest(creds, 'CompanyService', 'List_GetByDebtor', { DebtorId: debtorId }));
    }
    return coerceArray(await soapRequest(creds, 'CompanyService', 'List_GetAll'));
}

/** @param {NmbrsCreds} creds @param {string} companyId @param {boolean} activeOnly */
async function fetchEmployees(creds, companyId, activeOnly) {
    if (creds.mode === 'rest') {
        return rest.restGetAll(restCreds(creds), rest.restPaths.employees(companyId), { employeeType: rest.employeeTypes(activeOnly) });
    }
    const types = activeOnly ? [EMPLOYEE_TYPE_PAYROLL] : [EMPLOYEE_TYPE_PAYROLL, EMPLOYEE_TYPE_FORMER_PAYROLL];
    /** @type {unknown[]} */
    const rows = [];
    const seen = new Set();
    for (const EmployeeType of types) {
        const page = coerceArray(await soapRequest(creds, 'EmployeeService', 'List_GetByCompany', { CompanyId: companyId, EmployeeType }));
        for (const row of page) {
            const id = row && /** @type {Record<string, unknown>} */ (row).Id;
            if (id != null && seen.has(String(id))) continue;
            if (id != null) seen.add(String(id));
            rows.push(row);
        }
    }
    return rows;
}

/** @param {NmbrsCreds} creds @param {string} employeeId */
async function fetchEmployee(creds, employeeId) {
    if (creds.mode === 'rest') return rest.restGetOne(restCreds(creds), rest.restPaths.employee(employeeId));
    return await soapRequest(creds, 'EmployeeService', 'PersonalInfo_GetCurrent', { EmployeeId: employeeId });
}

/** @param {NmbrsCreds} creds @param {string} employeeId @param {string} companyId */
async function fetchContracts(creds, employeeId, companyId) {
    if (creds.mode === 'rest') return rest.companyEmployeeRows(restCreds(creds), companyId, 'contracts', { employeeId });
    return coerceArray(await soapRequest(creds, 'EmployeeService', 'Contract_GetAll', { EmployeeId: employeeId }));
}

/** @param {NmbrsCreds} creds @param {string} employeeId @param {number} year @param {number} period @param {string} companyId */
async function fetchSalaries(creds, employeeId, year, period, companyId) {
    // REST answers the salary history of the employee (no year/period filter documented).
    if (creds.mode === 'rest') return rest.companyEmployeeRows(restCreds(creds), companyId, 'salaries', { employeeId });
    // Salary_GetList needs Period and Year (WSDL order: EmployeeId, Period, Year).
    return coerceArray(await soapRequest(creds, 'EmployeeService', 'Salary_GetList', { EmployeeId: employeeId, Period: period, Year: year }));
}

/**
 * Fixed and variable wage components of one employee in one year + period. REST takes
 * year and period together (both or neither), so both are required on either API.
 * @param {NmbrsCreds} creds @param {string} employeeId @param {number} year @param {number} period @param {string} companyId
 */
async function fetchWageComponents(creds, employeeId, year, period, companyId) {
    let fixed;
    let variable;
    if (creds.mode === 'rest') {
        const filter = { employeeId, year, period };
        fixed = await rest.companyEmployeeRows(restCreds(creds), companyId, 'fixedWageComponents', filter);
        variable = await rest.companyEmployeeRows(restCreds(creds), companyId, 'variablewagecomponents', filter);
    } else {
        /** @type {Record<string, unknown>} */
        const params = { EmployeeId: employeeId, Period: period, Year: year };
        fixed = coerceArray(await soapRequest(creds, 'EmployeeService', 'WageComponentFixed_Get', params));
        variable = coerceArray(await soapRequest(creds, 'EmployeeService', 'WageComponentVar_Get', params));
    }
    return [
        ...fixed.map((c) => ({ kind: 'fixed', .../** @type {Record<string, unknown>} */ (c) })),
        ...variable.map((c) => ({ kind: 'variable', .../** @type {Record<string, unknown>} */ (c) })),
    ];
}

// ─── Credentials & execution ───────────────────────────────────

/**
 * The connection of `userId`: null when it is not configured, `{ error }` when the
 * REST connection needs the user (not connected yet, expired, revoked).
 * @param {string} userId
 * @returns {Promise<NmbrsCreds | { error: string } | null>}
 */
async function getNmbrsCredentials(userId) {
    const mode = (await configStore.getSecret(`nmbrs_api_mode_user_${userId}`)) === 'rest' ? 'rest' : 'soap';
    if (mode === 'rest') {
        const subscriptionKey = await subscriptionKeyFor(userId);
        if (!subscriptionKey) return null;
        const access = await accessTokenFor(userId);
        if ('error' in access) return { error: access.error };
        return { mode, subdomain: '', email: '', env: 'production', token: access.token, subscriptionKey };
    }
    const subdomain = await configStore.getSecret(`nmbrs_subdomain_user_${userId}`);
    const token = await configStore.getSecret(`nmbrs_token_user_${userId}`);
    const email = await configStore.getSecret(`nmbrs_email_user_${userId}`);
    const env = resolveEnv(await configStore.getSecret(`nmbrs_env_user_${userId}`));
    if (!subdomain || !token || !email) return null; // SOAP needs Username + Token + Domain
    return { mode, subdomain: String(subdomain).trim(), token, email, env };
}

const BAD_EMPLOYEE = 'Invalid employeeId. Use an ID from nmbrs_list_employees.';
const BAD_YEAR = 'Invalid year. Provide a 4-digit calendar year, e.g. 2026.';

/**
 * The employee (and, over REST, the company) of a per-employee tool. REST reads
 * employee data per company, so it needs the companyId as well.
 * @param {Record<string, any>} args @param {NmbrsCreds} creds
 * @returns {{ employeeId: string, companyId: string } | { error: string }}
 */
function employeeArgs(args, creds) {
    const employeeId = String(args.employeeId || '').trim();
    if (!validId(employeeId)) return { error: BAD_EMPLOYEE };
    const companyId = String(args.companyId || '').trim();
    if (creds.mode === 'rest' && !validId(companyId)) return { error: 'Over the NMBRS REST API this needs the companyId too (from nmbrs_list_companies).' };
    return { employeeId, companyId };
}

/**
 * @param {string} toolName
 * @param {Record<string, any>} args tool arguments as the model sent them
 * @param {string} userId
 * @param {{ orgId?: string | null }} [context]
 */
async function executeNmbrsTool(toolName, args = {}, userId, context = {}) {
    if (!userId) return { error: 'User context required for NMBRS.' };
    const found = await getNmbrsCredentials(userId);
    if (!found) {
        return { error: 'NMBRS not configured. Add the connection in Settings → Integrations (subdomain, login email and token for SOAP; subscription key and OAuth app for REST).' };
    }
    if ('error' in found) return { error: found.error };
    const creds = found;

    try {
        switch (toolName) {
            case 'nmbrs_list_debtors': {
                log.info('[NMBRS] Listing debtors');
                return shapeList(await fetchDebtors(creds), 'debtors');
            }
            case 'nmbrs_list_companies': {
                const debtorId = args.debtorId != null ? String(args.debtorId).trim() : '';
                if (debtorId && !validId(debtorId)) return { error: 'Invalid debtorId.' };
                log.info(`[NMBRS] Listing companies${debtorId ? ` for debtor ${debtorId}` : ''}`);
                return shapeList(await fetchCompanies(creds, debtorId || null), 'companies');
            }
            case 'nmbrs_list_employees': {
                const companyId = String(args.companyId || '').trim();
                if (!validId(companyId)) return { error: 'Invalid companyId. Use an ID from nmbrs_list_companies.' };
                const activeOnly = args.activeOnly !== false;
                log.info(`[NMBRS] Listing employees for company ${companyId} (activeOnly=${activeOnly})`);
                const paging = parsePaging(args);
                if ('error' in paging) return { error: paging.error };
                const employees = await cachedRowsFor(creds, userId, context.orgId)({ tool: toolName, companyId, args: { activeOnly }, fetchRows: () => fetchEmployees(creds, companyId, activeOnly), fresh: paging.offset === 0 });
                return shapePage(employees, paging, 'employees');
            }
            case 'nmbrs_get_employee': {
                const employeeId = String(args.employeeId || '').trim();
                if (!validId(employeeId)) return { error: BAD_EMPLOYEE };
                log.info(`[NMBRS] Getting employee ${employeeId}`);
                const employee = await fetchEmployee(creds, employeeId);
                return { employee: employee ? pickFieldsDeep(employee, EMPLOYEE_FIELDS) : null }; // allow-list: no BSN, address, private contacts
            }
            case 'nmbrs_list_employee_contracts': {
                const who = employeeArgs(args, creds);
                if ('error' in who) return { error: who.error };
                log.info(`[NMBRS] Listing contracts for employee ${who.employeeId}`);
                return shapeList(await fetchContracts(creds, who.employeeId, who.companyId), 'contracts');
            }
            case 'nmbrs_list_employee_salaries': {
                const who = employeeArgs(args, creds);
                if ('error' in who) return { error: who.error };
                const year = parseYear(args.year);
                if (!year) return { error: BAD_YEAR };
                const period = parsePeriod(args.period);
                if (!period || period === 'invalid') return { error: 'Invalid period. NMBRS needs a period (month) from 1 to 13.' };
                log.info(`[NMBRS] Listing salaries for employee ${who.employeeId} (${year}/${period})`);
                return shapeList(await fetchSalaries(creds, who.employeeId, year, period, who.companyId), 'salaries');
            }
            case 'nmbrs_list_employee_wage_components': {
                const who = employeeArgs(args, creds);
                if ('error' in who) return { error: who.error };
                const year = parseYear(args.year);
                if (!year) return { error: BAD_YEAR };
                const period = parsePeriod(args.period);
                if (!period || period === 'invalid') return { error: 'Invalid period. NMBRS needs a period (month) from 1 to 13.' };
                log.info(`[NMBRS] Listing wage components for employee ${who.employeeId} (${year}/${period})`);
                return shapeList(await fetchWageComponents(creds, who.employeeId, year, period, who.companyId), 'wage components');
            }
            case 'nmbrs_list_payslips': {
                const employeeId = String(args.employeeId || '').trim();
                if (!validId(employeeId)) return { error: BAD_EMPLOYEE };
                // Neither API has per-employee payslip summaries: SOAP has none, REST only a
                // PDF per employee. Both have the payslips of a run, as XML.
                return { error: `Payslips per employee are not available from NMBRS. Use ${RUN_PAYSLIPS_TOOL} with the company, the year, the run (or period) and this employeeId.` };
            }
            case RUN_PAYSLIPS_TOOL:
                return await executeRunPayslips(args, { creds, restCreds: creds.mode === 'rest' ? restCreds(creds) : null, soapRequest, coerceArray, log, cachedRows: cachedRowsFor(creds, userId, context.orgId) });
            default:
                if (isBulkTool(toolName)) {
                    return await executeBulkTool(toolName, args, creds, { soapRequest, coerceArray, validId, parseYear, parsePeriod, log, cachedRows: cachedRowsFor(creds, userId, context.orgId), restRows: (list, companyId, filter) => rest.companyEmployeeRows(restCreds(creds), companyId, list, filter), restRuns: (companyId, year) => rest.restGetAll(restCreds(creds), rest.restPaths.runs(companyId), { year: String(year) }) });
                }
                return { error: `Unknown NMBRS tool: ${toolName}` };
        }
    } catch (err) {
        log.warn(`[NMBRS] ${toolName} failed: ${err.message}`);
        return { error: `NMBRS: ${err.message}` };
    }
}

/** @param {string} toolName */
function isNmbrsTool(toolName) {
    return NMBRS_TOOLS.some((t) => t.function.name === toolName);
}

module.exports = {
    NMBRS_TOOLS,
    executeNmbrsTool,
    isNmbrsTool,
    getNmbrsCredentials,
    clearNmbrsPageCacheForUser,
    // Pure helpers exported for unit tests.
    escapeXml,
    buildSoapUrl,
    buildSoapEnvelope,
    coerceArray,
    extractSoapResult,
    truncateRows,
    extractNmbrsErrorMessage,
    // Validation surfaces / constants for tests.
    SUBDOMAIN_RE,
    TOKEN_RE,
    EMAIL_RE,
    SOAP_METHODS_READONLY,
};

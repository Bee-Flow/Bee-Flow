// @typecheck
'use strict';

// Per-company bulk reads for NMBRS (SOAP only for now): one call per company
// instead of one per employee. Tool definitions, validation, privacy filtering
// and execution live here; the transport (soapRequest) is injected by
// nmbrsTools.js so there is no import cycle.
//
// Every method, parameter name, casing and order below comes from the v3 WSDLs
// (api.nmbrs.nl/soap/v3/<Service>.asmx?WSDL). The casing differs per method
// (CompanyID vs CompanyId) and the envelope must follow the WSDL's order.
//
// PRIVACY: these tools return salary, contract and personal data. Rows are
// never logged (only the tool name and the company id). The personal-info bulk
// call passes through an ALLOW-LIST of fields: BSN, home address and private
// contact details never reach the model.

const { PAGING_PROPS, parsePaging, shapePage } = require('./nmbrsPaging');

const COMPANY_PROP = { type: 'string', description: 'Company ID from nmbrs_list_companies.' };
const YEAR_PROP = { type: 'integer', description: 'Calendar year, e.g. 2026.' };
const PERIOD_PROP = { type: 'integer', description: 'Period/month, 1-13.' };

/**
 * @param {string} name
 * @param {string} description
 * @param {Record<string, unknown>} extra
 * @param {string[]} required
 */
function bulkTool(name, description, extra, required) {
    return {
        type: 'function',
        function: {
            name,
            description: `${description} Read-only, SOAP API only. Paged: the result has total, hasMore and nextOffset. Payroll data is sensitive — only retrieve what was asked.`,
            parameters: { type: 'object', properties: { companyId: COMPANY_PROP, ...extra, ...PAGING_PROPS }, required: ['companyId', ...required] },
        },
    };
}

const NMBRS_BULK_TOOLS = [
    bulkTool('nmbrs_list_company_employments', 'List the employment periods of every employee of a NMBRS company, including the first start date (InitialStartDate), for anniversaries.', {}, []),
    bulkTool('nmbrs_list_company_lease_cars', 'List the lease cars of every employee of a NMBRS company in a given year and period, for term checks.', { year: YEAR_PROP, period: PERIOD_PROP }, ['year', 'period']),
    bulkTool('nmbrs_list_company_svw_settings', 'List the social-insurance settings (SVW) of every employee of a NMBRS company: collective agreement (CAO), influence on the obliged insurance, sector, risk group.', {}, []),
    bulkTool('nmbrs_list_company_runs', 'List the payroll runs of a NMBRS company in a given year, to choose a run.', { year: YEAR_PROP }, ['year']),
    bulkTool('nmbrs_list_company_personal_info', 'List personal, contract and salary basics of every employee of a NMBRS company in one call (name, birthday, contract dates, salary, hours). BSN, address and private contact details are left out.', {}, []),
    bulkTool('nmbrs_list_company_contracts', 'List the contract history of every employee of a NMBRS company in one call (instead of one call per employee).', {}, []),
];

// Fields of PersonalInfoContractSalaryAddress that may reach the model.
const PERSONAL_INFO_FIELDS = [
    'EmployeeID', 'EmployeeNumber', 'FirstName', 'Prefix', 'LastName', 'Birthday', 'Gender',
    'ContractStartDate', 'ContractEndDate', 'SalaryType', 'SalaryValue', 'HourlyWage', 'ContractHours',
    'EmployeeType', 'CompanyId',
];

/**
 * @param {any} row
 * @param {string[]} allowed
 */
function pickFields(row, allowed) {
    if (!row || typeof row !== 'object') return {};
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of allowed) if (key in row) out[key] = row[key];
    return out;
}

// name -> SOAP call. `params` lists the envelope parameters IN WSDL ORDER:
// [soapName, argName].
const BULK_SPECS = {
    nmbrs_list_company_employments: { service: 'EmployeeService', method: 'Employment_GetAll_AllEmployeesByCompany', params: [['CompanyID', 'companyId']], scope: 'employments' },
    nmbrs_list_company_lease_cars: { service: 'EmployeeService', method: 'LeaseCar_GetAll_EmployeesByCompany', params: [['CompanyId', 'companyId'], ['Period', 'period'], ['Year', 'year']], scope: 'lease cars' },
    nmbrs_list_company_svw_settings: { service: 'EmployeeService', method: 'SVW_GetAll_AllEmployeesByCompany', params: [['CompanyID', 'companyId']], scope: 'SVW settings' },
    nmbrs_list_company_runs: { service: 'CompanyService', method: 'Run_GetList', params: [['CompanyId', 'companyId'], ['Year', 'year']], scope: 'runs' },
    nmbrs_list_company_personal_info: { service: 'EmployeeService', method: 'PersonalInfoContractSalaryAddress_GetAll_AllEmployeesByCompany', params: [['CompanyID', 'companyId']], scope: 'employees', fields: PERSONAL_INFO_FIELDS },
    nmbrs_list_company_contracts: { service: 'EmployeeService', method: 'Contract_GetAll_AllEmployeesByCompany', params: [['CompanyID', 'companyId']], scope: 'employee contract lists' },
};

/**
 * @param {string} toolName
 * @returns {boolean}
 */
function isBulkTool(toolName) {
    return Object.prototype.hasOwnProperty.call(BULK_SPECS, toolName);
}

/**
 * @param {string} toolName
 * @param {Record<string, any>} args
 * @param {{ mode: string }} creds
 * @param {{ soapRequest: (creds: any, service: string, method: string, params: Record<string, unknown>) => Promise<unknown>, coerceArray: (node: unknown) => any[], validId: (v: unknown) => boolean, parseYear: (v: unknown) => number | null, parsePeriod: (v: unknown) => number | null | 'invalid', log: { info: (m: string) => void } }} deps
 */
async function executeBulkTool(toolName, args, creds, deps) {
    const spec = /** @type {Record<string, any>} */ (BULK_SPECS)[toolName];
    const companyId = String(args.companyId || '').trim();
    if (!deps.validId(companyId)) return { error: 'Invalid companyId. Use an ID from nmbrs_list_companies.' };
    /** @type {Record<string, unknown>} */
    const values = { companyId };
    if (spec.params.some((/** @type {string[]} */ p) => p[1] === 'year')) {
        const year = deps.parseYear(args.year);
        if (!year) return { error: 'Invalid year. Provide a 4-digit calendar year, e.g. 2026.' };
        values.year = year;
    }
    if (spec.params.some((/** @type {string[]} */ p) => p[1] === 'period')) {
        const period = deps.parsePeriod(args.period);
        if (!period || period === 'invalid') return { error: 'Invalid period. Use a number 1-13.' };
        values.period = period;
    }
    const paging = parsePaging(args);
    if ('error' in paging) return { error: paging.error };
    if (creds.mode === 'rest') {
        return { error: 'This NMBRS tool is only available over the SOAP API for now. Switch the NMBRS connection to the SOAP API to use it.' };
    }
    deps.log.info(`[NMBRS] ${toolName} for company ${companyId} (offset ${paging.offset})`);
    /** @type {Record<string, unknown>} */
    const soapParams = {};
    for (const [soapName, argName] of spec.params) soapParams[soapName] = values[argName];
    let rows = deps.coerceArray(await deps.soapRequest(creds, spec.service, spec.method, soapParams));
    if (spec.fields) rows = rows.map((/** @type {any} */ r) => pickFields(r, spec.fields));
    return shapePage(rows, paging, spec.scope);
}

module.exports = { NMBRS_BULK_TOOLS, isBulkTool, executeBulkTool, pickFields, PERSONAL_INFO_FIELDS };

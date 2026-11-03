/**
 * nmbrsRest.mts: the Nmbrs Payroll REST API, read-only.
 *
 * Every fact below is taken from Nmbrs' official REST documentation; the source
 * of each one is next to it. Anything the documentation does not state is not
 * implemented here (no sandbox host, no per-employee payslip summaries).
 *
 *   Host            https://api.nmbrsapp.com, paths under /api/...
 *                   Source: OpenAPI `servers` of the public REST API,
 *                   https://nmbrs.stoplight.io/docs/nmbrs-restapi/f0f5a1b041408-visma-nmbrs-public-rest-api
 *   Headers         `Authorization: Bearer <access_token>` and
 *                   `X-Subscription-Key: <subscription key>` on every call.
 *                   Source: https://nmbrs.stoplight.io/docs/nmbrs-restapi/e9e0f5292b4a1-authentication
 *                   ("4. Call the API": both headers are mandatory)
 *   Paging          `pageNumber` / `pageSize` (max 100) in the query; the body is
 *                   `{ pagination: { totalPages, ... }, data: [...] }`.
 *                   Source: https://nmbrs.stoplight.io/docs/nmbrs-restapi/92f908647549b-errors-pagination-versioning
 *   Documents       payslips per run answer `{ taskId }`; GET /api/documents/{taskId}
 *                   answers 202 while the file is generated and 200 with the file.
 *                   Source: https://nmbrs.stoplight.io/docs/nmbrs-restapi/7eb4734c916ef-get-payslips-by-payroll-run-xml
 *                   and https://nmbrs.stoplight.io/docs/nmbrs-restapi/a3bd5ae34a7a2-get-document-content
 *
 * READ-ONLY BY CONSTRUCTION: the verb is hard-coded to GET and every path is
 * built here from encodeURIComponent'd, validated ids.
 */

import { mapNmbrsError, nmbrsFetch, safeText } from './nmbrsTransport.mts';

export const REST_HOST = 'api.nmbrsapp.com';
export const SUBSCRIPTION_KEY_HEADER = 'X-Subscription-Key';
/** The largest page Nmbrs serves (pagination article: "Size of the page. Max 100."). */
export const REST_PAGE_SIZE = 100;
export const DEFAULT_REST_MAX_PAGES = 50;

const REST_PATH_RE = /^[A-Za-z0-9/_-]{1,200}$/; // defence-in-depth on internally-built paths

/** What a REST call needs: the OAuth access token and the subscription key. */
export interface RestCreds {
    token: string;
    subscriptionKey: string;
}

export type Query = Record<string, string>;

/** Most pages one list read fetches (NMBRS_REST_MAX_PAGES, 0 = unlimited). */
export function readMaxPages(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.NMBRS_REST_MAX_PAGES;
    if (raw === undefined || raw === '') return DEFAULT_REST_MAX_PAGES;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : DEFAULT_REST_MAX_PAGES;
}

/** https://api.nmbrsapp.com/api/<path>; `path` is assembled internally, the regex is a backstop. */
export function buildRestUrl(path: string): string {
    if (!REST_PATH_RE.test(path) || path.includes('..')) throw new Error('Invalid NMBRS REST path.');
    return `https://${REST_HOST}/api/${path}`;
}

function restHeaders(creds: RestCreds): Record<string, string> {
    return {
        Authorization: `Bearer ${creds.token}`,
        [SUBSCRIPTION_KEY_HEADER]: creds.subscriptionKey,
        Accept: 'application/json',
    };
}

function withQuery(url: string, query: Query | null): string {
    return query && Object.keys(query).length ? `${url}?${new URLSearchParams(query)}` : url;
}

/** One GET, parsed as JSON. */
export async function restGet(creds: RestCreds, path: string, query: Query | null = null): Promise<unknown> {
    const response = await nmbrsFetch(withQuery(buildRestUrl(path), query), { method: 'GET', headers: restHeaders(creds) });
    if (!response.ok) throw mapNmbrsError(response.status, await safeText(response));
    try {
        return await response.json();
    } catch {
        throw new Error('NMBRS returned an unexpected non-JSON response.');
    }
}

/** One GET whose status the caller needs (documents: 202 = not ready). The body as text. */
export async function restGetText(creds: RestCreds, path: string): Promise<{ status: number; text: string }> {
    const response = await nmbrsFetch(buildRestUrl(path), { method: 'GET', headers: { ...restHeaders(creds), Accept: '*/*' } });
    const text = await safeText(response);
    if (!response.ok) throw mapNmbrsError(response.status, text);
    return { status: response.status, text };
}

interface PagedBody {
    data?: unknown;
    pagination?: { totalPages?: unknown };
}

/** The rows of a REST body: the paged `data` array, or a bare array / object. */
export function restRows(body: unknown): unknown[] {
    if (Array.isArray(body)) return body;
    const data = (body as PagedBody | null)?.data;
    if (Array.isArray(data)) return data;
    if (body && typeof body === 'object' && data === undefined) return [body];
    return [];
}

/**
 * Every page of a paged list, concatenated. Stops at the last page Nmbrs reports
 * (`pagination.totalPages`) or at an empty page. A list longer than the page
 * budget is an error, never a silently cut list.
 */
export async function restGetAll(creds: RestCreds, path: string, query: Query | null = null, maxPages: number = readMaxPages()): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; ; page += 1) {
        if (maxPages > 0 && page > maxPages) {
            throw new Error(`NMBRS list is longer than ${maxPages} pages of ${REST_PAGE_SIZE}; raise NMBRS_REST_MAX_PAGES to read it.`);
        }
        const body = await restGet(creds, path, { ...query, pageNumber: String(page), pageSize: String(REST_PAGE_SIZE) });
        const pageRows = restRows(body);
        rows.push(...pageRows);
        const totalPages = Number((body as PagedBody | null)?.pagination?.totalPages);
        if (pageRows.length === 0 || !Number.isFinite(totalPages) || page >= totalPages) return rows;
    }
}

const enc = encodeURIComponent;

// ─── Paths (each from the operation page named in the comment) ─────────────
// All under https://nmbrs.stoplight.io/docs/nmbrs-restapi/<slug>.

export const restPaths = {
    /** 548adbc81909e-get-debtor-list */
    debtors: (): string => 'debtors',
    /** 5fad7a8461a01-get-company-list */
    companies: (): string => 'companies',
    /** t244m3rjye9dg-get-company-list-by-debtor */
    companiesByDebtor: (debtorId: string): string => `debtors/${enc(debtorId)}/companies`,
    /** a31578b069764-get-employee-list (query employeeType, e.g. "payroll,formerPayroll") */
    employees: (companyId: string): string => `companies/${enc(companyId)}/employees`,
    /** eea078fe0d752-get-an-employee */
    employee: (employeeId: string): string => `employees/${enc(employeeId)}`,
    /**
     * Per-company histories, each with an optional `employeeId` filter:
     * contracts d639580800a61, salaries 4a0a5684cb6b7, employments e85d45e5901d0,
     * leasecars deeb1a6f9c428, svwsettings d3p22e0al3g05, personalinfo 3ab454020a1ff,
     * fixedWageComponents d29409a4a9463 and variablewagecomponents b966cbf899fd2
     * (those two also take `year` + `period`).
     */
    companyEmployees: (companyId: string, list: CompanyEmployeeList): string => `companies/${enc(companyId)}/employees/${list}`,
    /** idgmktq42qnjz-get-company-payroll-runs (query `year`) */
    runs: (companyId: string): string => `companies/${enc(companyId)}/runs`,
    /** 7eb4734c916ef-get-payslips-by-payroll-run-xml (query `year`, answers `{ taskId }`) */
    runPayslips: (companyId: string, runId: string): string => `companies/${enc(companyId)}/runs/${enc(runId)}/payslips`,
    /** a3bd5ae34a7a2-get-document-content */
    document: (taskId: string): string => `documents/${enc(taskId)}`,
};

export type CompanyEmployeeList =
    | 'contracts' | 'salaries' | 'employments' | 'leasecars' | 'svwsettings' | 'personalinfo'
    | 'fixedWageComponents' | 'variablewagecomponents';

/**
 * The read scopes the tools above need, plus `offline_access` for a refresh token.
 * Source: the `security` of each operation in the REST reference, and the scope
 * list in https://identityservice.nmbrs.com/.well-known/openid-configuration.
 */
export const NMBRS_READ_SCOPES: readonly string[] = Object.freeze([
    'company.info.read', // debtors, companies
    'employee.info.read', // employees, employee, personalinfo
    'employee.employment.read', // contracts, salaries, employments
    'employee.payment.read', // fixed and variable wage components
    'employee.payrollsettings.read', // lease cars, SVW settings
    'company.payrollsettings.read', // payroll runs
    'employee.document.read', // payslips per run (generates the document)
    'document.read', // document content
    'offline_access', // the refresh token (authentication article, step 2)
]);

// ─── Reads behind the tools ─────────────────────────────────────

/**
 * employeeType of the employee list (a31578b069764-get-employee-list: "Possible types:
 * applicant, newHire, payroll, formerPayroll, external, formerExternal, rejectedApplicant").
 */
export function employeeTypes(activeOnly: boolean): string {
    return activeOnly ? 'payroll' : 'payroll,formerPayroll';
}

/** The first row of a single-record answer (GET /api/employees/{id} is paged too). */
export async function restGetOne(creds: RestCreds, path: string): Promise<unknown> {
    return restRows(await restGet(creds, path))[0] ?? null;
}

/** A per-company employee history, optionally for one employee and one year + period. */
export function companyEmployeeRows(creds: RestCreds, companyId: string, list: CompanyEmployeeList, filter: { employeeId?: string; year?: number; period?: number } = {}): Promise<unknown[]> {
    const query: Query = {};
    if (filter.employeeId) query.employeeId = filter.employeeId;
    if (filter.year && filter.period) {
        query.year = String(filter.year);
        query.period = String(filter.period);
    }
    return restGetAll(creds, restPaths.companyEmployees(companyId, list), query);
}

type Row = Record<string, unknown>;

function objectOf(value: unknown): Row {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

/**
 * PRIVACY allow-list for /employees/personalinfo (3ab454020a1ff-get-employees-history):
 * name, number, type, birth date, gender and the period of each entry. Nationality,
 * birth country, private contact details, partner and emergency contacts stay behind.
 */
export function restPersonalInfoRow(row: unknown): Row {
    const source = objectOf(row);
    const info = Array.isArray(source.info) ? source.info : [];
    return {
        employeeId: source.employeeId ?? null,
        info: info.map((entry) => {
            const e = objectOf(entry);
            const basic = objectOf(e.basicInfo);
            const birth = objectOf(e.birthInfo);
            return {
                employeeNumber: basic.employeeNumber ?? null,
                firstName: basic.firstName ?? null,
                prefix: basic.prefix ?? null,
                initials: basic.initials ?? null,
                lastName: basic.lastName ?? null,
                employeeType: basic.employeeType ?? null,
                birthDate: birth.birthDate ?? null,
                gender: birth.gender ?? null,
                period: e.period ?? null,
            };
        }),
    };
}

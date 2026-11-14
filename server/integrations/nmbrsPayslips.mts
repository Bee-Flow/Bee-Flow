/**
 * nmbrsPayslips.mts: the payslips of one payroll run of one NMBRS company.
 *
 * Nmbrs generates this report in the background, over both APIs:
 *
 *   SOAP  ReportService/Reports_GetPayslipByRunCompany_v2_Background(companyId, runId, year)
 *         answers a task GUID; ReportService/Reports_BackgroundTask_Result(TaskId) answers
 *         a TaskInfo { TaskId, Status, Content } (both from the v3 WSDL,
 *         https://api.nmbrs.nl/soap/v3/ReportService.asmx?WSDL). The statuses are Unknown,
 *         Enqueued, Executing, Success and Error (Nmbrs support, "Visma Nmbrs API - Executing
 *         background calls", https://support.nmbrs.com/hc/en-us/articles/360014722639).
 *   REST  GET /api/companies/{companyId}/runs/{payrollRunId}/payslips?year answers { taskId };
 *         GET /api/documents/{taskId} answers 202 while it is generated and 200 with the XML
 *         (https://nmbrs.stoplight.io/docs/nmbrs-restapi/7eb4734c916ef-get-payslips-by-payroll-run-xml,
 *         https://nmbrs.stoplight.io/docs/nmbrs-restapi/a3bd5ae34a7a2-get-document-content).
 *
 * Polling is bounded: an interval and a total timeout, both configurable
 * (NMBRS_REPORT_POLL_MS, NMBRS_REPORT_TIMEOUT_MS; a timeout of 0 means no limit).
 *
 * PRIVACY: a payslip carries the BSN, the home address and more. What reaches
 * the model is an ALLOW-LIST taken from the documented payslip XML ("Nmbrs API XML
 * references", https://support.nmbrs.com/hc/en-us/articles/360015523700): per
 * `payslip` its `employeeid`, and the key/value pairs of its `footer` (`footerItem`
 * with `key` and `value`, e.g. "Uren Gewerkt", "Fiscaalloon"). Every other element
 * is dropped, at every depth. Rows are never logged.
 */

import { createRequire } from 'node:module';
import { restGet, restGetAll, restGetText, restPaths, type RestCreds } from './nmbrsRest.mts';

const nodeRequire = createRequire(import.meta.url);
const { XMLParser } = nodeRequire('fast-xml-parser') as {
    XMLParser: new (options: Record<string, unknown>) => { parse: (xml: string) => unknown };
};
const { validId, parseYear, parsePeriod } = nodeRequire('./nmbrsArgs.js') as {
    validId: (v: unknown) => boolean;
    parseYear: (v: unknown) => number | null;
    parsePeriod: (v: unknown) => number | null | 'invalid';
};
const { PAGING_PROPS, parsePaging, shapePage } = nodeRequire('./nmbrsPaging.js') as {
    PAGING_PROPS: Record<string, unknown>;
    parsePaging: (args: Record<string, unknown>) => { offset: number; limit: number } | { error: string };
    shapePage: (rows: unknown[], paging: { offset: number; limit: number }, scope: string) => Record<string, unknown>;
};

export const RUN_PAYSLIPS_TOOL = 'nmbrs_get_company_run_payslips';
export const DEFAULT_POLL_MS = 2000;
export const DEFAULT_TIMEOUT_MS = 60000;
const MIN_POLL_MS = 250;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FOOTER_ITEMS = 200;

export const RUN_PAYSLIPS_TOOL_DEF = {
    type: 'function',
    function: {
        name: RUN_PAYSLIPS_TOOL,
        description: 'List the payslips of one payroll run of a NMBRS company: per employee the payslip totals (footer items such as hours worked and fiscal wage). Give runId (from nmbrs_list_company_runs) or a period, which picks the run that covers it. Read-only; the report takes a few seconds to generate. Paged: the result has total, hasMore and nextOffset. Payroll data is sensitive — only retrieve what was asked.',
        parameters: {
            type: 'object',
            properties: {
                companyId: { type: 'string', description: 'Company ID from nmbrs_list_companies.' },
                year: { type: 'integer', description: 'Calendar year of the run, e.g. 2026.' },
                runId: { type: 'string', description: 'Run ID from nmbrs_list_company_runs. Omit it and give period instead to use the run that covers that period.' },
                period: { type: 'integer', description: 'Period/month 1-13, used only when runId is omitted.' },
                employeeId: { type: 'string', description: 'Optional: only this employee\'s payslip.' },
                ...PAGING_PROPS,
            },
            required: ['companyId', 'year'],
        },
    },
};

export interface PayslipRow {
    employeeId: string | null;
    footer: Record<string, string>;
}

export interface PollConfig {
    intervalMs: number;
    /** 0 = no limit. */
    timeoutMs: number;
}

export interface Clock {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}

const realClock: Clock = {
    now: () => Date.now(),
    // Not unref'd: a tool call that is waiting for its report keeps the process busy, boundedly.
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

function readNonNegative(raw: string | undefined, fallbackValue: number): number {
    if (raw === undefined || raw === '') return fallbackValue;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallbackValue;
}

export function readPollConfig(env: NodeJS.ProcessEnv = process.env): PollConfig {
    return {
        intervalMs: Math.max(MIN_POLL_MS, readNonNegative(env.NMBRS_REPORT_POLL_MS, DEFAULT_POLL_MS)),
        timeoutMs: readNonNegative(env.NMBRS_REPORT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    };
}

export type PollStep<T> = { done: true; value: T } | { done: false };

/** Ask `check` until it is done, waiting `intervalMs` between attempts, within `timeoutMs`. */
export async function pollUntilReady<T>(check: () => Promise<PollStep<T>>, config: PollConfig, clock: Clock = realClock): Promise<T> {
    const started = clock.now();
    for (;;) {
        const step = await check();
        if (step.done) return step.value;
        if (config.timeoutMs > 0 && clock.now() - started + config.intervalMs > config.timeoutMs) {
            throw new Error(`The NMBRS payslip report was not ready within ${Math.round(config.timeoutMs / 1000)}s. Try again in a minute.`);
        }
        await clock.sleep(config.intervalMs);
    }
}

// ─── Payslip XML → allow-listed rows ─────────────────────────────

const xmlParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true });

type XmlNode = Record<string, unknown>;

function asList(value: unknown): unknown[] {
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value : [value];
}

/** The value of the first key named `name` (case-insensitive) on `node`. */
function childOf(node: unknown, name: string): unknown {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    const lower = name.toLowerCase();
    const key = Object.keys(node).find((k) => k.toLowerCase() === lower);
    return key === undefined ? undefined : (node as XmlNode)[key];
}

function scalar(value: unknown): string | null {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function footerOf(payslip: unknown): Record<string, string> {
    const footer: Record<string, string> = {};
    for (const block of asList(childOf(payslip, 'footer'))) {
        for (const item of asList(childOf(block, 'footerItem')).slice(0, MAX_FOOTER_ITEMS)) {
            const key = scalar(childOf(item, 'key'));
            const value = scalar(childOf(item, 'value'));
            if (key && value !== null && !(key in footer)) footer[key] = value;
        }
    }
    return footer;
}

/**
 * The allow-listed rows of a payslip XML document. A document without a
 * `payslips` root is refused: an unknown format must not reach the model.
 */
export function parsePayslipXml(xml: string): PayslipRow[] {
    let parsed: unknown;
    try {
        parsed = xmlParser.parse(xml);
    } catch {
        throw new Error('NMBRS returned the payslip report in an unexpected format.');
    }
    const root = childOf(parsed, 'payslips');
    if (root === undefined) throw new Error('NMBRS returned the payslip report in an unexpected format.');
    return asList(childOf(root, 'payslip')).map((payslip) => ({
        employeeId: scalar(childOf(payslip, 'employeeid')),
        footer: footerOf(payslip),
    }));
}

// ─── The two backends ────────────────────────────────────────────

// A method's type, so the caller's request may name its own credentials shape: this module only hands them back.
export type SoapRequest = { request(creds: unknown, service: string, method: string, params: Record<string, unknown>): Promise<unknown> }['request'];

export interface RunRef {
    runId: string;
    number: unknown;
    description: unknown;
    periodStart: number;
    periodEnd: number;
}

interface Backend {
    listRuns: (companyId: string, year: number) => Promise<RunRef[]>;
    startReport: (companyId: string, runId: string, year: number) => Promise<string>;
    reportStep: (taskId: string) => Promise<PollStep<string>>;
}

function soapBackend(creds: unknown, soapRequest: SoapRequest, coerceArray: (node: unknown) => unknown[]): Backend {
    return {
        listRuns: async (companyId, year) => coerceArray(await soapRequest(creds, 'CompanyService', 'Run_GetList', { CompanyId: companyId, Year: year }))
            .map((r) => r as XmlNode)
            .map((r) => ({ runId: String(r.ID), number: r.Number, description: r.Description, periodStart: Number(r.PeriodStart), periodEnd: Number(r.PeriodEnd) })),
        // Parameter names and order exactly as the WSDL: companyId, runId, year.
        startReport: async (companyId, runId, year) => taskIdOf(await soapRequest(creds, 'ReportService', 'Reports_GetPayslipByRunCompany_v2_Background', { companyId, runId, year })),
        reportStep: async (taskId) => {
            const info = (await soapRequest(creds, 'ReportService', 'Reports_BackgroundTask_Result', { TaskId: taskId })) as XmlNode | null;
            const status = String(info?.Status || '').toLowerCase();
            if (status === 'error') throw new Error('NMBRS could not generate the payslip report.');
            if (status !== 'success') return { done: false };
            const content = scalar(info?.Content);
            if (!content) throw new Error('NMBRS returned an empty payslip report.');
            return { done: true, value: content };
        },
    };
}

function restBackend(creds: RestCreds): Backend {
    return {
        listRuns: async (companyId, year) => (await restGetAll(creds, restPaths.runs(companyId), { year: String(year) }))
            .map((r) => r as XmlNode)
            .map((r) => ({ runId: String(r.payrollRunId), number: r.number, description: r.description, periodStart: Number(r.periodStart), periodEnd: Number(r.periodEnd) })),
        startReport: async (companyId, runId, year) => taskIdOf((await restGet(creds, restPaths.runPayslips(companyId, runId), { year: String(year) }) as XmlNode | null)?.taskId),
        reportStep: async (taskId) => {
            const { status, text } = await restGetText(creds, restPaths.document(taskId));
            if (status === 202) return { done: false };
            return { done: true, value: text };
        },
    };
}

function taskIdOf(value: unknown): string {
    const id = scalar(value)?.trim() || '';
    if (!GUID_RE.test(id)) throw new Error('NMBRS did not start the payslip report.');
    return id;
}

/** The run that covers `period`, or an error that names the candidates. */
function pickRun(runs: RunRef[], period: number): { runId: string } | { error: string } {
    const covering = runs.filter((r) => r.periodStart <= period && period <= r.periodEnd);
    if (covering.length === 1) return { runId: covering[0].runId };
    if (covering.length === 0) return { error: `No NMBRS payroll run covers period ${period}. Use nmbrs_list_company_runs to choose a runId.` };
    const ids = covering.map((r) => r.runId).join(', ');
    return { error: `Several NMBRS payroll runs cover period ${period} (runIds ${ids}). Pass runId to choose one.` };
}

// ─── The tool ────────────────────────────────────────────────────

export type CachedRows = (request: { tool: string; companyId: string; args: Record<string, unknown>; fetchRows: () => Promise<unknown[]>; fresh: boolean }) => Promise<unknown[]>;

export interface RunPayslipDeps {
    creds: { mode: string };
    restCreds?: RestCreds | null;
    soapRequest: SoapRequest;
    coerceArray: (node: unknown) => unknown[];
    log: { info: (message: string) => void };
    cachedRows?: CachedRows;
    clock?: Clock;
    pollConfig?: PollConfig;
}

interface RunArgs {
    companyId: string;
    year: number;
    runId: string;
    period: number | null;
    employeeId: string;
}

function readArgs(args: Record<string, unknown>): RunArgs | { error: string } {
    const companyId = String(args.companyId || '').trim();
    if (!validId(companyId)) return { error: 'Invalid companyId. Use an ID from nmbrs_list_companies.' };
    const year = parseYear(args.year);
    if (!year) return { error: 'Invalid year. Provide a 4-digit calendar year, e.g. 2026.' };
    const runId = args.runId != null ? String(args.runId).trim() : '';
    if (runId && !validId(runId)) return { error: 'Invalid runId. Use an ID from nmbrs_list_company_runs.' };
    const period = parsePeriod(args.period);
    if (period === 'invalid') return { error: 'Invalid period. Use a number 1-13.' };
    if (!runId && !period) return { error: 'Give runId (from nmbrs_list_company_runs) or the period whose run you want.' };
    const employeeId = args.employeeId != null ? String(args.employeeId).trim() : '';
    if (employeeId && !validId(employeeId)) return { error: 'Invalid employeeId. Use an ID from nmbrs_list_employees.' };
    return { companyId, year, runId, period, employeeId };
}

export async function executeRunPayslips(args: Record<string, unknown>, deps: RunPayslipDeps): Promise<Record<string, unknown>> {
    const read = readArgs(args);
    if ('error' in read) return { error: read.error };
    const paging = parsePaging(args);
    if ('error' in paging) return { error: paging.error };
    if (deps.creds.mode === 'rest' && !deps.restCreds) return { error: 'NMBRS REST is not connected.' };
    const backend = deps.creds.mode === 'rest' && deps.restCreds
        ? restBackend(deps.restCreds)
        : soapBackend(deps.creds, deps.soapRequest, deps.coerceArray);

    let runId = read.runId;
    if (!runId) {
        const picked = pickRun(await backend.listRuns(read.companyId, read.year), read.period as number);
        if ('error' in picked) return { error: picked.error };
        runId = picked.runId;
    }
    deps.log.info(`[NMBRS] ${RUN_PAYSLIPS_TOOL} for company ${read.companyId}, run ${runId} (offset ${paging.offset})`);
    const fetchRows = async (): Promise<unknown[]> => {
        const taskId = await backend.startReport(read.companyId, runId, read.year);
        const xml = await pollUntilReady(() => backend.reportStep(taskId), deps.pollConfig || readPollConfig(), deps.clock);
        return parsePayslipXml(xml);
    };
    // Later pages come from the short-lived cache: the report is generated once per read.
    const rows = deps.cachedRows
        ? await deps.cachedRows({ tool: RUN_PAYSLIPS_TOOL, companyId: read.companyId, args: { year: read.year, runId }, fetchRows, fresh: paging.offset === 0 })
        : await fetchRows();
    const selected = read.employeeId
        ? rows.filter((r) => (r as PayslipRow).employeeId === read.employeeId)
        : rows;
    return { runId, ...shapePage(selected, paging, 'payslips') };
}

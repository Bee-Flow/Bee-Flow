/**
 * Scaleway Billing Tools — read-only access to an organisation's Scaleway invoices.
 *
 * Two tools, both GET-only:
 *   - scaleway_list_invoices     the invoice list, flattened (amounts as numbers,
 *                                a deterministic file name per invoice)
 *   - scaleway_download_invoice  the PDF of one invoice, KEPT for the automation run
 *                                and handed on as a `generated_file` handle — the
 *                                same handle generate_document produces, so
 *                                nextcloud_upload_file and drive_upload_file take
 *                                it without knowing where the bytes came from.
 *
 * The bytes never enter runState: the PDF arrives base64 inside JSON
 * (`{ name, content_type, content }`), is decoded here, stored through
 * keepGeneratedFile and only its handle travels on. Outside an automation run there
 * is no journey to scope that file to, so the download tool refuses.
 *
 * Auth is a Scaleway IAM secret key in `X-Auth-Token`, whose principal needs the
 * BillingReadOnly permission set at Organization level. This is deliberately NOT
 * the instance-wide `scaleway_api_key` (the operator's Generative APIs key):
 * reusing that would show every org the operator's Scaleway bill. The base URL is
 * a fixed constant, so there is no SSRF surface; the credential regexes are the
 * header-injection guard.
 *
 * API reference: https://www.scaleway.com/en/developers/api/billing/
 */

const { jsonApiRequest } = require('./shared/apiClient');
const log = require('../telemetry/log');

const API_BASE = 'https://api.scaleway.com/billing/v2beta1';
const REQUEST_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100; // Scaleway's maximum page_size
const DEFAULT_MONTHS_BACK = 12;
const MAX_ERROR_MESSAGE_CHARS = 300;

// Scaleway secret keys and organization ids are both UUIDs. Anything else is
// refused before it can reach a request header or a query string.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_KEY_RE = UUID_RE;
const ORG_ID_RE = UUID_RE;
const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const INVOICE_TYPES = ['periodic', 'purchase', 'credit_note'];

function fn(name, description, parameters) {
    return { type: 'function', function: { name, description, parameters } };
}

const SCALEWAY_BILLING_TOOLS = [
    fn(
        'scaleway_list_invoices',
        'List the Scaleway invoices of the connected organisation, newest first: invoice id, number, billing period (YYYY-MM), issue and due date, type, state, currency and the totals excluding VAT, VAT and including VAT. Each invoice also carries `fileName`, a stable PDF name to save it under. Use scaleway_download_invoice with the id to get the PDF.',
        {
            type: 'object',
            properties: {
                periodFrom: { type: 'string', description: `First billing period to include, YYYY-MM (default: ${DEFAULT_MONTHS_BACK} months ago)` },
                periodTo: { type: 'string', description: 'Last billing period to include, YYYY-MM (default: the current month)' },
                type: { type: 'string', enum: INVOICE_TYPES, description: 'Only this invoice type (default: all)' },
                limit: { type: 'integer', description: `Maximum number of invoices (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})` },
                includeVoided: { type: 'boolean', description: 'Also return voided invoices (default false)' },
            },
            required: [],
        },
    ),
    fn(
        'scaleway_download_invoice',
        'Download the PDF of one Scaleway invoice inside an automation. Returns the file name, size and a `sourceHandle` to pass to nextcloud_upload_file or drive_upload_file, which save the PDF in a folder. Only works in an automation run, not in a chat.',
        {
            type: 'object',
            properties: {
                invoiceId: { type: 'string', description: 'Invoice id (a UUID) from scaleway_list_invoices or the "New Scaleway invoice" trigger' },
            },
            required: ['invoiceId'],
        },
    ),
];

const TOOL_NAMES = new Set(SCALEWAY_BILLING_TOOLS.map(t => t.function.name));

function isScalewayBillingTool(toolName) {
    return TOOL_NAMES.has(toolName);
}

// ─── Pure helpers ───────────────────────────────────────────────

/** A Scaleway Money object `{ currency_code, units, nanos }` → a number with cents. */
function moneyToNumber(money) {
    if (!money || typeof money !== 'object') return null;
    const units = Number(money.units || 0);
    const nanos = Number(money.nanos || 0);
    if (!Number.isFinite(units) || !Number.isFinite(nanos)) return null;
    return Math.round((units + nanos / 1e9) * 100) / 100;
}

/** 'YYYY-MM' → { year, month } or null. */
function parsePeriod(value) {
    const m = PERIOD_RE.exec(String(value || '').trim());
    return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

/** First instant of a month, as RFC 3339; month may overflow into the next year. */
function monthStartIso(year, month) {
    return new Date(Date.UTC(year, month - 1, 1)).toISOString();
}

/**
 * The billing-period window to ask for. Scaleway snaps both bounds to the MONTH
 * they fall in (measured live): `billing_period_start_after` includes that
 * month, `billing_period_start_before` excludes it. So the bounds are the first
 * day of periodFrom and the first day after periodTo (inclusive range).
 * A bound past the end of the running month is refused with a 400 ("Date
 * filter(s) are after the end of the current billing month"), so the upper
 * bound is clamped to the running month's last second. That leaves the running
 * month out, which costs nothing: its invoice is only issued next month.
 */
function periodWindow(args, now = new Date()) {
    const to = args.periodTo != null && args.periodTo !== '' ? parsePeriod(args.periodTo) : null;
    if (args.periodTo != null && args.periodTo !== '' && !to) throw new Error('periodTo must be YYYY-MM.');
    const from = args.periodFrom != null && args.periodFrom !== '' ? parsePeriod(args.periodFrom) : null;
    if (args.periodFrom != null && args.periodFrom !== '' && !from) throw new Error('periodFrom must be YYYY-MM.');

    const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
    const end = to || current;
    const start = from || { year: end.year, month: end.month - DEFAULT_MONTHS_BACK + 1 };
    if (start.year * 12 + start.month > end.year * 12 + end.month) throw new Error('periodFrom must not be after periodTo.');
    const after = monthStartIso(start.year, start.month);
    const runningMonthEnd = new Date(Date.parse(monthStartIso(current.year, current.month + 1)) - 1000).toISOString();
    const nextAfterEnd = monthStartIso(end.year, end.month + 1);
    const before = nextAfterEnd < runningMonthEnd ? nextAfterEnd : runningMonthEnd;
    return { after, before };
}

function clampLimit(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
}

/**
 * The billing period as YYYY-MM. The live API sends a timestamp
 * ("2026-09-01T00:00:00Z"), not the bare month the SDK docs suggest, so the
 * month is taken from whichever date field carries it.
 */
function billingMonth(inv) {
    for (const v of [inv.billing_period, inv.billingPeriod, inv.start_date]) {
        const m = /^(\d{4}-\d{2})/.exec(String(v || ''));
        if (m) return m[1];
    }
    return null;
}

/** The name an invoice is saved under: stable, so a re-run overwrites rather than duplicates. */
function invoiceFileName(inv) {
    const period = billingMonth(inv) || 'unknown-period';
    const number = String(inv.number ?? '').replace(/[^A-Za-z0-9-]/g, '') || String(inv.id || '').slice(0, 8);
    const suffix = (inv.type === 'credit_note') ? '-credit-note' : '';
    return `Scaleway-${period}-${number}${suffix}.pdf`;
}

function datePart(value) {
    return typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : (value || null);
}

/** One raw Scaleway invoice → the flat shape automations bind to. */
function shapeInvoice(inv) {
    const currency = inv.total_taxed?.currency_code || inv.total_untaxed?.currency_code || null;
    return {
        id: inv.id,
        number: inv.number ?? null,
        billingPeriod: billingMonth(inv),
        issuedDate: datePart(inv.issued_date),
        dueDate: datePart(inv.due_date),
        type: inv.type || null,
        state: inv.state || null,
        currency,
        totalExclVat: moneyToNumber(inv.total_untaxed),
        totalVat: moneyToNumber(inv.total_tax),
        totalInclVat: moneyToNumber(inv.total_taxed),
        fileName: invoiceFileName(inv),
    };
}

/** Turn an HTTP failure into something an automation author can act on. */
function describeError(err) {
    const status = err && err.status;
    if (status === 401) return 'Scaleway rejected the secret key. Check the key in Settings → Integrations.';
    if (status === 403) return 'The Scaleway key has no access to billing. Give its IAM application the BillingReadOnly permission set at Organization level.';
    if (status === 404) return 'Scaleway does not know that invoice.';
    // jsonApiRequest already prefixes "Scaleway:"; the caller adds it once.
    const msg = String((err && err.message) || 'request failed').replace(/^Scaleway:\s*/, '');
    return msg.length > MAX_ERROR_MESSAGE_CHARS ? `${msg.slice(0, MAX_ERROR_MESSAGE_CHARS)}…` : msg;
}

function isPdf(buffer) {
    return buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

// ─── Tool execution (credentials and side effects injected) ─────

/**
 * @param {string} toolName
 * @param {object} args
 * @param {{ secretKey: string, orgId?: string|null }} creds
 * @param {{ request: Function, keepFile?: Function|null, now?: Date }} deps
 *   `request(url, opts)` is jsonApiRequest's contract; `keepFile({buffer,
 *   filename, mimeType})` stores the PDF for the run and returns `{ id }`, or is
 *   null outside an automation run.
 */
async function runScalewayBillingTool(toolName, args, creds, deps) {
    const headers = { 'X-Auth-Token': creds.secretKey, Accept: 'application/json' };
    const get = (path, query, timeoutMs = REQUEST_TIMEOUT_MS) => {
        const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
        return deps.request(`${API_BASE}${path}${qs}`, {
            method: 'GET', headers, timeoutMs, errorPrefix: 'Scaleway',
        });
    };

    switch (toolName) {
        case 'scaleway_list_invoices': {
            const limit = clampLimit(args.limit);
            const { after, before } = periodWindow(args, deps.now || new Date());
            if (args.type != null && args.type !== '' && !INVOICE_TYPES.includes(args.type)) {
                throw new Error(`type must be one of: ${INVOICE_TYPES.join(', ')}.`);
            }
            // Always one full page, then filter, sort and cut here: Scaleway puts a
            // voided invoice (number 0) FIRST even under invoice_number_desc, so
            // page_size = limit would hand back fewer than `limit` real invoices.
            // A page of 100 covers eight years of monthly bills.
            const query = {
                billing_period_start_after: after,
                billing_period_start_before: before,
                order_by: 'invoice_number_desc',
                page: '1',
                page_size: String(MAX_LIMIT),
            };
            if (creds.orgId) query.organization_id = creds.orgId;

            const res = await get('/invoices', query);
            // A voided invoice (number 0, nothing due) is not a bill anyone files;
            // left in, the "New Scaleway invoice" trigger would fire for it.
            // The type is filtered here, not with `invoice_type`: the API answers
            // 400 to invoice_type=credit_note although its own enum lists it.
            const shaped = (Array.isArray(res?.invoices) ? res.invoices : [])
                .filter(inv => args.includeVoided === true || inv.state !== 'voided')
                .filter(inv => !args.type || inv.type === args.type)
                .map(shapeInvoice)
                .sort((x, y) => String(y.billingPeriod || '').localeCompare(String(x.billingPeriod || ''))
                    || (Number(y.number) || 0) - (Number(x.number) || 0))
                .slice(0, limit);
            return { invoices: shaped, count: shaped.length, total: Number(res?.total_count) || shaped.length };
        }

        case 'scaleway_download_invoice': {
            const invoiceId = String(args.invoiceId || '').trim();
            if (!UUID_RE.test(invoiceId)) throw new Error('invoiceId must be the invoice UUID from scaleway_list_invoices.');
            if (!deps.keepFile) {
                throw new Error('scaleway_download_invoice only works inside an automation: the PDF is kept for that run and passed on to nextcloud_upload_file or drive_upload_file.');
            }
            const inv = await get(`/invoices/${invoiceId}`);
            const file = await get(`/invoices/${invoiceId}/download`, { file_type: 'pdf' }, DOWNLOAD_TIMEOUT_MS);
            const content = file && typeof file === 'object' ? file.content : null;
            if (typeof content !== 'string' || !content) throw new Error('Scaleway returned no PDF content for this invoice.');
            const buffer = Buffer.from(content, 'base64');
            if (!isPdf(buffer)) throw new Error('Scaleway returned a file that is not a PDF.');

            const filename = invoiceFileName(inv || { id: invoiceId });
            const kept = await deps.keepFile({ buffer, filename, mimeType: 'application/pdf' });
            return {
                fileId: kept.id,
                filename,
                mimeType: 'application/pdf',
                size: buffer.length,
                invoiceNumber: inv?.number ?? null,
                billingPeriod: inv ? billingMonth(inv) : null,
                sourceHandle: { kind: 'generated_file', fileId: kept.id },
            };
        }

        default:
            throw new Error(`Unknown Scaleway billing tool: ${toolName}`);
    }
}

// ─── Wiring: credentials and the run's file store ───────────────

async function getScalewayBillingCredentials(userId) {
    const configStore = require('../stores/configStore');
    const secretKey = await configStore.getSecret(`scaleway_billing_secret_key_user_${userId}`);
    if (!secretKey) return null;
    const orgId = await configStore.getSecret(`scaleway_billing_org_id_user_${userId}`);
    return { secretKey: String(secretKey).trim(), orgId: orgId ? String(orgId).trim() : null };
}

/**
 * Re-validate stored credentials before they reach a header or a query: the
 * save path validates too, but an older build or a restored backup must never be
 * able to inject one.
 */
function assertValidCredentials(creds) {
    if (!SECRET_KEY_RE.test(creds.secretKey)) {
        throw new Error('The stored Scaleway secret key has an invalid format. Re-enter it in Settings → Integrations.');
    }
    if (creds.orgId && !ORG_ID_RE.test(creds.orgId)) {
        throw new Error('The stored Scaleway organization id has an invalid format. Re-enter it in Settings → Integrations.');
    }
}

/** A keepFile bound to the automation run, or null when there is no run to keep it for. */
function keepFileForRun(userId, ctx) {
    const runId = ctx && ctx.runScope && ctx.runScope.runId;
    if (!runId || !ctx.automationId) return null;
    return async ({ buffer, filename, mimeType }) => {
        const { keepGeneratedFile } = require('../core/automationRunner/execDocument');
        return keepGeneratedFile({
            ctx: { userId, automationId: ctx.automationId, runId },
            step: { id: null },
            buffer,
            contentType: mimeType,
            filename,
            stepLabel: 'scaleway_download_invoice',
        });
    };
}

/**
 * @param {string} toolName
 * @param {object} args
 * @param {string} userId
 * @param {{ automationId?: string|null, runScope?: {runId:string, rootRunId?:string}|null }} [ctx]
 */
async function executeScalewayBillingTool(toolName, args, userId, ctx = {}) {
    if (!userId) return { error: 'User context required for Scaleway billing.' };
    if (!isScalewayBillingTool(toolName)) return { error: `Unknown Scaleway billing tool: ${toolName}` };

    const creds = await getScalewayBillingCredentials(userId);
    if (!creds) {
        return { error: 'Scaleway billing not configured. Add your Scaleway secret key in Settings → Integrations.' };
    }

    try {
        assertValidCredentials(creds);
        log.info(`[ScalewayBilling] ${toolName}`);
        return await runScalewayBillingTool(toolName, args || {}, creds, {
            request: jsonApiRequest,
            keepFile: keepFileForRun(userId, ctx),
        });
    } catch (err) {
        log.warn(`[ScalewayBilling] ${toolName} failed: ${err.message}`);
        return { error: `Scaleway: ${describeError(err)}` };
    }
}

module.exports = {
    SCALEWAY_BILLING_TOOLS,
    executeScalewayBillingTool,
    isScalewayBillingTool,
    // Shape checks reused by the settings save path.
    SECRET_KEY_RE,
    ORG_ID_RE,
    // Pure helpers exported for unit tests.
    runScalewayBillingTool,
    moneyToNumber,
    periodWindow,
    invoiceFileName,
    billingMonth,
    shapeInvoice,
    describeError,
    clampLimit,
    MAX_LIMIT,
};

/**
 * 2BA tools: article data and NET purchase prices from 2BA, the Dutch product
 * and price data pool, for chat, agents,
 * automations and apps. 2BA computes the net price from the condition files
 * the customer loaded into its Online Condition Server (OCS).
 *
 *   twoba_find_trade_items          a bill of materials at one supplier: match, price, flag (twobaLookup.mts)
 *   twoba_net_price                 one article's net price (project number, order quantity)
 *   twoba_list_condition_databases  the OCS databases and the one in use
 *   twoba_upload_conditions         WRITE: a condition file of the run into an OCS database
 *
 * Bring-your-own connection like Frappe CRM: each person stores a 2BA client id
 * and secret and signs in (twobaAuth.mts); the tools act as that 2BA user. Not
 * lendable. Results are `{ error, code, status }` on failure: status 4xx when
 * the caller can fix it, 502/503/504 when 2BA failed. Log lines name the tool
 * and the status, never article data.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { configFor, isConfigured, NOT_CONFIGURED, passwordToken, type TwobaConfig } from './twobaAuth.mts';
import { twobaApi, type Connection } from './twobaApi.mts';
import { TwobaError, errorForStatus, safeText, twobaFetch, API_BASE } from './twobaTransport.mts';
import { findTradeItems, lookupGtin, netPrice } from './twobaLookup.mts';
import { isoDate, num, today, type TradeItemOut } from './twobaPricing.mts';
import { priceLine } from './twobaLines.mts';
import {
    FindItemsArgs, ListDatabasesArgs, NetPriceArgs, TWOBA_TOOLS, TWOBA_TOOL_NAMES, UploadArgs, maxItems,
    type FindItemsInput, type NetPriceInput, type UploadInput,
} from './twobaToolDefs.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };
const { envInt } = nodeRequire('../utils/envNumber.mts') as typeof import('../utils/envNumber.mts');

export { TWOBA_TOOLS, TWOBA_TOOL_NAMES };

type Raw = Record<string, unknown>;
export interface RunContext {
    automationId?: string | null;
    runScope?: { runId: string; rootRunId?: string } | null;
}

export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;
const CONDITION_EXTENSIONS = ['.icc', '.txt', '.xml'];

/** Condition file size cap in bytes (TWOBA_MAX_UPLOAD_BYTES, 0 = unlimited). */
export function maxUploadBytes(): number {
    return envInt('TWOBA_MAX_UPLOAD_BYTES', DEFAULT_MAX_UPLOAD_BYTES, { min: 0 });
}

const text = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());

function userError(code: string, message: string): TwobaError {
    return new TwobaError(400, code, message);
}

// ─── Handlers ────────────────────────────────────────────────────

async function findItems(conn: Connection, args: FindItemsInput): Promise<Raw> {
    const cap = maxItems();
    if (args.items.length > cap) throw userError('twoba_too_many_items', `At most ${cap} lines per call; split the list (this server's TWOBA_MAX_ITEMS).`);
    const { items, summary, priceDate } = await findTradeItems(conn, args);
    return { supplierGln: args.supplierGln, projectNumber: args.projectNumber ?? null, priceDate, items, summary };
}

/** The one trade item a GTIN names, or the answer to give when it names none or several. */
async function byGtin(conn: Connection, args: NetPriceInput): Promise<{ item: TradeItemOut } | { answer: Raw }> {
    const hits = await lookupGtin(conn, args.supplierGln, String(args.gtin));
    if (hits.length === 1 && hits[0].tradeItemId) return { item: hits[0] };
    const several = hits.length > 1;
    return { answer: { status: several ? 'multiple' : 'not_found', supplierGln: args.supplierGln, gtin: args.gtin, candidates: hits.slice(0, 10), flags: several ? ['multiple_matches'] : [] } };
}

async function oneNetPrice(conn: Connection, args: NetPriceInput): Promise<Raw> {
    let item: TradeItemOut | null = null;
    if (!args.tradeItemId) {
        const found = await byGtin(conn, args);
        if ('answer' in found) return found.answer;
        item = found.item;
    }
    const tradeItemId = args.tradeItemId || String(item?.tradeItemId);
    const { price, failed } = await netPrice(conn, args.supplierGln, tradeItemId, args.projectNumber, args.orderQuantity);
    const priced = priceLine(item, price);
    return {
        status: price || item ? 'matched' : 'not_found', supplierGln: args.supplierGln, tradeItemId, gtin: args.gtin ?? item?.gtin ?? null,
        projectNumber: args.projectNumber ?? null, orderQuantity: args.orderQuantity ?? null,
        ...(item ? { tradeItem: item } : {}), price, unitNetPrice: priced.unitNetPrice, priceDate: today(),
        flags: failed ? [...priced.flags, 'price_lookup_failed'] : priced.flags,
    };
}

async function listDatabases(conn: Connection): Promise<Raw> {
    const [databases, status] = await Promise.all([
        twobaApi(conn, 'GET', '/CompanyConditions/databases'),
        twobaApi(conn, 'GET', '/CompanyConditions/currentUserStatus'),
    ]);
    const s = (status && typeof status === 'object' ? status : {}) as Raw;
    return {
        databases: (Array.isArray(databases) ? databases : []).map((d: Raw) => ({ id: num(d.Id), name: text(d.Name), createDate: isoDate(d.CreateDate) })),
        current: { companyName: text(s.Companyname), databaseName: text(s.Databasename) },
    };
}

// ─── Upload ──────────────────────────────────────────────────────

interface RunFile { buffer: Buffer; filename: string; size: number }

const FILE_ERRORS: Record<string, [number, string]> = {
    table_source_missing: [400, 'No file was given: pass the sourceHandle of a form upload or of a file an earlier step made.'],
    table_source_unsupported: [400, 'This tool takes a file from a form or from an earlier step of this run.'],
    table_source_not_found: [404, 'The file could not be found. It may have expired or belong to another automation.'],
    table_source_too_large: [413, 'The condition file is larger than this server accepts (TWOBA_MAX_UPLOAD_BYTES).'],
};

async function readRunFile(handle: unknown, ctx: RunContext): Promise<RunFile> {
    if (!ctx.runScope?.runId) throw userError('twoba_needs_run', 'twoba_upload_conditions works inside an automation run: the condition file is a file of that run.');
    const { readSourceFile } = nodeRequire('../core/automationRunner/tables/sourceFile.js') as {
        readSourceFile: (v: unknown, c: Record<string, unknown>, d: Record<string, unknown>) => Promise<RunFile>;
    };
    const cap = maxUploadBytes();
    try {
        return await readSourceFile(handle, { automationId: ctx.automationId, runId: ctx.runScope.runId, rootRunId: ctx.runScope.rootRunId }, { limits: () => ({ maxFileBytes: cap }) });
    } catch (err) {
        const known = FILE_ERRORS[String((err as { errorClass?: unknown })?.errorClass)];
        if (known) throw new TwobaError(known[0], 'twoba_file', known[1]);
        throw err;
    }
}

function importFiles(answer: unknown): Raw[] {
    const a = (answer && typeof answer === 'object' ? answer : {}) as Raw;
    const files = Array.isArray(a.Files) ? a.Files as Raw[] : [];
    return files.map((f) => ({ importId: num(f.ImportId), name: text(f.Name), size: num(f.Size), error: text(f.Error) }));
}

/** The ImportResult fields, when 2BA answers with one instead of (or next to) the file list. */
function importResult(answer: unknown): Raw | null {
    const a = (answer && typeof answer === 'object' ? answer : {}) as Raw;
    if (a.Id === undefined && a.TotalImportRows === undefined) return null;
    return {
        id: num(a.Id), filename: text(a.Filename), formatName: text(a.FormatName), importDate: isoDate(a.ImportDate),
        processingDate: isoDate(a.ProcessingDate), totalImportRows: num(a.TotalImportRows),
        totalImportRowsFailure: num(a.TotalImportRowsFailure), importDetailsLink: text(a.ImportDetailsLink),
    };
}

async function uploadConditions(conn: Connection, args: UploadInput, ctx: RunContext): Promise<Raw> {
    const file = await readRunFile(args.sourceHandle, ctx);
    const lower = file.filename.toLowerCase();
    if (!CONDITION_EXTENSIONS.some((ext) => lower.endsWith(ext))) throw userError('twoba_file_type', 'A condition file is an ICC file (.txt or .icc) or an INSBOU/DICO file (.xml).');
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const answer = await twobaApi(conn, 'POST', '/CompanyConditionsUpload/UploadFileToDatabase', {
        streaming: true,
        query: { databaseId: args.databaseId },
        timeoutMs: UPLOAD_TIMEOUT_MS,
        form: () => {
            const form = new FormData();
            form.append('process', args.process);
            form.append('file', new Blob([new Uint8Array(file.buffer)]), file.filename);
            return form;
        },
    });
    const files = importFiles(answer);
    const result = importResult(answer);
    return {
        ok: files.length > 0 ? files.every((f) => !f.error) : !!result,
        databaseId: args.databaseId, process: args.process, filename: file.filename, size: file.size, sha256,
        uploadedAt: new Date().toISOString(), files, ...(result ? { importResult: result } : {}),
    };
}

// ─── Dispatch ────────────────────────────────────────────────────

type Handler = (conn: Connection, args: never, ctx: RunContext) => Promise<Raw>;
const HANDLERS: Record<string, { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: Array<{ message: string }> } } }; run: Handler }> = {
    twoba_find_trade_items: { schema: FindItemsArgs, run: findItems as Handler },
    twoba_net_price: { schema: NetPriceArgs, run: oneNetPrice as Handler },
    twoba_list_condition_databases: { schema: ListDatabasesArgs, run: listDatabases as Handler },
    twoba_upload_conditions: { schema: UploadArgs, run: uploadConditions as Handler },
};

export function isTwobaTool(toolName: string): boolean {
    return TWOBA_TOOL_NAMES.has(toolName);
}

function failure(err: TwobaError): Raw {
    return { error: `2BA: ${err.message}`, code: err.code, status: err.status };
}

/** Run one tool for a user. The result, or `{ error, code, status }` with a sentence that is safe to show. */
export async function executeTwobaTool(toolName: string, args: unknown, userId: string, ctx: RunContext = {}): Promise<Raw> {
    if (!userId) return failure(new TwobaError(401, 'twoba_no_user', 'a signed-in user is needed.'));
    const handler = isTwobaTool(toolName) ? HANDLERS[toolName] : undefined;
    if (!handler) return failure(new TwobaError(400, 'twoba_unknown_tool', `unknown tool ${toolName}.`));
    const parsed = handler.schema.safeParse(args && typeof args === 'object' ? args : {});
    if (!parsed.success) return failure(userError('invalid_arguments', parsed.error?.issues[0]?.message || 'invalid arguments.'));
    const cfg = await configFor(userId);
    if (!isConfigured(cfg)) return failure(new TwobaError(400, 'twoba_not_configured', NOT_CONFIGURED));
    try {
        log.info(`[2BA] ${toolName}`);
        return await handler.run({ userId, cfg }, parsed.data as never, ctx);
    } catch (err) {
        if (err instanceof TwobaError) {
            log.warn(`[2BA] ${toolName} failed (${err.code}, HTTP ${err.status})`);
            return failure(err);
        }
        log.warn(`[2BA] ${toolName} failed (unexpected)`);
        return failure(new TwobaError(502, 'twoba_failed', 'the request failed.'));
    }
}

// ─── Connection test ─────────────────────────────────────────────

export interface TestOutcome { ok: boolean; companyName?: string | null; databaseName?: string | null; error?: string; code?: string }

/** A password-mode token straight from the form values: an unsaved connection is never cached. */
async function statusWithPassword(cfg: TwobaConfig): Promise<unknown> {
    const { accessToken } = await passwordToken(cfg);
    const response = await twobaFetch(`${API_BASE}/CompanyConditions/currentUserStatus`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    const body = await safeText(response);
    if (!response.ok) throw errorForStatus(response.status, body);
    try { return JSON.parse(body) as unknown; } catch { return null; }
}

/** Who the connection prices as: the company and the connected OCS database. */
export async function testTwobaConnection(userId: string, cfg: TwobaConfig): Promise<TestOutcome> {
    if (!isConfigured(cfg)) return { ok: false, error: NOT_CONFIGURED, code: 'twoba_not_configured' };
    try {
        const answer = cfg.mode === 'password' ? await statusWithPassword(cfg) : await twobaApi({ userId, cfg }, 'GET', '/CompanyConditions/currentUserStatus');
        const s = (answer && typeof answer === 'object' ? answer : {}) as Raw;
        return { ok: true, companyName: text(s.Companyname), databaseName: text(s.Databasename) };
    } catch (err) {
        if (!(err instanceof TwobaError)) return { ok: false, error: 'Could not connect to 2BA.' };
        log.warn(`[2BA] connection test failed (${err.code}, HTTP ${err.status})`);
        return { ok: false, error: err.message, code: err.code };
    }
}

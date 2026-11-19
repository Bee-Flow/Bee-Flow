/**
 * twobaLookup.mts: the 2BA reads behind twoba_find_trade_items and
 * twoba_net_price, with as few calls as the API allows.
 *
 *   - Lines with an article number: one POST /TradeItem/forGLNAndTradeItemIds
 *     per 2000 numbers (the documented maximum), paged with resultOffset /
 *     NextOffset while MoreAvailable. That answer carries no OCS net price.
 *   - Lines with only a GTIN (or both codes, to compare them): one
 *     GET /TradeItem/DetailsForTradeItem?gtinArticle&supplierGLNs per GTIN.
 *   - The net price per matched trade item: GET
 *     /TradeItem/netpriceByGLNAndTradeItemIdA (projectnumber, orderQuantity),
 *     the call that returns NetPricePerUseUnit and takes a project number.
 *     Identical (article, quantity) pairs are asked once.
 *
 * Per-line calls run at most CONCURRENCY at a time. A 404 is "nothing found";
 * a 400 on one price marks that line (price_lookup_failed); a refused sign-in
 * or a 2BA outage ends the whole call.
 */

import { twobaApi, type Connection } from './twobaApi.mts';
import { TwobaError } from './twobaTransport.mts';
import { isValidGtin, normalisePrice, normaliseTradeItem, sameUnit, today, type PriceOut, type TradeItemOut } from './twobaPricing.mts';
import { classifyMatch, priceLine, summarise, type LinePrice, type MatchResult, type Summary } from './twobaLines.mts';
import type { FindItemsInput } from './twobaToolDefs.mts';

export const CONCURRENCY = 4;
export const IDS_PER_REQUEST = 2000;
export const RESULT_LIMIT = 1000;
const MAX_PAGES = 100;
const MAX_CANDIDATES = 10;

type Raw = Record<string, unknown>;

/** `fn` over `values`, at most `limit` at a time, results in input order. */
export async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(values.length);
    let next = 0;
    const worker = async () => {
        while (next < values.length) {
            const i = next;
            next += 1;
            out[i] = await fn(values[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
    return out;
}

const key = (id: string) => id.trim().toUpperCase();

function forSupplier(list: unknown, gln: string): TradeItemOut[] {
    return (Array.isArray(list) ? list : [])
        .filter((r): r is Raw => !!r && typeof r === 'object')
        .map(normaliseTradeItem)
        .filter((t) => !t.supplierGln || t.supplierGln === gln);
}

/** Trade items per article number (upper-cased). */
export async function lookupByIds(conn: Connection, gln: string, ids: string[]): Promise<Map<string, TradeItemOut[]>> {
    const found = new Map<string, TradeItemOut[]>();
    for (let start = 0; start < ids.length; start += IDS_PER_REQUEST) {
        const chunk = ids.slice(start, start + IDS_PER_REQUEST);
        let offset: number | undefined;
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const answer = (await twobaApi(conn, 'POST', '/TradeItem/forGLNAndTradeItemIds', {
                json: { gln, tradeitemids: chunk, resultLimit: RESULT_LIMIT, ...(offset === undefined ? {} : { resultOffset: offset }) },
            }) || {}) as Raw;
            for (const t of forSupplier(answer.TradeItems, gln)) {
                if (!t.tradeItemId) continue;
                const list = found.get(key(t.tradeItemId)) || [];
                if (!list.some((x) => x.id !== null && x.id === t.id)) list.push(t);
                found.set(key(t.tradeItemId), list);
            }
            const nextOffset = Number(answer.NextOffset);
            if (answer.MoreAvailable !== true || !Number.isFinite(nextOffset)) break;
            offset = nextOffset;
        }
    }
    return found;
}

/** Trade items of this supplier with this GTIN (a 404 is none). */
export async function lookupGtin(conn: Connection, gln: string, gtin: string): Promise<TradeItemOut[]> {
    try {
        const answer = await twobaApi(conn, 'GET', '/TradeItem/DetailsForTradeItem', { query: { gtinArticle: gtin, supplierGLNs: gln } });
        return forSupplier(answer, gln);
    } catch (err) {
        if (err instanceof TwobaError && err.status === 404) return [];
        throw err;
    }
}

export type PriceAnswer = { price: PriceOut | null; failed?: string };

/** The OCS net price of one trade item: null when 2BA has none (404), `failed` on a 400. */
export async function netPrice(conn: Connection, gln: string, tradeItemId: string, projectNumber?: string, orderQuantity?: number): Promise<PriceAnswer> {
    try {
        const answer = await twobaApi(conn, 'GET', '/TradeItem/netpriceByGLNAndTradeItemIdA', {
            query: { gln, tradeitemid: tradeItemId, projectnumber: projectNumber, orderQuantity },
        });
        return { price: answer && typeof answer === 'object' ? normalisePrice(answer as Raw) : null };
    } catch (err) {
        if (err instanceof TwobaError && err.status === 404) return { price: null };
        if (err instanceof TwobaError && err.status === 400) return { price: null, failed: err.message };
        throw err;
    }
}

// ─── twoba_find_trade_items ──────────────────────────────────────

type Line = FindItemsInput['items'][number] & { ref: string; validGtin?: string; invalidGtin: boolean };

function candidate(t: TradeItemOut) {
    return { tradeItemId: t.tradeItemId, gtin: t.gtin, description: t.description, packageTypeCode: t.packageTypeCode, quantityOfUseUnits: t.quantityOfUseUnits, useUnit: t.useUnit.code, statusCode: t.statusCode };
}

/** The order quantity for 2BA's quantity breaks: only when the line counts in the order unit. */
function orderQuantityFor(item: TradeItemOut, quantity?: number): number | undefined {
    return quantity !== undefined && sameUnit(item.orderUnit.code, item.useUnit.code) ? quantity : undefined;
}

export interface FoundLine extends Record<string, unknown> {
    status: MatchResult['status'];
    flags: string[];
    lineTotalExVat: number | null;
    currency: string | null;
}

function prepare(args: FindItemsInput): Line[] {
    return args.items.map((it, i) => {
        const gtin = it.gtin === undefined ? undefined : it.gtin.split(' ').join('');
        const valid = !!gtin && isValidGtin(gtin);
        return { ...it, ref: it.ref ?? String(i + 1), validGtin: valid ? gtin : undefined, invalidGtin: !!gtin && !valid };
    });
}

async function matchLines(conn: Connection, gln: string, lines: Line[]): Promise<MatchResult[]> {
    const ids = [...new Set(lines.map((l) => l.tradeItemId).filter((v): v is string => !!v).map(key))];
    const gtins = [...new Set(lines.map((l) => l.validGtin).filter((v): v is string => !!v))];
    const byId = ids.length ? await lookupByIds(conn, gln, ids) : new Map<string, TradeItemOut[]>();
    const gtinHits = await mapLimit(gtins, CONCURRENCY, (g) => lookupGtin(conn, gln, g));
    const byGtin = new Map(gtins.map((g, i) => [g, gtinHits[i]]));
    return lines.map((l) => classifyMatch(
        l.tradeItemId ? byId.get(key(l.tradeItemId)) || [] : undefined,
        l.validGtin ? byGtin.get(l.validGtin) || [] : undefined,
        l.validGtin || '',
    ));
}

interface PriceRequest { tradeItemId: string; orderQuantity?: number }

/** One price request per distinct (article, order quantity); `keyOf[i]` is line i's request, or null. */
async function priceMatches(conn: Connection, args: FindItemsInput, lines: Line[], matches: MatchResult[]): Promise<Array<PriceAnswer | undefined>> {
    const requests = new Map<string, PriceRequest>();
    const keyOf = matches.map((m, i) => {
        if (!m.item?.tradeItemId) return null;
        const orderQuantity = orderQuantityFor(m.item, lines[i].quantity);
        const k = `${m.item.tradeItemId}\u0000${orderQuantity ?? ''}`;
        if (!requests.has(k)) requests.set(k, { tradeItemId: m.item.tradeItemId, orderQuantity });
        return k;
    });
    const list = [...requests.entries()];
    const answers = await mapLimit(list, CONCURRENCY, ([, r]) => netPrice(conn, args.supplierGln, r.tradeItemId, args.projectNumber, r.orderQuantity));
    const byKey = new Map(list.map(([k], i) => [k, answers[i]]));
    return keyOf.map((k) => (k ? byKey.get(k) : undefined));
}

const NOT_PRICED: LinePrice = { unitNetPrice: null, lineTotalExVat: null, flags: [] };

function lineInput(l: Line): Record<string, unknown> {
    return { tradeItemId: l.tradeItemId ?? null, gtin: l.gtin ?? null, quantity: l.quantity ?? null, unit: l.unit ?? null };
}

function lineOut(l: Line, match: MatchResult, answer: PriceAnswer | undefined, priceDate: string): FoundLine {
    const price = answer?.price ?? null;
    const priced = match.item ? priceLine(match.item, price, l.quantity, l.unit) : NOT_PRICED;
    const extra = [l.invalidGtin && 'invalid_gtin', answer?.failed && 'price_lookup_failed'].filter((f): f is string => typeof f === 'string');
    const out: FoundLine = {
        ref: l.ref,
        status: match.status,
        input: lineInput(l),
        tradeItem: match.item,
        price,
        unitNetPrice: priced.unitNetPrice,
        quantity: l.quantity ?? null,
        lineTotalExVat: priced.lineTotalExVat,
        currency: match.item?.currencyCode ?? null,
        priceDate,
        flags: [...new Set([...match.flags, ...priced.flags, ...extra])],
    };
    if (match.candidates.length) out.candidates = match.candidates.slice(0, MAX_CANDIDATES).map(candidate);
    return out;
}

export async function findTradeItems(conn: Connection, args: FindItemsInput): Promise<{ items: FoundLine[]; summary: Summary; priceDate: string }> {
    const lines = prepare(args);
    const matches = await matchLines(conn, args.supplierGln, lines);
    const answers = await priceMatches(conn, args, lines, matches);
    const priceDate = today();
    const items = lines.map((l, i) => lineOut(l, matches[i], answers[i], priceDate));
    return { items, summary: summarise(items), priceDate };
}

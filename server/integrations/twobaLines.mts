/**
 * twobaLines.mts: how one line of a bill of materials is matched to a 2BA trade
 * item and priced, and the summary of a whole list. Pure, like twobaPricing.mts
 * (whose values it uses): the lookups themselves are twobaTools.mts.
 *
 * Matching, per line:
 *   - only a trade item id (the supplier's article number) or only a GTIN: no
 *     hit is not_found, one hit matched, more than one multiple;
 *   - both: several hits for the article number are narrowed by the GTIN. When
 *     the two codes lead to different trade items (another internal id, or the
 *     same article number with another packaging) the line is code_mismatch and
 *     flagged codes_disagree: the article number decides which item is priced,
 *     the GTIN hits come back as candidates. A code that finds nothing while
 *     the other one does is a flag on a matched line (gtin_not_found,
 *     trade_item_id_not_found).
 *
 * Flags (a line can carry several): no_price, price_on_request (the trade item
 * says so), gross_only_no_condition (scenario 5: no condition matched, the gross
 * price is all there is), on_request (scenario 6), unit_unknown, unit_mismatch,
 * multiple_matches, codes_disagree, discontinued (status 94E; the successor is
 * on the trade item), price_calc_mismatch, invalid_gtin, gtin_not_found,
 * trade_item_id_not_found, price_lookup_failed.
 */

import {
    DISCONTINUED_STATUS, normaliseUnit, roundCents, sameGtin, sameUnit, STATUSES,
    type MatchStatus, type PriceOut, type TradeItemOut,
} from './twobaPricing.mts';

export interface MatchResult {
    status: MatchStatus;
    item: TradeItemOut | null;
    candidates: TradeItemOut[];
    flags: string[];
}

/** One trade item seen twice: the same internal id, else the same article number and packaging. */
export function sameTradeItem(a: TradeItemOut, b: TradeItemOut): boolean {
    if (a.id !== null && b.id !== null) return a.id === b.id;
    return !!a.tradeItemId && (a.tradeItemId || '').toUpperCase() === (b.tradeItemId || '').toUpperCase()
        && a.packageTypeCode === b.packageTypeCode && a.quantityOfUseUnits === b.quantityOfUseUnits;
}

function fromList(list: TradeItemOut[]): MatchResult {
    if (list.length === 0) return { status: 'not_found', item: null, candidates: [], flags: [] };
    if (list.length === 1) return { status: 'matched', item: list[0], candidates: [], flags: [] };
    return { status: 'multiple', item: null, candidates: list, flags: ['multiple_matches'] };
}

function fromBoth(byId: TradeItemOut[], byGtin: TradeItemOut[], gtin: string): MatchResult {
    let ids = byId;
    if (ids.length > 1) {
        const narrowed = ids.filter((i) => sameGtin(i.gtin, gtin));
        if (narrowed.length === 1) ids = narrowed;
    }
    if (ids.length > 1) return fromList(ids);
    if (ids.length === 0) {
        const result = fromList(byGtin);
        if (result.status !== 'not_found') result.flags.push('trade_item_id_not_found');
        return result;
    }
    const item = ids[0];
    if (byGtin.length === 0) return { status: 'matched', item, candidates: [], flags: ['gtin_not_found'] };
    if (byGtin.some((g) => sameTradeItem(g, item))) return { status: 'matched', item, candidates: [], flags: [] };
    return { status: 'code_mismatch', item, candidates: byGtin, flags: ['codes_disagree'] };
}

/**
 * The match of one line. `byId` / `byGtin` are the hits per code, undefined
 * when the line did not carry that code.
 */
export function classifyMatch(byId: TradeItemOut[] | undefined, byGtin: TradeItemOut[] | undefined, gtin = ''): MatchResult {
    if (byId && byGtin) return fromBoth(byId, byGtin, gtin);
    return fromList(byId ?? byGtin ?? []);
}

// ─── Price of a line ─────────────────────────────────────────────

/** The flags the trade item and the price result carry by themselves. */
export function priceFlags(item: TradeItemOut | null, price: PriceOut | null): string[] {
    const flags: string[] = [];
    if (item?.statusCode === DISCONTINUED_STATUS) flags.push('discontinued');
    if (item?.priceOnRequestIndicator) flags.push('price_on_request');
    if (price?.scenario === 5) flags.push('gross_only_no_condition');
    if (price?.scenario === 6) flags.push('on_request');
    return flags;
}

export interface UnitPrice {
    /** Net price per use unit; null when there is none (also for 0 and for a price on request). */
    value: number | null;
    /** NetPricePerUseUnit and NetPriceInPriceUnit / NumberOfUnitsInPriceBasis differ by more than a cent. */
    mismatch: boolean;
}

const CENT = 0.01 + 1e-9;

/** The net price per use unit, and whether 2BA's two ways to it agree. */
export function unitNetPriceOf(item: TradeItemOut | null, price: PriceOut | null): UnitPrice {
    if (!price) return { value: null, mismatch: false };
    const perUse = price.netPricePerUseUnit;
    const basis = item?.numberOfUnitsInPriceBasis ?? null;
    const comparable = !!item && sameUnit(item.priceUnit.code, item.useUnit.code);
    const derived = comparable && price.netPriceInPriceUnit !== null && basis !== null && basis > 0
        ? price.netPriceInPriceUnit / basis : null;
    const value = perUse ?? derived;
    const mismatch = perUse !== null && derived !== null && Math.abs(perUse - derived) > CENT;
    return { value: value !== null && value > 0 ? value : null, mismatch };
}

/** The line's unit against the item's use unit: no flag when the line names no unit (quantity in use units). */
export function unitFlag(item: TradeItemOut | null, unit: string | undefined): 'unit_unknown' | 'unit_mismatch' | null {
    if (unit === undefined || String(unit).trim() === '') return null;
    const code = normaliseUnit(unit);
    if (!code || !item?.useUnit.code) return 'unit_unknown';
    return sameUnit(code, item.useUnit.code) ? null : 'unit_mismatch';
}

export interface LinePrice {
    unitNetPrice: number | null;
    lineTotalExVat: number | null;
    flags: string[];
}

/** Unit net price, line total (cents, rounded once) and the flags of a matched line. */
export function priceLine(item: TradeItemOut | null, price: PriceOut | null, quantity?: number, unit?: string): LinePrice {
    const flags = priceFlags(item, price);
    const onRequest = flags.includes('price_on_request') || flags.includes('on_request');
    const unitPrice = unitNetPriceOf(item, price);
    if (unitPrice.mismatch) flags.push('price_calc_mismatch');
    const unitNetPrice = onRequest ? null : unitPrice.value;
    if (unitNetPrice === null && !onRequest) flags.push('no_price');
    const unitProblem = unitFlag(item, unit);
    if (unitProblem) flags.push(unitProblem);
    const lineTotalExVat = quantity !== undefined && unitNetPrice !== null && !unitProblem
        ? roundCents(quantity * unitNetPrice) : null;
    return { unitNetPrice, lineTotalExVat, flags };
}

// ─── Summary ─────────────────────────────────────────────────────

export interface SummaryLine {
    status: MatchStatus;
    flags: string[];
    lineTotalExVat: number | null;
    currency?: string | null;
}

export interface Summary {
    items: number;
    byStatus: Record<MatchStatus, number>;
    byFlag: Record<string, number>;
    pricedLines: number;
    linesNeedingReview: number;
    totalExVat: number;
    currency: string | null;
}

/** Counts per status and flag, and the total of the priced lines (summed in cents). */
export function summarise(lines: SummaryLine[]): Summary {
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<MatchStatus, number>;
    const byFlag: Record<string, number> = {};
    const currencies = new Set<string>();
    let cents = 0;
    let priced = 0;
    let review = 0;
    for (const line of lines) {
        byStatus[line.status] += 1;
        for (const f of line.flags) byFlag[f] = (byFlag[f] || 0) + 1;
        if (line.status !== 'matched' || line.flags.length) review += 1;
        if (line.lineTotalExVat !== null) {
            priced += 1;
            cents += Math.round(line.lineTotalExVat * 100);
        }
        if (line.currency) currencies.add(line.currency);
    }
    return {
        items: lines.length, byStatus, byFlag, pricedLines: priced, linesNeedingReview: review,
        totalExVat: cents / 100, currency: currencies.size === 1 ? [...currencies][0] : null,
    };
}

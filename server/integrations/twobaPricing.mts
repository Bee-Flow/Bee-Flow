/**
 * twobaPricing.mts: the pure half of the 2BA integration. No I/O: everything
 * here takes the answers 2BA gave (trade items, price results) and the line of
 * a bill of materials, and decides what the line costs and what needs a look.
 *
 * 2BA computes the net price itself, from the condition files the customer
 * loaded into its Online Condition Server (OCS); this module only reads that
 * answer per use unit and multiplies:
 *
 *   - unit net price = NetPricePerUseUnit. A cable priced "EUR 125.50 per 100 m"
 *     has NetPriceInPriceUnit 125.50 and NumberOfUnitsInPriceBasis 100, so the
 *     price per metre is 1.255 and 30 m cost 30 x 1.255 = 37.65.
 *   - The same figure is recomputed as NetPriceInPriceUnit / NumberOfUnitsInPriceBasis
 *     when the price unit and the use unit are the same unit; a difference of
 *     more than a cent is flagged (price_calc_mismatch), never corrected.
 *   - line total excl. VAT = quantity x unit net price, rounded to cents at the
 *     end only. No total when the line's unit is unknown or is not the use unit.
 *
 * Units of a bill of materials (m, mtr, st, stuks, pcs, rol, doos, ...) are
 * normalised to UN/ECE Recommendation 20 codes (MTR, C62, RO, BX, ...) and
 * compared with UseUnitMeasureUnitCode; the piece codes C62, PCE, EA and H87
 * count as one unit.
 *
 * The GLN and GTIN checks are the GS1 mod-10 check digit.
 */

export const SCENARIO_NAMES: Readonly<Record<number, string>> = Object.freeze({
    1: 'NetPrice',
    2: 'DiscountArticlePercentage',
    3: 'DiscountGroupPercentage',
    4: 'OriginalNetPrice',
    5: 'OriginalGrossPrice',
    6: 'OnRequest',
    7: 'DirectlyFromSupplier',
});

export const STATUSES = ['matched', 'not_found', 'multiple', 'code_mismatch'] as const;
export type MatchStatus = typeof STATUSES[number];

/** StatusCode of a trade item that is no longer supplied (84E new, 126 regular). */
export const DISCONTINUED_STATUS = '94E';

// ─── Codes ───────────────────────────────────────────────────────

function digitsOnly(text: string): boolean {
    if (!text) return false;
    for (const ch of text) if (ch < '0' || ch > '9') return false;
    return true;
}

/** GS1 mod-10: the last digit checks the others (weights 3, 1, 3, ... from the right). */
export function hasValidCheckDigit(code: string): boolean {
    if (!digitsOnly(code) || code.length < 2) return false;
    let sum = 0;
    for (let i = code.length - 2, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) sum += Number(code[i]) * w;
    return (10 - (sum % 10)) % 10 === Number(code[code.length - 1]);
}

/** A GLN: 13 digits with a valid check digit. */
export function isValidGln(value: unknown): boolean {
    return typeof value === 'string' && value.length === 13 && hasValidCheckDigit(value);
}

/** A GTIN-8, -12, -13 or -14 with a valid check digit. */
export function isValidGtin(value: unknown): boolean {
    return typeof value === 'string' && [8, 12, 13, 14].includes(value.length) && hasValidCheckDigit(value);
}

/** The same GTIN written with or without leading zeros (EAN-13 vs GTIN-14). */
export function sameGtin(a: unknown, b: unknown): boolean {
    const strip = (v: unknown) => {
        const s = String(v ?? '').trim();
        let i = 0;
        while (i < s.length && s[i] === '0') i += 1;
        return s.slice(i);
    };
    return !!strip(a) && strip(a) === strip(b);
}

// ─── Units ───────────────────────────────────────────────────────

const PIECE = 'C62';
/** UN/ECE rec 20 codes that all mean "one piece". */
const PIECE_CODES = new Set(['C62', 'PCE', 'EA', 'H87', 'NAR', 'NPR']);

/** What people write in a bill of materials, lower-cased, to a UN/ECE rec 20 code. */
const UNIT_WORDS: Readonly<Record<string, string>> = Object.freeze({
    m: 'MTR', mtr: 'MTR', mtrs: 'MTR', meter: 'MTR', meters: 'MTR', metre: 'MTR', metres: 'MTR', m1: 'MTR', mt: 'MTR', 'm¹': 'MTR',
    st: PIECE, stk: PIECE, stuk: PIECE, stuks: PIECE, pcs: PIECE, pc: PIECE, pce: PIECE, piece: PIECE, pieces: PIECE,
    ea: PIECE, each: PIECE, x: PIECE, c62: PIECE, h87: PIECE,
    rol: 'RO', rollen: 'RO', roll: 'RO', rolls: 'RO', ro: 'RO',
    doos: 'BX', dozen: 'BX', ds: 'BX', box: 'BX', boxes: 'BX', bx: 'BX',
    pak: 'PK', pakken: 'PK', pack: 'PK', packs: 'PK', pk: 'PK',
    set: 'SET', sets: 'SET',
    paar: 'PR', pair: 'PR', pairs: 'PR', pr: 'PR',
    kg: 'KGM', kilo: 'KGM', kilogram: 'KGM', kgm: 'KGM',
    g: 'GRM', gram: 'GRM', grm: 'GRM',
    l: 'LTR', ltr: 'LTR', liter: 'LTR', litre: 'LTR', liters: 'LTR', litres: 'LTR',
    m2: 'MTK', 'm²': 'MTK', mtk: 'MTK', m3: 'MTQ', 'm³': 'MTQ', mtq: 'MTQ',
    cm: 'CMT', cmt: 'CMT', mm: 'MMT', mmt: 'MMT', km: 'KMT', kmt: 'KMT',
    uur: 'HUR', hour: 'HUR', hours: 'HUR', hur: 'HUR',
});

/** A bill-of-materials unit as its UN/ECE code, or null when it is not recognised. */
export function normaliseUnit(raw: unknown): string | null {
    let text = String(raw ?? '').trim().toLowerCase();
    while (text.endsWith('.')) text = text.slice(0, -1);
    text = text.split(' ').filter(Boolean).join(' ');
    if (!text) return null;
    if (UNIT_WORDS[text]) return UNIT_WORDS[text];
    const upper = text.toUpperCase();
    return PIECE_CODES.has(upper) ? PIECE : null;
}

/** Two UN/ECE codes for the same unit (the piece codes are one unit). */
export function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    const x = a.trim().toUpperCase();
    const y = b.trim().toUpperCase();
    return x === y || (PIECE_CODES.has(x) && PIECE_CODES.has(y));
}

// ─── Values from 2BA ─────────────────────────────────────────────

type Raw = Record<string, unknown>;

/** A finite number, or null (2BA leaves many decimals empty). */
export function num(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s ? s : null;
}

/** A 2BA date ("/Date(1700000000000)/", an ISO text or epoch ms) as an ISO text, else null. */
export function isoDate(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    let ms: number | null = null;
    if (typeof value === 'number') ms = value;
    else {
        const s = String(value).trim();
        const open = s.indexOf('/Date(');
        if (open >= 0) {
            const inner = s.slice(open + 6, s.indexOf(')', open));
            const end = [inner.indexOf('+', 1), inner.indexOf('-', 1)].filter((i) => i > 0);
            ms = Number(end.length ? inner.slice(0, Math.min(...end)) : inner);
        } else ms = Date.parse(s);
    }
    if (ms === null || !Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
}

/** The scenario as its number and its name; 2BA sends either. */
export function scenarioOf(value: unknown): { scenario: number | null; scenarioName: string | null } {
    const n = num(value);
    if (n !== null && SCENARIO_NAMES[n]) return { scenario: n, scenarioName: SCENARIO_NAMES[n] };
    const name = text(value);
    if (!name) return { scenario: null, scenarioName: null };
    const found = Object.entries(SCENARIO_NAMES).find(([, v]) => v.toLowerCase() === name.toLowerCase());
    return found ? { scenario: Number(found[0]), scenarioName: found[1] } : { scenario: null, scenarioName: name };
}

export interface UnitOut { code: string | null; description: string | null }

export interface TradeItemOut {
    id: number | null;
    tradeItemId: string | null;
    gtin: string | null;
    description: string | null;
    supplierGln: string | null;
    statusCode: string | null;
    successorTradeItemCode: string | null;
    successorGtin: string | null;
    useUnit: UnitOut;
    orderUnit: UnitOut;
    priceUnit: UnitOut;
    numberOfUnitsInPriceBasis: number | null;
    priceToOrderUnitFactor: number | null;
    quantityOfUseUnits: number | null;
    minimumOrderQuantity: number | null;
    orderMultiple: number | null;
    packageTypeCode: string | null;
    packageTypeDescription: string | null;
    priceOnRequestIndicator: boolean;
    startDatePriceInformation: string | null;
    vatPercentage: number | null;
    currencyCode: string | null;
}

/** The fields of a 2BA TradeItemModel this integration passes on, camelCased. */
export function normaliseTradeItem(raw: Raw): TradeItemOut {
    const unit = (prefix: string): UnitOut => ({ code: text(raw[`${prefix}MeasureUnitCode`]), description: text(raw[`${prefix}MeasureUnitDescription`]) });
    return {
        id: num(raw.Id),
        tradeItemId: text(raw.TradeItemId),
        gtin: text(raw.GTIN),
        description: text(raw.Description),
        supplierGln: text(raw.SupplierGLN),
        statusCode: text(raw.StatusCode),
        successorTradeItemCode: text(raw.SuccessorTradeItemCode),
        successorGtin: text(raw.SuccessorGTIN),
        useUnit: unit('UseUnit'),
        orderUnit: unit('OrderUnit'),
        priceUnit: unit('PriceUnit'),
        numberOfUnitsInPriceBasis: num(raw.NumberOfUnitsInPriceBasis),
        priceToOrderUnitFactor: num(raw.PriceToOrderUnitFactor),
        quantityOfUseUnits: num(raw.QuantityOfUseUnits),
        minimumOrderQuantity: num(raw.MinimumOrderQuantity),
        orderMultiple: num(raw.OrderMultiple),
        packageTypeCode: text(raw.PackageTypeCode),
        packageTypeDescription: text(raw.PackageTypeDescription),
        priceOnRequestIndicator: raw.PriceOnRequestIndicator === true,
        startDatePriceInformation: isoDate(raw.StartDatePriceInformation),
        vatPercentage: num(raw.VatPercentage),
        currencyCode: text(raw.CurrencyCode),
    };
}

export interface PriceOut {
    grossPriceInPriceUnit: number | null;
    netPriceInPriceUnit: number | null;
    netPriceInOrderUnit: number | null;
    netPricePerUseUnit: number | null;
    netPriceOnMinimumQuantity: number | null;
    discountPercentage: number | null;
    conditionId: number | null;
    scenario: number | null;
    scenarioName: string | null;
    termsType: string | null;
}

/** A 2BA PriceResultDto, camelCased, the scenario as number and name. */
export function normalisePrice(raw: Raw): PriceOut {
    return {
        grossPriceInPriceUnit: num(raw.GrossPriceInPriceUnit),
        netPriceInPriceUnit: num(raw.NetPriceInPriceUnit),
        netPriceInOrderUnit: num(raw.NetPriceInOrderUnit),
        netPricePerUseUnit: num(raw.NetPricePerUseUnit),
        netPriceOnMinimumQuantity: num(raw.NetPriceOnMinimumQuantity),
        discountPercentage: num(raw.DiscountPercentage),
        conditionId: num(raw.ConditionId),
        ...scenarioOf(raw.Scenario),
        termsType: text(raw.TermsType),
    };
}

// ─── Money ───────────────────────────────────────────────────────

/** Round to cents, half away from zero, after removing float noise (2.675 -> 2.68). */
export function roundCents(value: number): number {
    const cents = Number((value * 100).toFixed(6));
    return Math.sign(cents) * Math.round(Math.abs(cents)) / 100;
}

/** Today as YYYY-MM-DD (the date a price was asked for). */
export function today(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

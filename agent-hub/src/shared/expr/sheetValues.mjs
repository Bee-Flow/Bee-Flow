// @typecheck strict
/**
 * What a typed (non-formula) spreadsheet cell holds - a number, TRUE/FALSE,
 * text or nothing - read the way the sheet's people write numbers. Used by
 * sheet.mjs; shared with the browser like the rest of shared/expr (the
 * agent-hub copy is GENERATED, `npm run gen:shared`).
 *
 * Every locale reads the plain form the engine has always read (`1.5`,
 * `-3`, `2e3`): that is what an import, the assistant and an automation
 * write, so a value written by a machine means the same in every sheet. On
 * top of it a sheet's locale (`settings.sheet.locale`, the same for every
 * reader of that sheet) reads what people type:
 *
 *   nl: 1,5   -3,2   1.234,56   1.234.567   € 10   €10,50   10,50 €   10%
 *   en: 1,234.56   $10   €10   10%
 *
 * Anything else stays text: dates (1-2-2025), phone numbers (06-12345678),
 * a number with a unit (1,5 kg). In an nl sheet `1.234` is the plain form,
 * so 1.234 (a thousands dot needs a decimal comma or a second group:
 * `1.234,0`, `1.234.567`, or a currency sign: `€ 1.234`).
 *
 * Inside a FORMULA numbers stay `1.5` in every locale: a comma there
 * separates arguments.
 *
 * @module sheetValues
 */

/** The plain numeric literal every locale reads. */
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** The number part of a typed value, per locale: grouped thousands, or none. */
const BODIES = {
    nl: { grouped: /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/, plain: /^(?:\d+(?:,\d+)?|,\d+)$/, group: '.', decimal: ',' },
    en: { grouped: /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/, plain: /^(?:\d+(?:\.\d+)?|\.\d+)$/, group: ',', decimal: '.' },
};
const CURRENCY = new Set(['€', '$', '£']);

/**
 * The engine's locale for a stored or reader locale: 'nl' for Dutch, 'en' for everything else.
 * @param {unknown} locale
 * @returns {'nl'|'en'}
 */
export function sheetLocale(locale) {
    return typeof locale === 'string' && locale.trim().toLowerCase().startsWith('nl') ? 'nl' : 'en';
}

/**
 * Number from plain numeric text, or null when the text is not a (finite) plain literal.
 * @param {string} s
 * @returns {number|null}
 */
export function numericText(s) {
    const t = s.trim();
    if (!NUMERIC_RE.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

/** Drop binary floating noise (15 significant digits). */
const clean = (/** @type {number} */ n) => Number(n.toPrecision(15));

/**
 * Peel one sign, one currency sign (before or after) or one percent sign off `t`.
 * @param {string} t trimmed
 * @returns {{ body: string, negative: boolean, currency: boolean, percent: boolean }}
 */
function peel(t) {
    let s = t;
    let negative = false;
    let currency = false;
    const sign = () => {
        if (s[0] === '-' || s[0] === '+') { negative = s[0] === '-'; s = s.slice(1).trimStart(); return true; }
        return false;
    };
    const signed = sign();
    if (CURRENCY.has(s[0])) { currency = true; s = s.slice(1).trimStart(); }
    else if (CURRENCY.has(s[s.length - 1])) { currency = true; s = s.slice(0, -1).trimEnd(); }
    if (currency && !signed) sign();
    const percent = !currency && s.endsWith('%');
    if (percent) s = s.slice(0, -1).trimEnd();
    return { body: s, negative, currency, percent };
}

/**
 * The number in the body of a typed value, per locale; null when it is not one.
 * @param {string} body
 * @param {'nl'|'en'} locale
 * @returns {number|null}
 */
function bodyNumber(body, locale) {
    const rule = BODIES[locale];
    let plain = null;
    if (rule.grouped.test(body)) plain = body.split(rule.group).join('').replace(rule.decimal, '.');
    else if (rule.plain.test(body)) plain = body.replace(rule.decimal, '.');
    else if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(body)) plain = body; // `€1.50` in an nl sheet
    if (plain === null) return null;
    const n = Number(plain);
    return Number.isFinite(n) ? n : null;
}

/**
 * A typed value as a number, the way people of `locale` write numbers; null when it is text.
 * @param {string} text
 * @param {unknown} [locale] 'nl' or 'en' (anything else reads as 'en')
 * @returns {number|null}
 */
export function localeNumber(text, locale) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (!t) return null;
    const plain = numericText(t);
    if (plain !== null) return plain;
    const { body, negative, percent } = peel(t);
    const n = body ? bodyNumber(body, sheetLocale(locale)) : null;
    if (n === null) return null;
    const signed = negative ? -n : n;
    return clean(percent ? signed / 100 : signed) || 0;
}

/**
 * Interpret raw non-formula input: '' is empty, a number (see localeNumber),
 * TRUE/FALSE (any case), else text. `shown` is set when the number was typed
 * in another form than the engine would print it (`1,5`, `€ 10`, `10%`), so
 * the cell keeps showing what was typed.
 * @param {string} raw
 * @param {unknown} [locale]
 * @returns {{ value: number|string|boolean|null, error: null, shown?: string }}
 */
export function readConstant(raw, locale) {
    if (raw === '') return { value: null, error: null };
    const plain = numericText(raw);
    if (plain !== null) return { value: plain, error: null };
    const n = localeNumber(raw, locale);
    if (n !== null) return { value: n, error: null, shown: raw };
    const up = raw.trim().toUpperCase();
    if (up === 'TRUE') return { value: true, error: null };
    if (up === 'FALSE') return { value: false, error: null };
    return { value: raw, error: null };
}

// @typecheck
/**
 * Dates in the spreadsheet engine (sheet.mjs). Excel keeps a date as a serial
 * number (days since its 1900 epoch); Bee Flow keeps what was typed, and an
 * imported workbook's dates arrive as ISO text ("1957-09-17"). So a
 * workbook's `">="&D19` or YEAR(K2) can still compare and count them, ISO
 * text reads as its serial wherever a date is expected.
 */

/** Excel's 1900 date-system epoch (serial 0 = 1899-12-30) in UTC milliseconds. */
export const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** The serial number of a calendar date (month 1–12). */
export function makeSerial(year, month, day) {
    return (Date.UTC(year, month - 1, day) - EXCEL_EPOCH) / 86400000;
}

/** A serial number's year, month (1–12) and day. */
export function serialParts(serial) {
    const d = new Date(EXCEL_EPOCH + Math.trunc(serial) * 86400000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An ISO date's Excel serial number; null for anything else, a calendar day
 * that does not exist (30 February) included.
 * @param {unknown} v
 * @returns {number|null}
 */
export function isoDateSerial(v) {
    const m = typeof v === 'string' ? ISO_DATE_RE.exec(v.trim()) : null;
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const back = new Date(Date.UTC(y, mo - 1, d));
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return makeSerial(y, mo, d);
}

/**
 * One cell, both ways: what Nextcloud stores ↔ what the mirror stores.
 *
 * The READ side is forgiving — a value the mirror cannot make sense of becomes
 * text or null, never an error, because a refresh that dies on one odd cell
 * leaves the whole table stale. The WRITE side is exact, and has to be:
 * Nextcloud's RowService parses every value with the column's own business
 * class and, when it CANNOT, stores NULL with only a server-side log line —
 * no error reaches the caller. So a datetime sent in the wrong format is not
 * refused, it is silently blanked. Every shape below was read off Tables
 * 2.3.0's lib/Service/ColumnTypes/*Business.php:
 *   datetime         'Y-m-d H:i' (or ATOM with the +00:00 offset spelled out)
 *   datetime/date    'Y-m-d'
 *   selection        the option id, numeric
 *   selection-multi  an array of numeric option ids
 *   selection/check  a real boolean (PATTERN_POSITIVE is strict in_array)
 *   text/link        the JSON string {title, value, providerId}, or a bare URL
 *   usergroup        the JSON array as-is
 * A label that is not one of the column's options is the one case the WRITE
 * side refuses itself: Nextcloud would blank it, and "the row was saved" with
 * the status gone is worse than a 422.
 */

'use strict';

const { NextcloudSourceError } = require('./errors');

function isBlank(v) {
    return v === null || v === undefined || v === '';
}

function parseJsonMaybe(v) {
    if (typeof v !== 'string') return v;
    const s = v.trim();
    if (!s || !(s.startsWith('[') || s.startsWith('{') || s.startsWith('"'))) return v;
    try { return JSON.parse(s); } catch { return v; }
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
const NC_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

function pad(n) { return String(n).padStart(2, '0'); }

/** Nextcloud's wall-clock 'Y-m-d H:i[:s]' → ISO, read as UTC. */
function ncDateTimeToIso(v) {
    if (typeof v !== 'string') return null;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const m = NC_DATETIME_RE.exec(v);
    if (!m) return null;
    return `${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}.000Z`;
}

/** ISO (or anything Date parses) → 'Y-m-d H:i' in UTC — the one shape Tables keeps. */
function isoToNcDateTime(v) {
    const d = v instanceof Date ? v : new Date(String(v));
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function optionLabel(options, id) {
    const hit = (options || []).find(o => String(o.id) === String(id));
    return hit ? hit.label : null;
}

function optionId(options, label) {
    const hit = (options || []).find(o => o.label === label);
    return hit ? hit.id : null;
}

/**
 * What the mirror stores for one cell.
 * @param {*} value      the raw `value` from a Nextcloud row cell
 * @param {object} entry the columnMap entry ({ncType, ncSubtype, options?})
 * @param {object} field the mirror field ({type})
 */
function cellToLocal(value, entry, field) {
    if (isBlank(value)) return null;
    const type = field && field.type;
    const sub = (entry && entry.ncSubtype) || '';
    switch (entry && entry.ncType) {
        case 'number':
            return Number.isFinite(Number(value)) ? Number(value) : null;
        case 'datetime':
            if (sub === 'date') { const m = DATE_RE.exec(String(value)); return m ? m[1] : null; }
            if (sub === 'time') return String(value);
            return ncDateTimeToIso(String(value));
        case 'selection': {
            if (sub === 'check') return value === true || value === 'true' || value === 1 || value === '1';
            if (sub === 'selection-multi') {
                const ids = parseJsonMaybe(value);
                const list = Array.isArray(ids) ? ids : String(value).split(',').map(s => s.trim()).filter(Boolean);
                if (type !== 'multiselect') return JSON.stringify(list);
                return list.map(id => optionLabel(entry.options, id) ?? String(id));
            }
            if (type !== 'select') return String(parseJsonMaybe(value));
            const id = parseJsonMaybe(value);
            return optionLabel(entry.options, id) ?? String(id);
        }
        case 'relation':
            if (type === 'relation') {
                const n = Number(value);
                return Number.isInteger(n) && n > 0 ? String(n) : null;
            }
            return Number.isFinite(Number(value)) ? Number(value) : null;
        case 'usergroup':
        case 'text':
        default:
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
    }
}

/**
 * What goes on the wire for one cell the caller set in Bee Flow. Throws a
 * 422 NextcloudSourceError for a value Nextcloud would silently blank.
 */
function localToWire(value, entry, field) {
    const ncType = entry && entry.ncType;
    const sub = (entry && entry.ncSubtype) || '';
    const title = (entry && entry.title) || (field && field.name) || (field && field.key) || 'column';
    if (isBlank(value)) {
        // Empty is spelled per type: Tables stores '' for text/date and
        // [] for a multi-selection; null is accepted everywhere.
        if (ncType === 'selection' && sub === 'selection-multi') return [];
        if (ncType === 'selection' && sub === 'check') return false;
        return null;
    }
    switch (ncType) {
        case 'number': {
            const n = Number(value);
            if (!Number.isFinite(n)) throw reject(title, `"${value}" is not a number`);
            return n;
        }
        case 'datetime': {
            if (sub === 'time') return String(value);
            if (sub === 'date') {
                const m = DATE_RE.exec(String(value));
                if (!m) throw reject(title, `"${value}" is not a date (YYYY-MM-DD)`);
                return m[1];
            }
            const s = isoToNcDateTime(value);
            if (!s) throw reject(title, `"${value}" is not a date and time`);
            return s;
        }
        case 'selection': {
            if (sub === 'check') return value === true || value === 'true' || value === 1 || value === '1' || value === 'yes';
            if (sub === 'selection-multi') {
                const labels = Array.isArray(value) ? value : String(value).split(',').map(x => x.trim()).filter(Boolean);
                return labels.map((label) => {
                    const id = optionId(entry.options, String(label));
                    if (id === null) throw reject(title, `"${label}" is not one of its options`);
                    return Number(id);
                });
            }
            const id = optionId(entry.options, String(value));
            if (id === null) {
                // A numeric option id is accepted too — the API's own idiom.
                if (Number.isInteger(Number(value)) && (entry.options || []).some(o => String(o.id) === String(value))) return Number(value);
                throw reject(title, `"${value}" is not one of its options`);
            }
            return Number(id);
        }
        case 'relation': {
            const n = Number(value);
            if (!Number.isInteger(n) || n <= 0) throw reject(title, `"${value}" is not a row id`);
            return n;
        }
        case 'usergroup': {
            const parsed = parseJsonMaybe(value);
            return typeof parsed === 'object' ? parsed : String(value);
        }
        case 'text':
        default:
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
    }
}

function reject(title, why) {
    return new NextcloudSourceError(422, 'nextcloud_rejected', `${title}: ${why}`, { detail: why });
}

module.exports = { cellToLocal, localToWire, ncDateTimeToIso, isoToNcDateTime, parseJsonMaybe };

/**
 * Labels: how a value is named to a person, without any language in it.
 *
 * labelParts turns the segments from a group's base to a value into parts a
 * client renders in its own language:
 *
 *   ['Klant', 'Adres', 'Postcode']  → Klant › Adres › Postcode
 *   ['orders', [*], 'sku']          → Orders · each · Sku   ("Sku van alle orders")
 *   ['lines', 0]                    → Lines · first          ("De eerste line")
 *
 *   { key, text }   an object key and its readable form (humanizeKey)
 *   { index }       a list position; the client words it ("de eerste", "rij 3")
 *   { each: true }  every element of a list (the legacy `[*]`)
 *
 * No path, bracket or `[*]` ever reaches a label; the words "van alle",
 * "eerste" and the separator belong to the client's i18n (namespace
 * `mapping`).
 */

import { isWild } from './source.mjs';

// Lower-case words a key is split into that read as an acronym.
const ACRONYMS = new Set(['id', 'url', 'uri', 'api', 'pdf', 'csv', 'html', 'json', 'xml', 'iban', 'btw', 'kvk', 'vat', 'ip', 'utc', 'uuid', 'sms']);

/**
 * A key as a person reads it. A key someone typed with spaces ("E-mail
 * adres", "Order ID") is already a label and is kept as written; an
 * identifier is split on `_` and camelCase and set in sentence case:
 * `first_name` → "First name", `messageId` → "Message ID".
 * @param {unknown} key
 */
export function humanizeKey(key) {
    const raw = String(key ?? '').trim();
    if (!raw) return '';
    if (/\s/.test(raw)) return raw;
    const words = raw
        .replace(/_+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length) return raw;
    return words
        .map((w, i) => {
            const lower = w.toLowerCase();
            if (ACRONYMS.has(lower)) return lower.toUpperCase();
            // A word written in capitals (AFAS, BSN) stays that way.
            if (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;
            return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
        })
        .join(' ');
}

/**
 * A list's name read as one of its items: "Orderregels" → "Orderregel",
 * "Lines" → "Line", "Categories" → "Category", "Addresses" → "Address".
 * Only the last word changes, and only an -s plural the rule is sure of; any
 * other text ("Klanten", "Status", "Data") is returned as it is.
 * @param {unknown} text
 */
export function singularLabel(text) {
    const s = String(text ?? '').trim();
    const m = /^(.*?)([A-Za-z]{4,})$/.exec(s);
    if (!m) return s;
    const [, head, word] = m;
    const lower = word.toLowerCase();
    let one = word;
    if (lower.endsWith('ies')) one = `${word.slice(0, -3)}${word.endsWith('IES') ? 'Y' : 'y'}`;
    else if (/(ss|sh|ch|x|z)es$/.test(lower)) one = word.slice(0, -2);
    else if (/[^siu]s$/.test(lower)) one = word.slice(0, -1);
    return head + one;
}

/**
 * The name one item of the list `over` goes by: the list's last key, read
 * as one item ("Orderregel" for `orderregels`). Null for a list without a
 * key (a step whose whole output is the list).
 * @param {{ path?: unknown[] } | null | undefined} over — a Source
 */
export function itemNoun(over) {
    const path = over && Array.isArray(over.path) ? over.path : [];
    for (let i = path.length - 1; i >= 0; i--) {
        if (typeof path[i] === 'string' && path[i]) return singularLabel(humanizeKey(path[i])) || null;
    }
    return null;
}

/**
 * The label parts of a value, from the segments that lead to it.
 * @param {Array<string|number|object>} segs
 * @returns {Array<{key: string, text: string} | {index: number} | {each: true}>}
 */
export function labelParts(segs) {
    const out = [];
    for (const seg of (Array.isArray(segs) ? segs : [])) {
        if (isWild(seg)) out.push({ each: true });
        else if (typeof seg === 'number') out.push({ index: seg });
        else out.push({ key: String(seg), text: humanizeKey(seg) });
    }
    return out;
}

/**
 * The parts' readable keys joined with `sep`, list markers left out: the
 * plain-text form a tooltip or a search uses. A client that words "each" and
 * "first" builds its own sentence from the parts instead.
 * @param {ReturnType<typeof labelParts>} parts
 * @param {string} [sep]
 */
export function labelText(parts, sep = ' › ') {
    return (Array.isArray(parts) ? parts : [])
        .filter(p => typeof p?.text === 'string' && p.text)
        .map(p => p.text)
        .join(sep);
}

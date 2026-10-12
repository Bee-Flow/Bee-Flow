/**
 * mismatch — "it doesn't fit one-to-one, so ask in plain words" (artboard 2a).
 *
 * When a picked field is a LIST (or a group, or a table) and the slot wants
 * ONE value, the builder never refuses: it writes a sensible default binding
 * at once and asks, under the field, which of these the author meant:
 *
 *   All of them, one per line          → join(list, "\n")      (the default)
 *   Only the first                      → first(list)
 *   Only the count                      → count(list)
 *   A separate run for each item        → step.forEach + loop.<item>
 *   …and, behind "more": only the last, keep the whole list.
 *
 * Every remedy emits only what the server's expression engine really runs —
 * listShape.js's whitelisted first/last/join/count calls, or a bare ref — so
 * nothing here can promise a transform the runtime lacks. Pure, React-free.
 */
import { appendKey, appendWildcard, parsePath } from '@shared/expr/path.mjs';
import { isScalarKind, kindOfValue, KIND_WORD } from './fieldKinds';
import { bindingsForList, forEachPickFor, pathListShape, previewForEachPick } from './listShape';
import { canonicalRefPath, previewValue, walkPath } from '../../../../utils/bindingHelpers';
import { humanizeFieldKey } from '../flow/displayHelpers';

export const NEWLINE = '\n';

/**
 * Is there a mismatch worth asking about?
 *   list  → a single value: yes (structurally certain, even on a sample)
 *   table → a single value: yes, but its own question — a table can go in
 *           "as a table" (artboard 2c), which is never one of the list answers
 *   group → a single value: yes ("pick a field inside")
 *   anything else: no — the server does no type checking, and a wrong claim
 *   is worse than none (text accepts every scalar; bind.js stringifies).
 *
 * `choice` counts as a slot that wants ONE value: a dropdown takes one of its
 * options, never an array of them.
 *
 * @returns {null | { code: 'list_into_one' | 'table_into_one' | 'group_into_one', actual, expected }}
 */
export function detectMismatch({ actualKind, expectedKind }) {
    if (!expectedKind || expectedKind === 'unknown' || !actualKind || actualKind === 'unknown') return null;
    if (!isScalarKind(expectedKind)) return null;
    if (actualKind === 'list') return { code: 'list_into_one', actual: actualKind, expected: expectedKind };
    if (actualKind === 'table') return { code: 'table_into_one', actual: actualKind, expected: expectedKind };
    if (actualKind === 'group') return { code: 'group_into_one', actual: actualKind, expected: expectedKind };
    return null;
}

/**
 * The remedies for a value that does not fit its slot one-to-one, in the
 * design's order, with the binding each one writes. `primary` = shown at once;
 * `more` = behind a "more" reveal.
 *
 * Three shapes ask three different questions (artboard 2a/2c), so this
 * branches on the ACTUAL kind rather than assuming a list:
 *   list  → all / first / count / one run per item        (the original)
 *   table → as a table / how many rows / one run per row   ("· als tabel")
 *   group → a field inside it / the whole group as a summary
 * It stays the ONE source of remedies: every binding it emits is a bare ref or
 * a whitelisted call the shared engine really runs (join/first/last/count from
 * listShape, asTable/groupSummary from @shared/expr/functions.mjs), so nothing
 * here can promise a transform the runtime lacks.
 *
 * @param {string} path         the picked path (may hold `[*]`)
 * @param {object} sampleRoot   the merged sample root (for previews)
 * @param {object} opts         { allowForEach, itemVar, actualKind }
 */
export function remediesFor(path, sampleRoot, { allowForEach = false, itemVar = undefined, actualKind = undefined } = {}) {
    // Canonical: every remedy is a formula over this path (`join(p, …)`), and
    // the engine only reads the canonical spelling as the same path.
    const p = canonicalRefPath(String(path || '').trim());
    const kind = actualKind || kindAtPath(p, sampleRoot);
    if (kind === 'group') return groupRemedies(p, sampleRoot);
    if (kind === 'table') return tableRemedies(p, sampleRoot, { allowForEach, itemVar });
    const shape = pathListShape(p, sampleRoot);
    const list = (() => { const v = walkPath(p, sampleRoot); return Array.isArray(v) ? v : []; })();
    const b = bindingsForList(p, { separator: NEWLINE });
    const joined = bindingsForList(p, { separator: ', ' });
    const show = (v) => previewValue(v, 40);
    const n = shape?.count ?? list.length;

    const primary = [
        {
            id: 'join', binding: b.join,
            labelKey: 'automations.mismatch.choice_lines', labelEn: 'All of them, one per line',
            preview: list.length ? show(list.slice(0, 3).map(v => (typeof v === 'object' ? '…' : String(v))).join(' / ')) + (list.length > 3 ? '…' : '') : null,
        },
        {
            id: 'first', binding: b.first,
            labelKey: 'automations.mismatch.choice_first', labelEn: 'Only the first',
            preview: list.length ? show(list[0]) : null,
        },
        {
            id: 'count', binding: b.count,
            labelKey: 'automations.mismatch.choice_count', labelEn: 'Only the count ({n})', labelParams: { n },
            preview: String(n),
        },
    ];
    if (allowForEach) {
        const pick = forEachPickFor(p, sampleRoot, { itemVar });
        primary.push({
            id: 'foreach', binding: pick.binding, forEach: pick.forEach, itemVar: pick.itemVar,
            disabled: !!shape?.rowScopedListTail,
            labelKey: 'automations.mismatch.choice_foreach', labelEn: 'A separate run for each item',
            preview: shape?.rowScopedListTail ? null : show(previewForEachPick(p, sampleRoot)),
        });
    }
    const more = [
        {
            id: 'join_comma', binding: joined.join,
            labelKey: 'automations.mismatch.choice_comma', labelEn: 'All of them, comma separated',
            preview: list.length ? show(list.slice(0, 3).map(v => (typeof v === 'object' ? '…' : String(v))).join(', ')) : null,
        },
        {
            id: 'last', binding: b.last,
            labelKey: 'automations.mismatch.choice_last', labelEn: 'Only the last',
            preview: list.length ? show(list[list.length - 1]) : null,
        },
        {
            // The one correct answer when the slot really does take a list.
            // Kept, quietly: dropping it would leave that author with no
            // right choice at all.
            id: 'each', binding: b.each,
            labelKey: 'automations.mismatch.choice_each', labelEn: 'Keep the whole list',
            preview: null,
        },
    ];
    return { shape, count: n, primary, more, defaultId: 'join' };
}

/** How many child buttons a group offers before the rest go behind "more". */
const GROUP_PRIMARY_FIELDS = 3;

/**
 * A GROUP dropped into a slot that wants one value (artboard 2a: "kies een
 * veld erin" / "hele groep gebruiken").
 *
 * The buttons are the group's own fields — the answer the design asks for —
 * but the DEFAULT is the readable summary, not a field: BindingField writes
 * the default the instant the pick lands, and picking someone's first key for
 * them is a guess about intent, while `groupSummary` is true of every group.
 * Nested groups and lists inside are offered too; their preview says what they
 * are, so nobody binds `[object Object]` by accident.
 */
function groupRemedies(p, sampleRoot) {
    const value = walkPath(p, sampleRoot);
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    // The keys are the payload's, not ours, and the payload this box exists
    // for is the one with awkward keys: an HTTP or webhook step's body, where
    // `content-type`, `x-request-id` and `first-name` are the norm. Every key
    // is written with the shared canonical writer (appendKey): `.ok`, or
    // `["content-type"]` with JSON escapes — a key holding `]` or both quote
    // styles included — which the run, the preview and the expression engine
    // all resolve to that key. A dotted `content-type` would be a subtraction
    // the moment the field is touched in a formula.
    const keys = Object.keys(obj);
    const show = (v) => previewValue(v, 40);
    const fieldRemedy = (key) => ({
        id: `field:${key}`,
        binding: { kind: 'ref', path: appendKey(p, key) },
        labelKey: 'automations.mismatch.choice_field', labelEn: '{field}', labelParams: { field: humanizeFieldKey(key) || key },
        preview: show(obj[key]),
    });
    const summary = {
        id: 'summary',
        binding: { kind: 'expr', value: `groupSummary(${p})` },
        labelKey: 'automations.mismatch.choice_summary', labelEn: 'The whole group, as a readable summary',
        preview: keys.length ? `${humanizeFieldKey(keys[0]) || keys[0]}: ${show(obj[keys[0]])}…` : null,
    };
    const whole = {
        id: 'each',
        binding: { kind: 'ref', path: p },
        labelKey: 'automations.mismatch.choice_whole_group', labelEn: 'Use the whole group as it is',
        preview: null,
    };
    return {
        shape: null,
        count: keys.length,
        primary: [...keys.slice(0, GROUP_PRIMARY_FIELDS).map(fieldRemedy), summary],
        more: [...keys.slice(GROUP_PRIMARY_FIELDS).map(fieldRemedy), whole],
        defaultId: 'summary',
    };
}

/**
 * A TABLE dropped into a slot that wants one value. 2c's answer for a table in
 * a text or document slot is "als tabel" — a Markdown table the reader can
 * actually read — so that is the default, and join/first/last (the list menu)
 * are simply the wrong questions here: joining rows gives "[object Object]".
 */
function tableRemedies(p, sampleRoot, { allowForEach, itemVar }) {
    const shape = pathListShape(p, sampleRoot);
    const rows = (() => { const v = walkPath(p, sampleRoot); return Array.isArray(v) ? v : []; })();
    const n = shape?.count ?? rows.length;
    const cols = (() => {
        const first = rows.find(r => r && typeof r === 'object' && !Array.isArray(r));
        return first ? Object.keys(first) : [];
    })();
    const primary = [
        {
            id: 'table', binding: { kind: 'expr', value: `asTable(${p})` },
            labelKey: 'automations.mismatch.choice_as_table', labelEn: 'As a table',
            preview: cols.length ? cols.slice(0, 4).map(c => humanizeFieldKey(c) || c).join(' | ') : null,
        },
        {
            id: 'count', binding: bindingsForList(p).count,
            labelKey: 'automations.mismatch.choice_rows', labelEn: 'Only how many rows ({n})', labelParams: { n },
            preview: String(n),
        },
    ];
    if (allowForEach) {
        const pick = forEachPickFor(p, sampleRoot, { itemVar });
        primary.push({
            id: 'foreach', binding: pick.binding, forEach: pick.forEach, itemVar: pick.itemVar,
            disabled: !!shape?.rowScopedListTail,
            labelKey: 'automations.mismatch.choice_foreach_row', labelEn: 'A separate run for each row',
            preview: shape?.rowScopedListTail ? null : previewValue(previewForEachPick(p, sampleRoot), 40),
        });
    }
    const more = [
        {
            id: 'first', binding: bindingsForList(p).first,
            labelKey: 'automations.mismatch.choice_first_row', labelEn: 'Only the first row',
            preview: rows.length ? previewValue(rows[0], 40) : null,
        },
        {
            id: 'summary', binding: { kind: 'expr', value: `groupSummary(${p})` },
            labelKey: 'automations.mismatch.choice_summary_rows', labelEn: 'One readable block per row',
            preview: null,
        },
        {
            id: 'each', binding: bindingsForList(p).each,
            labelKey: 'automations.mismatch.choice_keep_table', labelEn: 'Keep the whole table',
            preview: null,
        },
    ];
    return { shape, count: n, primary, more, defaultId: 'table' };
}

/**
 * The sentence above the choices: "<field> is a list of 3, this needs one
 * text. What do you want?" — words, never types. `t` optional.
 */
export function mismatchSentence({ actualKind, expectedKind, count }, t = null) {
    const tr = (key, en, params) => (t ? t(key, en, params) : String(en).replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m)));
    const actualWord = tr(KIND_WORD[actualKind]?.key || KIND_WORD.unknown.key, KIND_WORD[actualKind]?.en || KIND_WORD.unknown.en);
    const expectedWord = tr(KIND_WORD[expectedKind]?.key || KIND_WORD.text.key, KIND_WORD[expectedKind]?.en || 'text');
    if (actualKind === 'group') {
        return tr('automations.mismatch.group_into_one', 'is a {actual}, this needs one {expected}. Pick a field inside it.', { actual: actualWord, expected: expectedWord });
    }
    if (actualKind === 'table') {
        return count != null
            ? tr('automations.mismatch.table_into_one_n', 'is a {actual} of {n} rows, this needs one {expected}. It can go in as a table.', { actual: actualWord, n: count, expected: expectedWord })
            : tr('automations.mismatch.table_into_one', 'is a {actual}, this needs one {expected}. It can go in as a table.', { actual: actualWord, expected: expectedWord });
    }
    return count != null
        ? tr('automations.mismatch.list_into_one_n', 'is a {actual} of {n}, this needs one {expected}. What do you want?', { actual: actualWord, n: count, expected: expectedWord })
        : tr('automations.mismatch.list_into_one', 'is a {actual}, this needs one {expected}. What do you want?', { actual: actualWord, expected: expectedWord });
}

/**
 * The path of ONE column of the table at `path`, as the run reads it.
 *
 * `[*]` maps the REST of a path over every element, so a table reached
 * through `[*]` — Graph's `value[*].from`, one record per message — gets its
 * column by plain key (`value[*].from.emailAddress`); `[*].emailAddress`
 * there would try to iterate each record and read nothing. When each element
 * holds a list itself (`value[*].toRecipients`), or the path names the list
 * directly (`lines`), the column goes through `[*]`. Decided on the sample,
 * which is where the table was seen. Keys are written canonically.
 */
export function columnPath(path, key, sampleRoot) {
    const p = canonicalRefPath(String(path || '').trim());
    if ((parsePath(p) || []).some(t => t.type === 'wild')) {
        const direct = appendKey(p, key);
        const v = walkPath(direct, sampleRoot);
        if (Array.isArray(v) && v.length) return direct;
    }
    return appendKey(appendWildcard(p), key);
}

/** The kind a picked path resolves to right now (for the gate). */
export function kindAtPath(path, sampleRoot) {
    if (!path || !sampleRoot) return 'unknown';
    return kindOfValue(walkPath(String(path), sampleRoot));
}

/**
 * A TABLE dropped on a slot that wants one value: which column did the
 * author mean? (attachmentId takes the `attachmentId` column, also in a text slot.) A Markdown table is only right in
 * a text, so for any other slot this names the column to use instead
 * (`rows[*].<col>`), and the column rules below take it from there (one run
 * per row). The slot's own name decides first — `accountId` takes `id`,
 * `email` takes `email` — then a lone column of the wanted kind. null when it
 * is not clear: the table stays what it was.
 */
export function columnForSlot(path, sampleRoot, { slot = null, expectedKind = 'text' } = {}) {
    if (!path) return null;
    const rows = walkPath(String(path), sampleRoot);
    const first = Array.isArray(rows) ? rows.find(r => r && typeof r === 'object' && !Array.isArray(r)) : null;
    if (!first) return null;
    const cols = Object.keys(first);
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = norm(slot);
    const pickPath = (c) => columnPath(path, c, sampleRoot);
    if (want) {
        const exact = cols.find(c => norm(c) === want);
        if (exact) return pickPath(exact);
        // accountId → id, recipientEmail → email: the longest column the slot ends with.
        const tail = cols.filter(c => norm(c) && want.endsWith(norm(c))).sort((a, b) => norm(b).length - norm(a).length)[0];
        if (tail) return pickPath(tail);
    }
    // Without a name to go on, only a typed slot picks by kind: in a text slot
    // the table itself (as a table) is the better answer.
    if (!expectedKind || expectedKind === 'text' || expectedKind === 'unknown') return null;
    const ofKind = cols.filter(c => kindOfValue(first[c]) === expectedKind);
    return ofKind.length === 1 ? pickPath(ofKind[0]) : null;
}

/**
 * A GROUP (one record) dropped on a slot that wants one value: which field of
 * it did the author mean? The slot's name decides first (`email` takes
 * `email`, `customerName` takes `name`); a slot that is itself a name or title
 * takes the record's headline (name / title / subject); a non-text slot takes a
 * lone field of the wanted kind. null when it is not clear: the group then goes
 * in as its readable summary, which is right for a body or a description.
 */
const HEADLINE_KEYS = ['name', 'title', 'subject', 'displayName', 'label', 'filename', 'fileName'];
export function fieldForSlot(path, sampleRoot, { slot = null, expectedKind = 'text' } = {}) {
    if (!path) return null;
    const rec = walkPath(String(path), sampleRoot);
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    const keys = Object.keys(rec).filter(k => rec[k] == null || typeof rec[k] !== 'object');
    if (!keys.length) return null;
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = norm(slot);
    const pick = (k) => appendKey(canonicalRefPath(String(path)), k);
    if (want) {
        const exact = keys.find(k => norm(k) === want);
        if (exact) return pick(exact);
        const tail = keys.filter(k => norm(k).length > 1 && want.endsWith(norm(k))).sort((a, b) => norm(b).length - norm(a).length)[0];
        if (tail) return pick(tail);
        if (/(title|name|subject|label|heading)$/.test(want)) {
            const head = HEADLINE_KEYS.find(h => keys.includes(h) && typeof rec[h] === 'string');
            if (head) return pick(head);
        }
    }
    if (!expectedKind || expectedKind === 'text' || expectedKind === 'unknown') return null;
    const ofKind = keys.filter(k => kindOfValue(rec[k]) === expectedKind);
    return ofKind.length === 1 ? pick(ofKind[0]) : null;
}

/**
 * Which remedy to apply WITHOUT asking: the author drags, the builder picks
 * what they almost always meant, and the other answers wait under "More".
 *
 *   a value from INSIDE each row (`rows[*].field`) into a step that can run
 *     per item  → one run per row: dragging "Lines ▸ Sku" into "Add a row"
 *     means a row per line. The field shows a note with Undo, because it
 *     changes how often the step runs.
 *   a list into a text or e-mail slot → all of them, comma separated (one
 *     line, so it is also right in a subject or a recipient field)
 *   a list into a number, date, yes/no or choice slot → the first one (a
 *     joined string is never a number)
 *   a table → as a table; a group → its readable summary (the remedies' own
 *     defaults)
 *
 * Always one of `remedies`' own ids, so nothing here can write a binding the
 * runtime lacks. Pure.
 *
 * @param {{ primary: Array<{id:string, disabled?:boolean}>, more: Array<{id:string}>, defaultId: string }} remedies
 * @param {{ path: string, actualKind: string, expectedKind: string }} ctx
 * @returns {string}
 */
export function quietDefaultId(remedies, { path, actualKind, expectedKind }) {
    const has = (id) => [...(remedies?.primary || []), ...(remedies?.more || [])].some(r => r.id === id && !r.disabled);
    const isColumn = String(path || '').includes('[*]');
    if (actualKind === 'list' || actualKind === 'table') {
        if (isColumn && has('foreach')) return 'foreach';
    }
    if (actualKind === 'list') {
        if ((expectedKind === 'text' || expectedKind === 'email') && has('join_comma')) return 'join_comma';
        if (has('first')) return 'first';
    }
    return remedies?.defaultId;
}

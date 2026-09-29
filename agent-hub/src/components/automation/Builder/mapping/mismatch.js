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
import { isScalarKind, kindOfValue, KIND_WORD } from './fieldKinds';
import { bindingsForList, forEachPickFor, pathListShape, previewForEachPick } from './listShape';
import { previewValue, walkPath } from '../../../../utils/bindingHelpers';
import { joinKeyPath, keyPickable } from './keyPath';
import { humanizeFieldTail } from '../flow/displayHelpers';

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
    const p = String(path || '').trim();
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
            labelKey: 'routines.mismatch.choice_lines', labelEn: 'All of them, one per line',
            preview: list.length ? show(list.slice(0, 3).map(v => (typeof v === 'object' ? '…' : String(v))).join(' / ')) + (list.length > 3 ? '…' : '') : null,
        },
        {
            id: 'first', binding: b.first,
            labelKey: 'routines.mismatch.choice_first', labelEn: 'Only the first',
            preview: list.length ? show(list[0]) : null,
        },
        {
            id: 'count', binding: b.count,
            labelKey: 'routines.mismatch.choice_count', labelEn: 'Only the count ({n})', labelParams: { n },
            preview: String(n),
        },
    ];
    if (allowForEach) {
        const pick = forEachPickFor(p, sampleRoot, { itemVar });
        primary.push({
            id: 'foreach', binding: pick.binding, forEach: pick.forEach, itemVar: pick.itemVar,
            disabled: !!shape?.rowScopedListTail,
            labelKey: 'routines.mismatch.choice_foreach', labelEn: 'A separate run for each item',
            preview: shape?.rowScopedListTail ? null : show(previewForEachPick(p, sampleRoot)),
        });
    }
    const more = [
        {
            id: 'join_comma', binding: joined.join,
            labelKey: 'routines.mismatch.choice_comma', labelEn: 'All of them, comma separated',
            preview: list.length ? show(list.slice(0, 3).map(v => (typeof v === 'object' ? '…' : String(v))).join(', ')) : null,
        },
        {
            id: 'last', binding: b.last,
            labelKey: 'routines.mismatch.choice_last', labelEn: 'Only the last',
            preview: list.length ? show(list[list.length - 1]) : null,
        },
        {
            // The one correct answer when the slot really does take a list.
            // Kept, quietly: dropping it would leave that author with no
            // right choice at all.
            id: 'each', binding: b.each,
            labelKey: 'routines.mismatch.choice_each', labelEn: 'Keep the whole list',
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
    // `content-type`, `x-request-id` and `first-name` are the norm. Two rules,
    // both from ./keyPath, and neither optional here:
    //
    //   - QUOTE. `${p}.content-type` previews the real value (the builder's
    //     walkPath skips the syntax check on purpose) and resolves to
    //     undefined in the run (the server's REF_RE rejects it), so the field
    //     arrives EMPTY with no warning at save time or run time. Touching the
    //     field afterwards re-parses it as an expression, where the hyphen is
    //     a subtraction — a second, different silent failure for one key.
    //     `${p}["content-type"]` resolves on both sides.
    //   - REFUSE what cannot be expressed. A key holding `]` or both quote
    //     styles has no path in this dialect; offering a button for it would
    //     write a binding that can only ever be blank.
    const keys = Object.keys(obj).filter(keyPickable);
    const show = (v) => previewValue(v, 40);
    const fieldRemedy = (key) => ({
        id: `field:${key}`,
        binding: { kind: 'ref', path: joinKeyPath(p, key) },
        labelKey: 'routines.mismatch.choice_field', labelEn: '{field}', labelParams: { field: humanizeFieldTail(key) },
        preview: show(obj[key]),
    });
    const summary = {
        id: 'summary',
        binding: { kind: 'expr', value: `groupSummary(${p})` },
        labelKey: 'routines.mismatch.choice_summary', labelEn: 'The whole group, as a readable summary',
        preview: keys.length ? `${humanizeFieldTail(keys[0])}: ${show(obj[keys[0]])}…` : null,
    };
    const whole = {
        id: 'each',
        binding: { kind: 'ref', path: p },
        labelKey: 'routines.mismatch.choice_whole_group', labelEn: 'Use the whole group as it is',
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
            labelKey: 'routines.mismatch.choice_as_table', labelEn: 'As a table',
            preview: cols.length ? cols.slice(0, 4).map(humanizeFieldTail).join(' | ') : null,
        },
        {
            id: 'count', binding: bindingsForList(p).count,
            labelKey: 'routines.mismatch.choice_rows', labelEn: 'Only how many rows ({n})', labelParams: { n },
            preview: String(n),
        },
    ];
    if (allowForEach) {
        const pick = forEachPickFor(p, sampleRoot, { itemVar });
        primary.push({
            id: 'foreach', binding: pick.binding, forEach: pick.forEach, itemVar: pick.itemVar,
            disabled: !!shape?.rowScopedListTail,
            labelKey: 'routines.mismatch.choice_foreach_row', labelEn: 'A separate run for each row',
            preview: shape?.rowScopedListTail ? null : previewValue(previewForEachPick(p, sampleRoot), 40),
        });
    }
    const more = [
        {
            id: 'first', binding: bindingsForList(p).first,
            labelKey: 'routines.mismatch.choice_first_row', labelEn: 'Only the first row',
            preview: rows.length ? previewValue(rows[0], 40) : null,
        },
        {
            id: 'summary', binding: { kind: 'expr', value: `groupSummary(${p})` },
            labelKey: 'routines.mismatch.choice_summary_rows', labelEn: 'One readable block per row',
            preview: null,
        },
        {
            id: 'each', binding: bindingsForList(p).each,
            labelKey: 'routines.mismatch.choice_keep_table', labelEn: 'Keep the whole table',
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
        return tr('routines.mismatch.group_into_one', 'is a {actual}, this needs one {expected}. Pick a field inside it.', { actual: actualWord, expected: expectedWord });
    }
    if (actualKind === 'table') {
        return count != null
            ? tr('routines.mismatch.table_into_one_n', 'is a {actual} of {n} rows, this needs one {expected}. It can go in as a table.', { actual: actualWord, n: count, expected: expectedWord })
            : tr('routines.mismatch.table_into_one', 'is a {actual}, this needs one {expected}. It can go in as a table.', { actual: actualWord, expected: expectedWord });
    }
    return count != null
        ? tr('routines.mismatch.list_into_one_n', 'is a {actual} of {n}, this needs one {expected}. What do you want?', { actual: actualWord, n: count, expected: expectedWord })
        : tr('routines.mismatch.list_into_one', 'is a {actual}, this needs one {expected}. What do you want?', { actual: actualWord, expected: expectedWord });
}

/** The kind a picked path resolves to right now (for the gate). */
export function kindAtPath(path, sampleRoot) {
    if (!path || !sampleRoot) return 'unknown';
    return kindOfValue(walkPath(String(path), sampleRoot));
}

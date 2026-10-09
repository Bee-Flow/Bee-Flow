import { appendKey, appendMatch } from '@shared/expr/path.mjs';
import TruncatedOutput from '../TruncatedOutput';
import ColHeader from './ColHeader';
import { isTruncatedOutput as isTruncatedOutputJs } from '../mapping/realOutputs';
import { envelopedListKey } from './envelope';
import InlineValue from './InlineValue';
import { childMap, mapAttrs, type MapCtx } from './mapAttrs';
import RecordTable from './RecordTable';
import { ClipWarning, Empty, Scalar } from './ScalarValue';
import { MAX_ROWS, humanize, isPlainObject, type PlainObject } from './valueHelpers';
import { jsonTextValue, pairKeysOf, readableValue, sameName, textHidesKey } from '../mapping/upstream/fieldTree';
import { useTranslation } from '../../../../hooks/useTranslation';

export const isTruncatedOutput = isTruncatedOutputJs as (v: unknown) => boolean;
type Sentinel = Parameters<typeof TruncatedOutput>[0]['sentinel'];

interface FriendlyProps {
    value: unknown;
    emptyMessage?: string;
    map?: MapCtx | null;
    allowExpand?: boolean;
    /** Inside a record: a wide table scrolls sideways on its own, not the whole view. */
    nested?: boolean;
}

/**
 * What a value shows as: JSON text (an HTTP body, an AI answer in a ```json
 * fence, text inside text) is the record or list it encodes. Its paths need
 * no parse step: the runtime reads through JSON text with the same path.
 */
export function shownAs(value: unknown): unknown {
    const parsed = jsonTextValue(value);
    return parsed === undefined ? value : parsed;
}

/**
 * The output the way an average user expects it: arrays of objects as a real
 * table, a list of name/value pairs as a two-column table, arrays of scalars
 * as a list, objects as labelled fields (nested arrays become tables) and
 * scalars as plain text. JSON text at any level is shown as what it encodes.
 */
export default function FriendlyValue({ value: raw, emptyMessage = 'No output.', map = null, allowExpand = false, nested = false }: FriendlyProps) {
    const value = shownAs(raw);
    if (value === null || value === undefined) return <Empty>{emptyMessage}</Empty>;
    // The run history swaps an over-cap payload for a sentinel. OutputView
    // catches a top-level one; this is for one nested inside a value.
    if (isTruncatedOutput(value)) {
        return (
            <TruncatedOutput
                sentinel={value as Sentinel}
                framed={false}
                renderFull={(full) => <FriendlyValue value={full} emptyMessage={emptyMessage} map={map} allowExpand={allowExpand} nested={nested} />}
            />
        );
    }
    if (Array.isArray(value)) return <FriendlyArray arr={value} map={map} allowExpand={allowExpand} nested={nested} />;
    if (typeof value === 'object') return <FriendlyObject obj={value as PlainObject} map={map} allowExpand={allowExpand} fromText={typeof raw === 'string'} />;
    return <Scalar value={value} map={map} />;
}

/**
 * Is this list a REAL list of name/value pairs (mail headers, tags): every row
 * exactly a name and a value? fieldTree's pairKeysOf is wider on purpose (it
 * only ADDS by-name entries beside the columns); here the pair table REPLACES
 * the record table, so a file list (`{ name, content }`), comments
 * (`{ name, text }`) or form rows with a type stay records, with every field
 * on screen and their columns mappable as a whole.
 */
function tidyPairs(arr: unknown[]): { name: string; value: string } | null {
    if (!arr.every(isPlainObject)) return null;
    const keys = pairKeysOf(arr);
    if (!keys || !/^(value|val)$/i.test(keys.value)) return null;
    return (arr as PlainObject[]).every(r => Object.keys(r).length === 2) ? keys : null;
}

function FriendlyArray({ arr: raw, map, allowExpand, nested }: { arr: unknown[]; map: MapCtx | null; allowExpand: boolean; nested: boolean }) {
    const { t } = useTranslation();
    if (raw.length === 0) return <Empty>{t('automations.friendly_value.empty_list', 'Empty list')}</Empty>;
    // A list of JSON-text records is a table too: `[0].k` reads through the
    // text. A key a path cannot reach through text (`length`) is no column.
    const arr = raw.some(v => typeof v === 'string') ? raw.map(readableValue) : raw;
    const pairs = tidyPairs(arr);
    if (pairs) return <PairTable rows={arr as PlainObject[]} keys={pairs} map={map} allowExpand={allowExpand} />;
    const objects = arr.filter(isPlainObject);
    // Treat as tabular when at least half the items are objects.
    if (objects.length && objects.length >= arr.length / 2) return <RecordTable rows={arr} map={map} allowExpand={allowExpand} contained={nested} />;
    const shown = arr.slice(0, MAX_ROWS);
    return (
        <ul className="list-disc pl-4 space-y-0.5">
            {shown.map((v, i) => <li key={i} {...mapAttrs(map, appendKey('', i))}><InlineValue value={v} /></li>)}
            {arr.length > MAX_ROWS && <li className="list-none text-[var(--text-tertiary)]">+{arr.length - MAX_ROWS} more</li>}
        </ul>
    );
}

interface FriendlyObjectProps {
    obj: PlainObject;
    map: MapCtx | null;
    allowExpand: boolean;
    /** The record was read out of JSON text: a key a path cannot reach through text is shown, but maps nothing. */
    fromText?: boolean;
}

function FriendlyObject({ obj, map, allowExpand, fromText = false }: FriendlyObjectProps) {
    const { t } = useTranslation();
    const entries = Object.entries(obj);
    if (entries.length === 0) return <Empty>{t('automations.friendly_value.no_fields', 'No fields')}</Empty>;
    // `body.length` on text is the text's length at run time (path.mjs
    // stepInto), so handing out that path would bind the wrong value.
    const mapFor = (k: string): MapCtx | null => (textHidesKey(fromText, k) ? null : map);
    const only = envelopedListKey(entries);
    if (only) {
        return (
            <>
                {/* `truncated` is one of the transport fields the unwrap hides,
                    and the one that must never disappear quietly. */}
                {obj.truncated === true && <ClipWarning />}
                <FriendlyValue value={obj[only]} map={childMap(mapFor(only), only)} allowExpand={allowExpand} />
            </>
        );
    }
    return (
        <div className="space-y-1.5">
            {entries.map(([k, v]) => {
                const shown = shownAs(v);
                const scalar = shown === null || typeof shown !== 'object';
                const km = childMap(mapFor(k), k);
                const attrs = mapAttrs(km, '');
                return (
                    <div key={k} className={scalar ? 'flex gap-1.5 items-baseline' : ''}>
                        <span {...attrs} className={`text-[var(--text-secondary)] font-semibold shrink-0 ${attrs.className || ''}`.trim()}>{humanize(k)}{scalar ? ':' : ''}</span>
                        <div className={scalar ? 'min-w-0' : 'mt-0.5 min-w-0'}>
                            <FriendlyValue value={v} map={km} allowExpand={allowExpand} nested />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

interface PairTableProps { rows: PlainObject[]; keys: { name: string; value: string }; map: MapCtx | null; allowExpand: boolean }

/**
 * A list of name/value pairs (mail headers, order attributes, tags) as the
 * two-column table a person reads it as. A value maps BY NAME,
 * `headers[name="Subject"].value`, so the binding still finds the Subject
 * header when the next mail orders its headers differently; a repeated name
 * (the runtime matches the first, ignoring case) is reached by position.
 */
function PairTable({ rows, keys, map, allowExpand }: PairTableProps) {
    const names: string[] = [];
    const shown = rows.slice(0, MAX_ROWS);
    return (
        <table className="border-collapse">
            {/* The columns map as a whole too (`headers[*].value`, "run once
                per row"): a pair list that IS the whole output has no other
                list-level path. */}
            <thead>
                <tr>
                    <ColHeader col={appendKey('', keys.name)} label={humanize(keys.name)} map={map} expandable={false} />
                    <ColHeader col={appendKey('', keys.value)} label={humanize(keys.value)} map={map} expandable={false} />
                </tr>
            </thead>
            <tbody>
                {shown.map((r, i) => {
                    const name = String(r[keys.name]);
                    const first = !names.some(n => sameName(n, name));
                    if (first) names.push(name);
                    const at = first && name.trim() ? appendMatch('', keys.name, name) : appendKey('', i);
                    return (
                        <tr key={i} className="border-b border-[var(--border-default)]/60 last:border-b-0">
                            <th scope="row" className="text-left font-semibold text-[var(--text-secondary)] px-2 py-1 align-top whitespace-nowrap">{name}</th>
                            <td className="px-2 py-1 align-top min-w-0">
                                <FriendlyValue value={r[keys.value]} emptyMessage="—" map={map ? { ...map, path: appendKey(`${map.path}${at}`, keys.value) } : null} allowExpand={allowExpand} nested />
                            </td>
                        </tr>
                    );
                })}
                {rows.length > MAX_ROWS && (
                    <tr><td colSpan={2} className="px-2 py-1 text-[var(--text-tertiary)]">+{rows.length - MAX_ROWS} more</td></tr>
                )}
            </tbody>
        </table>
    );
}

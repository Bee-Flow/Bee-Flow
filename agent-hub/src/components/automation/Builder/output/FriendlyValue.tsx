import TruncatedOutput from '../TruncatedOutput';
import { isTruncatedOutput as isTruncatedOutputJs } from '../mapping/realOutputs';
import { envelopedListKey } from './envelope';
import InlineValue from './InlineValue';
import { childMap, mapAttrs, type MapCtx } from './mapAttrs';
import RecordTable from './RecordTable';
import { ClipWarning, Empty, Scalar } from './ScalarValue';
import { MAX_ROWS, humanize, isPlainObject, type PlainObject } from './valueHelpers';

export const isTruncatedOutput = isTruncatedOutputJs as (v: unknown) => boolean;
type Sentinel = Parameters<typeof TruncatedOutput>[0]['sentinel'];

interface FriendlyProps { value: unknown; emptyMessage?: string; map?: MapCtx | null; allowExpand?: boolean }

/**
 * The output the way an average user expects it: arrays of objects as a real
 * table, arrays of scalars as a list, objects as labelled fields (nested
 * arrays become tables) and scalars as plain text.
 */
export default function FriendlyValue({ value, emptyMessage = 'No output.', map = null, allowExpand = false }: FriendlyProps) {
    if (value === null || value === undefined) return <Empty>{emptyMessage}</Empty>;
    // The run history swaps an over-cap payload for a sentinel. OutputView
    // catches a top-level one; this is for one nested inside a value.
    if (isTruncatedOutput(value)) {
        return (
            <TruncatedOutput
                sentinel={value as Sentinel}
                framed={false}
                renderFull={(full) => <FriendlyValue value={full} emptyMessage={emptyMessage} map={map} allowExpand={allowExpand} />}
            />
        );
    }
    if (Array.isArray(value)) return <FriendlyArray arr={value} map={map} allowExpand={allowExpand} />;
    if (typeof value === 'object') return <FriendlyObject obj={value as PlainObject} map={map} allowExpand={allowExpand} />;
    return <Scalar value={value} map={map} />;
}

function FriendlyArray({ arr, map, allowExpand }: { arr: unknown[]; map: MapCtx | null; allowExpand: boolean }) {
    if (arr.length === 0) return <Empty>Empty list</Empty>;
    const objects = arr.filter(isPlainObject);
    // Treat as tabular when at least half the items are objects.
    if (objects.length && objects.length >= arr.length / 2) return <RecordTable rows={arr} map={map} allowExpand={allowExpand} />;
    const shown = arr.slice(0, MAX_ROWS);
    return (
        <ul className="list-disc pl-4 space-y-0.5">
            {shown.map((v, i) => <li key={i} {...mapAttrs(map, `[${i}]`)}><InlineValue value={v} /></li>)}
            {arr.length > MAX_ROWS && <li className="list-none text-[var(--text-tertiary)]">+{arr.length - MAX_ROWS} more</li>}
        </ul>
    );
}

function FriendlyObject({ obj, map, allowExpand }: { obj: PlainObject; map: MapCtx | null; allowExpand: boolean }) {
    const entries = Object.entries(obj);
    if (entries.length === 0) return <Empty>No fields</Empty>;
    const only = envelopedListKey(entries);
    if (only) {
        return (
            <>
                {/* `truncated` is one of the transport fields the unwrap hides,
                    and the one that must never disappear quietly. */}
                {obj.truncated === true && <ClipWarning />}
                <FriendlyValue value={obj[only]} map={childMap(map, `.${only}`)} allowExpand={allowExpand} />
            </>
        );
    }
    return (
        <div className="space-y-1.5">
            {entries.map(([k, v]) => {
                const scalar = v === null || typeof v !== 'object';
                const km = childMap(map, `.${k}`);
                const attrs = mapAttrs(km, '');
                return (
                    <div key={k} className={scalar ? 'flex gap-1.5 items-baseline' : ''}>
                        <span {...attrs} className={`text-[var(--text-secondary)] font-semibold shrink-0 ${attrs.className || ''}`.trim()}>{humanize(k)}{scalar ? ':' : ''}</span>
                        <div className={scalar ? 'min-w-0' : 'mt-0.5'}>
                            <FriendlyValue value={v} map={km} allowExpand={allowExpand} />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

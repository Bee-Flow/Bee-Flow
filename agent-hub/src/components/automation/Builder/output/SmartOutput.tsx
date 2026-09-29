import type { ComponentType } from 'react';
import FieldKindIconJs from '../mapping/FieldKindIcon';
import { kindOfValue as kindOfValueJs } from '../mapping/fieldKinds';
import { humanizeFieldKey as humanizeFieldKeyJs } from '../flow/displayHelpers';
import { cellText } from './cellSummary';
import { soleRecordListKey } from './envelope';
import SmartTable from './SmartTable';
import type { OutputColumnsState } from './useOutputColumns';
import { isPlainObject, type PlainObject } from './valueHelpers';

const FieldKindIcon = FieldKindIconJs as unknown as ComponentType<{ kind: string; size?: number; className?: string }>;
const kindOfValue = kindOfValueJs as (v: unknown) => string;
const humanizeFieldKey = humanizeFieldKeyJs as (key: string) => string;

/**
 * The rows the smart table shows for this value, or null when it is not a
 * table: an array of records, or a record holding exactly one such list
 * beside plain values (`{ files: […], count: 23, folder: '/' }`).
 */
export function smartRowsOf(value: unknown): unknown[] | null {
    if (Array.isArray(value)) {
        const objects = value.filter(isPlainObject);
        return objects.length && objects.length >= value.length / 2 && objects.some(o => Object.keys(o).length) ? value : null;
    }
    const key = soleRecordListKey(value);
    return key ? ((value as PlainObject)[key] as unknown[]) : null;
}

interface SmartOutputProps {
    value: unknown;
    rows: unknown[];
    cols: OutputColumnsState;
    onExpand: (rowIndex?: number) => void;
}

/**
 * A list in the drawer's "Continues on" column (artboard 4b): the table, and
 * under it the plain values that came with it ("Count 23", "Folder /").
 */
export default function SmartOutput({ value, rows, cols, onExpand }: SmartOutputProps) {
    const listKey = soleRecordListKey(value);
    const scalars = listKey && isPlainObject(value)
        ? Object.entries(value).filter(([k, v]) => k !== listKey && (v === null || typeof v !== 'object'))
        : [];
    return (
        <div className="flex flex-col gap-2.5">
            <SmartTable rows={rows} cols={cols} onExpand={onExpand} />
            {scalars.length > 0 && (
                <div className="flex flex-wrap gap-1.5" data-testid="output-smart-scalars">
                    {scalars.map(([k, v]) => (
                        <div key={k} className="flex-1 min-w-[120px] flex items-center gap-2 px-2.5 py-[7px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)]">
                            <FieldKindIcon kind={kindOfValue(v)} size={13} className="shrink-0 text-[var(--text-secondary)]" />
                            <span className="font-medium truncate">{humanizeFieldKey(k)}</span>
                            <span className="ml-auto text-[var(--text-tertiary)] truncate">{cellText(v) || '—'}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

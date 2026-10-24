import { useState, type ComponentType } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import BindingFieldJs from '../../../mapping/BindingField';
import { seg } from '../../../mapping/upstream/sampleFields';
import { useVariablePickerContext } from '../../../mapping/VariablePickerContext';
import { rowInputClass } from '../formStyles';
import { pathOf, refBinding, TABLE_STEP_TYPES, type Binding } from './tableOpModel';

// Untyped JS component; its props are checked there.
const BindingField = BindingFieldJs as unknown as ComponentType<Record<string, unknown>>;

const OTHER = '\u0000other';

interface GroupLike { id: string; label: string; kind: string; basePath: string; sample?: unknown }

export interface TableOption { path: string; label: string; stepId: string }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The tables the earlier steps make: a Read table step gives its first sheet
 * (and each further sheet by name once a run has shown them), an Edit table
 * step gives its result. In the order of the flow, the nearest step last.
 */
export function tableOptions(groups: readonly GroupLike[]): TableOption[] {
    const out: TableOption[] = [];
    for (const g of groups) {
        if (!TABLE_STEP_TYPES.has(g.kind)) continue;
        out.push({ path: `${g.basePath}.table`, label: g.label, stepId: g.id });
        const sheets = isRecord(g.sample) && isRecord(g.sample.tablesByName) ? Object.keys(g.sample.tablesByName) : [];
        if (g.kind === 'read_table' && sheets.length > 1) {
            for (const name of sheets) out.push({ path: `${g.basePath}.tablesByName${seg(name)}`, label: `${g.label} · ${name}`, stepId: g.id });
        }
    }
    return out;
}

/** The table of the nearest earlier step that makes one, as a binding; null when there is none. */
export function nearestTableBinding(groups: readonly GroupLike[]): Binding | null {
    const first = tableOptions(groups).filter(o => o.path.endsWith('.table'));
    const last = first[first.length - 1];
    return last ? refBinding(last.path) : null;
}

interface Props {
    value: Binding | null;
    /** What to offer; the tables of the earlier steps when omitted. */
    options?: TableOption[];
    /** Said under the picker when there is nothing to offer. */
    emptyText?: string;
    /** Shown in the box for "Another reference". */
    placeholder?: string;
    onChange: (next: Binding | null) => void;
    ariaLabel: string;
    id?: string;
    invalid?: boolean;
    onFocusField?: unknown;
    previewSample?: unknown;
}

/**
 * Which table a step works on: a plain choice among the tables the earlier
 * steps make, and "Another reference" for anything else (a table in a loop, a
 * reference typed by hand).
 */
export default function TableSourceField({ value, options: given, emptyText, placeholder, onChange, ariaLabel, id, invalid, onFocusField, previewSample }: Props) {
    const { t } = useTranslation();
    const { groups } = useVariablePickerContext();
    const options = given ?? tableOptions(groups);
    const path = pathOf(value);
    const listed = !!path && options.some(o => o.path === path);
    const [other, setOther] = useState(false);
    const custom = other || (!!value && !listed);
    return (
        <div className="flex flex-col gap-1.5">
            <select
                id={id} aria-label={ariaLabel} value={custom ? OTHER : path}
                onChange={e => {
                    if (e.target.value === OTHER) { setOther(true); return; }
                    setOther(false);
                    onChange(e.target.value ? refBinding(e.target.value) : null);
                }}
                className={rowInputClass('w-full', { invalid })}
            >
                {!path && !custom && <option value="">{t('automation_tables.source.choose', 'Choose a table')}</option>}
                {options.map(o => <option key={o.path} value={o.path}>{o.label}</option>)}
                <option value={OTHER}>{t('automation_tables.source.other', 'Another reference…')}</option>
            </select>
            {custom && (
                <BindingField
                    value={value}
                    onChange={(b: Binding | null) => onChange(b)}
                    label={ariaLabel}
                    placeholder={placeholder ?? t('automation_tables.source.placeholder', 'steps.<step>.output.table')}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    showExpressionHelp={false}
                />
            )}
            {options.length === 0 && !custom && (
                <p className="text-[11px] text-[var(--text-tertiary)]">
                    {emptyText ?? t('automation_tables.source.none', 'No earlier step makes a table yet. Add a Read table step before this one.')}
                </p>
            )}
        </div>
    );
}

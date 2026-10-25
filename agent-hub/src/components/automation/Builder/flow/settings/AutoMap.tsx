import { Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { isEmptyBinding } from '../../mapping/partitionInputs';
import { matchColumns } from './columnMatch';
import { actionButtonClass, denseInputClass, hintTextClass, subLabelClass } from './formStyles';
import { candidateFields, feedingGroup, mappableGroups } from './tablesRowValues';
import type { AutoMapProps, SourceGroup } from './TablesRowValuesEditor.types';

export function AutoMap({ t, step, upstream, columns, map, cellBinding, emit }: AutoMapProps) {
    const sources = useMemo(() => mappableGroups(upstream) as SourceGroup[], [upstream]);
    const defaultSource = useMemo(() => feedingGroup(upstream, step) as SourceGroup | null, [upstream, step]);
    const [sourceId, setSourceId] = useState<string | null>(null);
    const source = sources.find(g => g.id === sourceId) || defaultSource;
    const [note, setNote] = useState<{ mapped: number; unmatched: string[]; } | null>(null); // { mapped, unmatched } | null

    const run = () => {
        if (!source) return;
        const fields = candidateFields(source);
        const pathByKey = new Map(fields.map(f => [f.key, f.path]));
        const empty = columns.filter(c => isEmptyBinding(cellBinding(c)));
        const { byColumn, unmatchedFields } = matchColumns(fields.map(f => f.key), empty.map(c => c.title));
        const next = { ...map };
        let mapped = 0;
        for (const [title, key] of Object.entries(byColumn)) {
            const path = pathByKey.get(key);
            if (!path) continue;
            next[title] = { kind: 'ref', path };
            mapped += 1;
        }
        if (mapped) emit(next);
        setNote({ mapped, unmatched: unmatchedFields });
    };

    return (
        <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
                {sources.length > 1 && (
                    <label className="flex items-center gap-1 min-w-0">
                        <span className={subLabelClass()}>{t('automations.ndv.tables_row.map_from', 'Map from')}</span>
                        <select
                            className={denseInputClass('max-w-[14rem]')}
                            value={source?.id || ''}
                            onChange={(e) => setSourceId(e.target.value)}
                            aria-label={t('automations.ndv.tables_row.map_from', 'Map from')}
                        >
                            {sources.map(g => <option key={g.id} value={g.id}>{g.label || g.id}</option>)}
                        </select>
                    </label>
                )}
                <button
                    type="button"
                    onClick={run}
                    disabled={!source || !columns.length}
                    className={`${actionButtonClass()} ml-auto disabled:opacity-50`}
                    title={t('automations.ndv.tables_row.automap_title', 'Fill empty columns from {source} — only names that match once spelling differences are ignored', { source: source?.label || '…' })}
                >
                    <Sparkles size={12} aria-hidden="true" /> {t('automations.ndv.tables_row.automap', 'Auto-map')}
                </button>
            </div>
            {note && (
                <p className={hintTextClass()} data-testid="tables-row-automap-note">
                    {t('automations.ndv.tables_row.automap_mapped', '{n} columns filled.', { n: note.mapped })}
                    {note.unmatched.length > 0 && (
                        <>
                            {' '}
                            {t('automations.ndv.tables_row.automap_unmatched', 'No column with that name: {fields}.', { fields: note.unmatched.join(', ') })}
                        </>
                    )}
                </p>
            )}
        </div>
    );
}

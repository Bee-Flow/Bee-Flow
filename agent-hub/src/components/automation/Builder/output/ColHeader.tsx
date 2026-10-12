import { ChevronRight, List } from 'lucide-react';
import { appendWildcard } from '@shared/expr/path.mjs';
import { joinPath, mapAttrs, type MapCtx } from './mapAttrs';
import { COL_MAX_PX } from './valueHelpers';
import { useTranslation } from '../../../../hooks/useTranslation';

interface ColHeaderProps {
    /** The column's path RELATIVE to one row (`subject`, `from.emailAddress`, `["Story Points"]`). */
    col: string;
    /** What a person calls it ("Story points"). */
    label: string;
    /**
     * The opened columns this one came out of, outermost first ("Meta › Ai ›
     * Verdict ›" before "Score"): clicking a name closes that level again.
     */
    trail?: { path: string; label: string }[];
    map: MapCtx | null;
    expandable: boolean;
    isListCol?: boolean;
    onToggle?: (key: string) => void;
}

// One table-header cell. When `expandable`, a chevron opens the column into
// its sub-fields (a list column into the columns of its items); a column that
// came out of opened ones shows the whole chain of their names, each one
// clickable to close that level again. The cell itself maps every row's
// value at that column (`map.path[*]` + the column's path).
export default function ColHeader({ col, label, trail = [], map, expandable, isListCol = false, onToggle }: ColHeaderProps) {
    const { t } = useTranslation();
    const rel = joinPath(appendWildcard(''), col);
    const everyRow = map ? joinPath(map.path, rel) : '';
    return (
        <th
            {...mapAttrs(map, rel)}
            // These two CLOBBER mapAttrs' own title/className (explicit props
            // come after the spread), so the Alt hint must live here.
            style={{ maxWidth: COL_MAX_PX }}
            className={`text-left font-semibold text-[var(--text-secondary)] px-2 py-1 border-b border-[var(--border-default)] whitespace-nowrap ${map ? 'cursor-grab active:cursor-grabbing hover:bg-[var(--accent)]/10' : ''}`}
            title={map ? `Drag or click to map every row's ${label} (${everyRow}). Hold Alt to insert the list as it is.` : undefined}
        >
            <span className="inline-flex items-center gap-1 max-w-full">
                {trail.map(step => (
                    <button
                        key={step.path}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onToggle?.(step.path); }}
                        className="font-normal text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        title={`Collapse ${step.label}`}
                    >
                        {step.label} ›
                    </button>
                ))}
                <span className="truncate">{label}</span>
                {expandable && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onToggle?.(col); }}
                        className="ml-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        title={isListCol
                            ? 'Open the list: one column per field of its items'
                            : 'Show fields: map a single one (e.g. just content)'}
                        aria-label={isListCol ? `Open the list in ${label}` : 'Show fields'}
                    >
                        <ChevronRight size={11} />
                    </button>
                )}
                {map && !trail.length && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); map.onPick?.(everyRow, { raw: false }); }}
                        // NOT the string "Show fields": the expand chevron is
                        // located by that exact label.
                        aria-label={`Choose how to use every row's ${label}`}
                        title={t('automations.col_header.pick_one_join_them_count_them', 'Pick one, join them, count them, or run this step once per row')}
                        className="ml-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        <List size={11} />
                    </button>
                )}
            </span>
        </th>
    );
}

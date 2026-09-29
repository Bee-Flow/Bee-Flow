import { ChevronRight, List } from 'lucide-react';
import { mapAttrs, type MapCtx } from './mapAttrs';
import { COL_MAX_PX, humanize } from './valueHelpers';

interface ColHeaderProps {
    col: string;
    map: MapCtx | null;
    expandable: boolean;
    isListCol?: boolean;
    onToggle?: (key: string) => void;
}

// One table-header cell. `col` is a dotted path relative to the row
// (`output` or `output.content`). When `expandable`, a chevron drills the
// object column into its sub-fields; an expanded child shows a clickable
// parent prefix that collapses it again. The cell itself maps every row's
// value at that column (`map.path[*].col`).
export default function ColHeader({ col, map, expandable, isListCol = false, onToggle }: ColHeaderProps) {
    const segs = col.split('.');
    const leaf = segs[segs.length - 1];
    const rawParent = segs.length > 1 ? segs.slice(0, -1).join('.') : null;
    // Expansion state is keyed by the BASE column name: strip the wildcard an
    // array column's children carry ('attachments[*]' → toggle 'attachments').
    const parentKey = rawParent ? rawParent.replace(/\[\*\]$/, '') : null;
    const parentLabel = parentKey ? humanize(parentKey) : null;
    return (
        <th
            {...mapAttrs(map, `[*].${col}`)}
            // These two CLOBBER mapAttrs' own title/className (explicit props
            // come after the spread), so the Alt hint must live here.
            style={{ maxWidth: COL_MAX_PX }}
            className={`text-left font-semibold text-[var(--text-secondary)] px-2 py-1 border-b border-[var(--border-default)] whitespace-nowrap ${map ? 'cursor-grab active:cursor-grabbing hover:bg-[var(--accent)]/10' : ''}`}
            title={map ? `Drag or click to map every row's ${humanize(leaf)} (${map.path}[*].${col}). Hold Alt to insert the list as it is.` : undefined}
        >
            <span className="inline-flex items-center gap-1 max-w-full">
                {parentKey && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onToggle?.(parentKey); }}
                        className="font-normal text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        title={`Collapse ${parentLabel}`}
                    >
                        {parentLabel} ›
                    </button>
                )}
                <span className="truncate">{humanize(leaf)}</span>
                {expandable && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onToggle?.(col); }}
                        className="ml-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        title={isListCol
                            ? 'Open the list: one column per field of its items'
                            : 'Show fields: map a single one (e.g. just content)'}
                        aria-label={isListCol ? `Open the list in ${humanize(leaf)}` : 'Show fields'}
                    >
                        <ChevronRight size={11} />
                    </button>
                )}
                {map && !col.includes('.') && !col.includes('[*]') && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); map.onPick?.(`${map.path}[*].${col}`, { raw: false }); }}
                        // NOT the string "Show fields": the expand chevron is
                        // located by that exact label.
                        aria-label={`Choose how to use every row's ${humanize(leaf)}`}
                        title="Pick one, join them, count them, or run this step once per row"
                        className="ml-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        <List size={11} />
                    </button>
                )}
            </span>
        </th>
    );
}

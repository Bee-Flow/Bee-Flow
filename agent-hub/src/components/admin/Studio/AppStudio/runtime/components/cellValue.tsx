import useTranslation from '../../../../../../hooks/useTranslation';
import { hoverable } from '../hoverable';
import { roleTextColor } from '../styleResolver';
import { CellFlag } from './cellPills';
import { subtextToneFor } from './cellTone';
import { renderMainValue } from './cellFormats';
import type { CellValueProps } from './cellValue.types';

export { alignFor, ALIGN_CLASS, isHttpUrl, labelForCell, toneForCell } from './cellTone';
export { initialsOf, Monogram } from './cellPills';
export type { CellColumn, CellRow, CellValueProps } from './cellValue.types';

export default function CellValue({ value, format = 'text', col = null, row = null, now = null }: CellValueProps) {
    const { t } = useTranslation();
    const main = renderMainValue({ value, format, col, row, now, t });

    // Decorations (spec: columns[].flagFrom / subtextFrom). A column without
    // them returns the main content verbatim — the identity path.
    const flagRaw = col?.flagFrom && row && typeof row === 'object' ? row[col.flagFrom] : null;
    const hasFlag = !!flagRaw;
    const subRaw = col?.subtextFrom && row && typeof row === 'object' ? row[col.subtextFrom] : null;
    const hasSub = subRaw != null && subRaw !== '';
    if (!hasFlag && !hasSub) return main;

    // The flag sits INLINE beside the main text; with the column's truncate on,
    // the text gives way and the flag stays whole — a marker that truncates to
    // "SPO…" has stopped being a marker.
    const mainLine = hasFlag ? (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
            <span className={col?.truncate ? 'min-w-0 truncate' : 'min-w-0'}>{main}</span>
            <CellFlag text={String(flagRaw)} tone={col?.flagTone || 'warning'} />
        </span>
    ) : main;
    if (!hasSub) return mainLine;

    const subTone = subtextToneFor(col, row);
    return (
        <span className="block min-w-0">
            <span className={`block min-w-0${col?.truncate ? ' truncate' : ''}`}>{mainLine}</span>
            {/* Always truncated: the subtext is a one-line annotation, and a
                td-level nowrap would otherwise hide its overflow with no
                ellipsis. roleTextColor keeps the tone readable in dark mode. */}
            <span
                className="block truncate text-xs"
                {...hoverable(String(subRaw))}
                style={{ color: subTone ? roleTextColor(subTone) : 'var(--text-muted)' }}
                data-app-cell-subtext={subTone || 'muted'}
            >
                {String(subRaw)}
            </span>
        </span>
    );
}

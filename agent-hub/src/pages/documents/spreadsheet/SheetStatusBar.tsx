// The slim bar under the grid: what is selected, and for 2+ cells the Sum,
// Average and Count of its numbers. Instant and local; a click on a figure
// copies it.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { formatValue, type Computed } from './sheetEngine';
import { selectionLabel } from './sheetAskText';
import { selectionStats } from './selectionStats';
import { clipToUsed, type Range, type SelectionKind } from './sheetModel';

export interface SheetStatusBarProps {
    range: Range;
    kind: SelectionKind;
    computed: Computed;
    usedRows: number;
    usedCols: number;
}

const COPIED_MS = 1200;
const STAT = 'inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';

function Stat({ id, label, value }: { id: string; label: string; value: string }) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    const copy = () => {
        Promise.resolve(navigator.clipboard?.writeText(value)).catch(() => undefined);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    };
    return (
        <button type="button" onClick={copy} data-testid={`stat-${id}`} title={t('spreadsheet.stats.copy', 'Copy {stat}', { stat: label })} className={STAT}>
            <span className="text-[var(--text-tertiary)]">{copied ? t('spreadsheet.stats.copied', 'Copied') : label}</span>
            <span className="font-medium tabular-nums text-[var(--text-primary)]">{value}</span>
        </button>
    );
}

export default function SheetStatusBar({ range, kind, computed, usedRows, usedCols }: SheetStatusBarProps) {
    const { t } = useTranslation();
    const whole = kind === 'rows' || kind === 'columns' ? kind : null;
    const clipped = useMemo(() => clipToUsed(range, whole, usedRows, usedCols), [range, whole, usedRows, usedCols]);
    const stats = useMemo(() => selectionStats(clipped, computed), [clipped, computed]);
    const label = selectionLabel(t, range, kind);
    const many = stats.cells > 1;
    return (
        <div
            className="shrink-0 flex items-center gap-3 min-h-8 px-3 border-t border-[var(--border-default)] bg-[var(--bg-secondary)]"
            role="status" aria-label={t('spreadsheet.stats.label', 'Selection statistics')} data-testid="sheet-status-bar"
        >
            <span className="text-[12px] text-[var(--text-tertiary)] truncate">
                {label}{many && ` · ${t('spreadsheet.stats.cells_other', '{count} cells', { count: stats.cells })}`}
            </span>
            {many && stats.count > 0 && (
                <div className="flex items-center gap-1 ml-auto">
                    <Stat id="sum" label={t('spreadsheet.stats.sum', 'Sum')} value={formatValue(stats.sum)} />
                    <Stat id="average" label={t('spreadsheet.stats.average', 'Average')} value={formatValue(stats.average)} />
                    <Stat id="count" label={t('spreadsheet.stats.count', 'Count')} value={String(stats.count)} />
                </div>
            )}
        </div>
    );
}

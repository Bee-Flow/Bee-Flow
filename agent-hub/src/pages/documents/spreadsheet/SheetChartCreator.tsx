import { useMemo, useState } from 'react';
import { BarChart3, LineChart, PieChart } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import { cellName, parseCellRef } from './sheetEngine';
import { parseA1Range, type ChartType, type SheetChartConfig, validateChart } from './sheetCharts';
import type { SelectionKind } from './sheetModel';

export interface SheetChartCreatorProps {
    open: boolean;
    onClose: () => void;
    onCreate: (config: SheetChartConfig) => void;
    selection: string | null;
    selectionKind: SelectionKind | null;
    activeCell: string;
    columns: number;
}

const TYPES: { type: ChartType; icon: typeof BarChart3; labelKey: string; defaultLabel: string }[] = [
    { type: 'bar', icon: BarChart3, labelKey: 'spreadsheet.chart.bar', defaultLabel: 'Bar' },
    { type: 'line', icon: LineChart, labelKey: 'spreadsheet.chart.line', defaultLabel: 'Line' },
    { type: 'pie', icon: PieChart, labelKey: 'spreadsheet.chart.pie', defaultLabel: 'Pie' },
];

function suggestRanges(selection: string | null, selectionKind: SelectionKind | null, activeCell: string, columns: number) {
    const r = selection ? parseA1Range(selection) : null;
    if (!r) return { dataRange: '', categoriesRange: '', anchor: activeCell };
    const width = r.c2 - r.c1 + 1;
    let dataR = { ...r };
    let catR: ReturnType<typeof parseA1Range> = null;
    if (width >= 2) {
        catR = { c1: r.c1, c2: r.c1, r1: r.r1 + 1, r2: r.r2 };
        dataR = { c1: r.c1 + 1, c2: r.c2, r1: r.r1 + 1, r2: r.r2 };
    } else if (r.c1 > 0) {
        catR = { c1: r.c1 - 1, c2: r.c1 - 1, r1: r.r1, r2: r.r2 };
    }
    const anchor = cellName(r.c1, Math.min(r.r2 + 2, 1999));
    return {
        dataRange: `${cellName(dataR.c1, dataR.r1)}:${cellName(dataR.c2, dataR.r2)}`,
        categoriesRange: catR ? `${cellName(catR.c1, catR.r1)}:${cellName(catR.c2, catR.r2)}` : '',
        anchor,
    };
}

export default function SheetChartCreator({ open, onClose, onCreate, selection, selectionKind, activeCell, columns }: SheetChartCreatorProps) {
    const { t } = useTranslation();
    const defaults = useMemo(() => suggestRanges(selection, selectionKind, activeCell, columns), [selection, selectionKind, activeCell, columns]);
    const [type, setType] = useState<ChartType>('bar');
    const [title, setTitle] = useState('');
    const [dataRange, setDataRange] = useState(defaults.dataRange);
    const [categoriesRange, setCategoriesRange] = useState(defaults.categoriesRange);
    const [anchor, setAnchor] = useState(defaults.anchor);
    const [error, setError] = useState<string | null>(null);

    if (!open) return null;

    const submit = () => {
        const config: SheetChartConfig = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type,
            title: title.trim() || undefined,
            dataRange: dataRange.trim(),
            categoriesRange: categoriesRange.trim() || undefined,
            anchor: anchor.trim() || activeCell,
            width: 320,
            height: 220,
        };
        const err = validateChart(config);
        if (err) { setError(err); return; }
        setError(null);
        onCreate(config);
        onClose();
    };

    return (
        <div className="absolute top-12 right-4 z-50 w-72 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg shadow-lg p-3 flex flex-col gap-3">
            <div className="text-[13px] font-medium text-[var(--text-primary)]">{t('spreadsheet.chart.create', 'Add chart')}</div>
            <div className="flex gap-1">
                {TYPES.map(({ type: tt, icon: Icon, labelKey, defaultLabel }) => (
                    <button
                        key={tt} type="button" onClick={() => setType(tt)}
                        className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-md text-[11px] border ${type === tt ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] text-[var(--accent-primary)]' : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
                    >
                        <Icon size={16} />{t(labelKey, defaultLabel)}
                    </button>
                ))}
            </div>
            <input
                value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder={t('spreadsheet.chart.title_placeholder', 'Chart title (optional)')}
                className="w-full px-2 py-1 text-[12px] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
            />
            <label className="text-[11px] text-[var(--text-secondary)] flex flex-col gap-0.5">
                {t('spreadsheet.chart.data_range', 'Data range')}
                <input
                    value={dataRange} onChange={(e) => setDataRange(e.target.value)}
                    className="px-2 py-1 text-[12px] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                />
            </label>
            <label className="text-[11px] text-[var(--text-secondary)] flex flex-col gap-0.5">
                {t('spreadsheet.chart.categories_range', 'Categories range (optional)')}
                <input
                    value={categoriesRange} onChange={(e) => setCategoriesRange(e.target.value)}
                    className="px-2 py-1 text-[12px] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                />
            </label>
            <label className="text-[11px] text-[var(--text-secondary)] flex flex-col gap-0.5">
                {t('spreadsheet.chart.anchor', 'Anchor cell')}
                <input
                    value={anchor} onChange={(e) => setAnchor(e.target.value)}
                    className="px-2 py-1 text-[12px] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                />
            </label>
            {error && <div className="text-[11px] text-[var(--error)]">{error}</div>}
            <div className="flex justify-end gap-2">
                <button type="button" onClick={onClose} className="px-2 py-1 text-[12px] rounded hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)]">{t('common.cancel', 'Cancel')}</button>
                <button type="button" onClick={submit} className="px-3 py-1 text-[12px] rounded bg-[var(--accent-primary)] text-white hover:opacity-90">{t('spreadsheet.chart.add', 'Add')}</button>
            </div>
        </div>
    );
}

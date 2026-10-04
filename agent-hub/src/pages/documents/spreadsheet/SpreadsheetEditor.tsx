// A SPREADSHEET: 26 columns of cells that hold text, numbers or formulas
// ("=SUM(A1:A5)"), shown as their results. Saved cell by cell as it is typed
// (useSheet); a viewer reads and copies, nothing more.

import { BarChart3, Download, Sparkles, Table2 } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { StudioSectionHeader } from '../../../components/projects/workspace/studioParts';
import useTranslation, { type TranslateFn } from '../../../hooks/useTranslation';
import type { People, StudioDocument } from '../documentQueries';
import SaveStatusChip from '../editor/SaveStatusChip';
import FormulaBar from './FormulaBar';
import SheetAssistantPanel from './SheetAssistantPanel';
import SheetChartCreator from './SheetChartCreator';
import useSheetCharts from './useSheetCharts';
import SheetGrid from './SheetGrid';
import SheetStatusBar from './SheetStatusBar';
import SheetTabs from './SheetTabs';
import { BUTTON, Notice, SheetLoadError, SheetSkeleton } from './SheetStates';
import { SheetApiError } from './sheetApi';
import { selectionFor } from './sheetModel';
import useAssistantTier from './useAssistantTier';
import useGridState from './useGridState';
import useSheetAsk from './useSheetAsk';
import useSheetAssistant from './useSheetAssistant';
import useSheet, { type SheetState } from './useSheet';
import useSheetActions from './useSheetActions';

export interface SpreadsheetEditorProps {
    initial: StudioDocument;
    people: People;
    variant: 'page' | 'panel';
    currentUser: { id: string; name?: string } | null;
    onBack?: () => void;
    onRenamed?: (doc: StudioDocument) => void;
}

const OPEN_KEY = 'sheetAssistantOpen';
const FORMULA_BAR_KEY = 'sheetFormulaBarVisible';

function storedOpen(): boolean {
    try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}
function storedFormulaBar(): boolean {
    try { return localStorage.getItem(FORMULA_BAR_KEY) === '1'; } catch { return false; }
}

/** The sentence for a failed save. */
function saveFailureText(sheet: SheetState, t: TranslateFn): string | null {
    const e = sheet.error;
    if (!e || sheet.status !== 'error') return null;
    if (e instanceof SheetApiError && e.code === 'sheet_too_large') return t('spreadsheet.too_large', 'This spreadsheet is too large to hold more cells.');
    return e.message || t('spreadsheet.save_failed', 'Could not save your changes.');
}

export default function SpreadsheetEditor({ initial, onBack, onRenamed }: SpreadsheetEditorProps) {
    const { t } = useTranslation();
    const sheet = useSheet(initial.id);
    const grid = useGridState({
        cells: sheet.cells, readOnly: sheet.readOnly, usedRows: sheet.usedRows, columns: sheet.columns, computed: sheet.computed,
        onCommit: sheet.setCells, onUndo: sheet.undo, onRedo: sheet.redo,
    });
    const gridRef = useRef<HTMLElement | null>(null);
    const charts = useSheetCharts(initial);
    const assistant = useSheetAssistant(initial.id, sheet, charts);
    const [assistantOpen, setAssistantOpen] = useState(storedOpen);
    const [chartCreatorOpen, setChartCreatorOpen] = useState(false);
    const showAssistant = (open: boolean) => {
        setAssistantOpen(open);
        try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* the choice just does not outlive the page */ }
    };
    const toggleAssistant = () => showAssistant(!assistantOpen);
    const [formulaBarVisible, setFormulaBarVisible] = useState(storedFormulaBar);
    const showFormulaBar = (open: boolean) => {
        setFormulaBarVisible(open);
        try { localStorage.setItem(FORMULA_BAR_KEY, open ? '1' : '0'); } catch { /* the choice just does not outlive the page */ }
    };
    const toggleFormulaBar = () => showFormulaBar(!formulaBarVisible);
    const tier = useAssistantTier();
    const ask = useSheetAsk({ assistant, grid, usedRows: sheet.usedRows, tier, focusGrid: () => gridRef.current?.focus(), onOpenPanel: () => showAssistant(true) });
    const selection = selectionFor(grid.range, grid.kind, sheet.usedRows, grid.columns);
    const page = useSheetActions({ initial, sheet, onBack, onRenamed });
    // Focus leaving the bar and the grid sends what is queued.
    const onBlur = (e: React.FocusEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) sheet.flush().catch(() => undefined);
    };
    const saveFailure = saveFailureText(sheet, t);
    const ready = !sheet.loading && !sheet.loadError;

    return (
        <div className="relative flex flex-col h-full min-h-0 bg-[var(--bg-primary)]" data-testid="spreadsheet-editor">
            <StudioSectionHeader
                kind="document" icon={Table2} title={page.name}
                onRename={sheet.readOnly ? undefined : (next) => { page.rename(next).catch(() => undefined); }}
                statusChip={sheet.readOnly
                    ? <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="sheet-view-only">{t('spreadsheet.view_only', 'View only')}</span>
                    : <SaveStatusChip state={sheet.status} lastSavedAt={sheet.savedAt} onRetry={sheet.retry} />}
                primary={(
                    <button type="button" className={BUTTON} onClick={() => { page.download().catch(() => undefined); }} disabled={page.downloading || !ready}>
                        <Download size={14} aria-hidden="true" />{t('spreadsheet.download_csv', 'Download CSV')}
                    </button>
                )}
                extras={(
                    <>
                        <button
                            type="button" className={BUTTON} onClick={toggleFormulaBar} aria-pressed={formulaBarVisible}
                            title={formulaBarVisible ? t('spreadsheet.hide_formula_bar', 'Hide formula bar') : t('spreadsheet.show_formula_bar', 'Show formula bar')}
                            disabled={!ready}
                        >
                            <span className="font-mono italic text-[12px]" aria-hidden="true">fx</span>
                        </button>
                        <button
                            type="button" className={BUTTON} onClick={() => setChartCreatorOpen((o) => !o)} aria-pressed={chartCreatorOpen}
                            title={t('spreadsheet.chart.add', 'Add chart')}
                            disabled={!ready}
                        >
                            <BarChart3 size={14} aria-hidden="true" />{t('spreadsheet.chart.add', 'Add chart')}
                        </button>
                        <button type="button" className={BUTTON} onClick={toggleAssistant} aria-pressed={assistantOpen} disabled={!ready}>
                            <Sparkles size={14} aria-hidden="true" />{t('spreadsheet.assistant.open', 'Assistant')}
                        </button>
                    </>
                )}
                onBack={onBack ? () => { page.leave().catch(() => undefined); } : undefined}
                backLabel={t('documents.back', 'Back to Documents')}
            />
            {page.notice && <Notice>{page.notice}</Notice>}
            {saveFailure && <Notice action={<button type="button" className={BUTTON} onClick={sheet.retry}>{t('spreadsheet.retry', 'Retry')}</button>}>{saveFailure}</Notice>}
            <SheetChartCreator
                open={chartCreatorOpen}
                onClose={() => setChartCreatorOpen(false)}
                onCreate={charts.addChart}
                selection={selection}
                selectionKind={grid.kind}
                activeCell={grid.activeName}
                columns={sheet.columns}
            />
            {sheet.loading && <SheetSkeleton />}
            {sheet.loadError && <SheetLoadError onRetry={sheet.reload} onBack={onBack} />}
            {ready && (
                <div className="flex-1 min-h-0 flex">
                    <div className="flex-1 min-w-0 min-h-0 flex flex-col" onBlur={onBlur}>
                        {formulaBarVisible && <FormulaBar grid={grid} readOnly={sheet.readOnly} onDone={() => gridRef.current?.focus()} />}
                        {Object.keys(sheet.cells).length === 0 && !sheet.readOnly && (
                            <p className="shrink-0 m-0 px-4 py-2 text-[13px] text-[var(--text-tertiary)]" data-testid="sheet-empty-hint">
                                {t('spreadsheet.empty_hint', 'Type a value or a formula such as =SUM(A1:A5)')}
                            </p>
                        )}
                        <SheetGrid grid={grid} cells={sheet.cells} computed={sheet.computed} readOnly={sheet.readOnly} flashed={assistant.flashed} ask={ask} containerRef={gridRef} onToggleFormulaBar={toggleFormulaBar} charts={charts.charts} onRemoveChart={charts.removeChart} />
                        <SheetStatusBar range={grid.range} kind={grid.kind} computed={sheet.computed} usedRows={sheet.usedRows} usedCols={grid.usedCols} />
                        <SheetTabs
                            tabs={sheet.tabs}
                            activeTab={sheet.activeTab}
                            readOnly={sheet.readOnly}
                            onChange={sheet.setActiveTab}
                            onAdd={sheet.createTab}
                            onRename={sheet.renameTab}
                            onDelete={sheet.deleteTab}
                        />
                    </div>
                    {assistantOpen && <SheetAssistantPanel assistant={assistant} selection={selection} selectionKind={grid.kind} tier={tier} readOnly={sheet.readOnly} onClose={toggleAssistant} />}
                </div>
            )}
        </div>
    );
}

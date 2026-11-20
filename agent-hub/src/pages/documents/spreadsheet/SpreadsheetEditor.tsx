// A SPREADSHEET: 26 columns of cells that hold text, numbers or formulas
// ("=SUM(A1:A5)"), shown as their results. Saved cell by cell as it is typed
// (useSheet); a viewer reads and copies, nothing more.

import { BarChart3, Download, Maximize2, Sparkles, Table2 } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { StudioSectionHeader } from '@/components/projects/workspace/studioParts';
import useTranslation from '@/hooks/useTranslation';
import type { People, StudioDocument } from '../documentQueries';
import SaveStatusChip from '../editor/SaveStatusChip';
import FormulaBar from './FormulaBar';
import SheetAssistantPanel from './SheetAssistantPanel';
import SheetChartCreator from './SheetChartCreator';
import useSheetCharts from './useSheetCharts';
import { chartsOnTab, type SheetChartConfig } from './sheetCharts';
import SheetGrid from './SheetGrid';
import SheetStatusBar from './SheetStatusBar';
import SheetTabs from './SheetTabs';
import SheetEditorNotices from './SheetEditorNotices';
import { BUTTON, SheetLoadError, SheetSkeleton } from './SheetStates';
import { sheetErrorText } from './sheetErrorText';
import { selectionFor } from './sheetModel';
import useAssistantTier from './useAssistantTier';
import useGridState from './useGridState';
import useSheetAsk from './useSheetAsk';
import useSheetAssistant from './useSheetAssistant';
import useSheet from './useSheet';
import useSheetActions from './useSheetActions';
import { logger } from '@/utils/logger';

export interface SpreadsheetEditorProps {
    initial: StudioDocument;
    people: People;
    variant: 'page' | 'panel';
    currentUser: { id: string; name?: string } | null;
    onBack?: () => void;
    onRenamed?: (doc: StudioDocument) => void;
    /** Beside the chat: open this spreadsheet in Studio. */
    onOpenInStudio?: (id: string) => void;
}

const OPEN_KEY = 'sheetAssistantOpen';
const FORMULA_BAR_KEY = 'sheetFormulaBarVisible';

function storedOpen(): boolean {
    try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}
function storedFormulaBar(): boolean {
    try { return localStorage.getItem(FORMULA_BAR_KEY) === '1'; } catch { return false; }
}

export default function SpreadsheetEditor({ initial, variant, onBack, onRenamed, onOpenInStudio }: SpreadsheetEditorProps) {
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
        try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (err) { logger.debug('the choice just does not outlive the page', err); }
    };
    const toggleAssistant = () => showAssistant(!assistantOpen);
    const [formulaBarVisible, setFormulaBarVisible] = useState(storedFormulaBar);
    const showFormulaBar = (open: boolean) => {
        setFormulaBarVisible(open);
        try { localStorage.setItem(FORMULA_BAR_KEY, open ? '1' : '0'); } catch (err) { logger.debug('the choice just does not outlive the page', err); }
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
    const ready = !sheet.loading && !sheet.loadError;
    const isPanel = variant === 'panel';
    // Beside the chat the back button closes the panel.
    const backLabel = isPanel ? t('documents.close', 'Close') : t('documents.back', 'Back to Documents');

    return (
        <div className="relative flex flex-col h-full min-h-0 bg-[var(--bg-primary)]" data-testid="spreadsheet-editor">
            <StudioSectionHeader
                kind="document" icon={Table2} title={page.name}
                onRename={sheet.readOnly ? undefined : (next) => { page.rename(next).catch(() => undefined); }}
                statusChip={sheet.readOnly
                    ? <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="sheet-view-only">{t('spreadsheet.view_only', 'View only')}</span>
                    : <SaveStatusChip state={sheet.status} lastSavedAt={sheet.savedAt} onRetry={sheet.retry} />}
                primary={(
                    <>
                        <button type="button" className={BUTTON} onClick={() => { page.download('xlsx').catch(() => undefined); }} disabled={page.downloading || !ready}>
                            <Download size={14} aria-hidden="true" />{t('spreadsheet.download_xlsx', 'Download Excel')}
                        </button>
                        <button type="button" className={BUTTON} onClick={() => { page.download('csv').catch(() => undefined); }} disabled={page.downloading || !ready}>
                            <Download size={14} aria-hidden="true" />{t('spreadsheet.download_csv', 'Download CSV')}
                        </button>
                    </>
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
                        {!sheet.readOnly && (
                            <button
                                type="button" className={BUTTON} onClick={() => setChartCreatorOpen((o) => !o)} aria-pressed={chartCreatorOpen}
                                title={t('spreadsheet.chart.add', 'Add chart')}
                                disabled={!ready}
                            >
                                <BarChart3 size={14} aria-hidden="true" />{t('spreadsheet.chart.add', 'Add chart')}
                            </button>
                        )}
                        <button type="button" className={BUTTON} onClick={toggleAssistant} aria-pressed={assistantOpen} disabled={!ready}>
                            <Sparkles size={14} aria-hidden="true" />{t('spreadsheet.assistant.open', 'Assistant')}
                        </button>
                        {isPanel && onOpenInStudio && (
                            <button
                                type="button" className={BUTTON} data-testid="sheet-open-in-studio"
                                onClick={() => { page.openIn(() => onOpenInStudio(initial.id)).catch(() => undefined); }}
                                aria-label={t('documents.open_in_studio', 'Open in Studio')} title={t('documents.open_in_studio', 'Open in Studio')}
                            >
                                <Maximize2 size={14} aria-hidden="true" />
                            </button>
                        )}
                    </>
                )}
                onBack={onBack ? () => { page.leave().catch(() => undefined); } : undefined}
                backLabel={backLabel}
            />
            <SheetEditorNotices
                sheet={sheet} notice={page.notice} chartError={chartCreatorOpen ? null : charts.error}
                limit={grid.limit} onDismissLimit={grid.clearLimit} unsaved={page.unsaved}
            />
            <SheetChartCreator
                open={chartCreatorOpen && !sheet.readOnly}
                onClose={() => setChartCreatorOpen(false)}
                onCreate={(config: SheetChartConfig) => charts.addChart({ ...config, tab: sheet.activeTab })}
                selection={selection}
                selectionKind={grid.kind}
                activeCell={grid.activeName}
                columns={sheet.columns}
            />
            {sheet.loading && <SheetSkeleton />}
            {sheet.loadError && (
                <SheetLoadError
                    message={sheetErrorText(sheet.loadError, t, t('spreadsheet.load_failed', 'Could not load the spreadsheet.'))}
                    onRetry={sheet.reload} onBack={onBack} backLabel={backLabel}
                />
            )}
            {ready && (
                <div className="flex-1 min-h-0 flex">
                    <div className="flex-1 min-w-0 min-h-0 flex flex-col" onBlur={onBlur}>
                        {formulaBarVisible && <FormulaBar grid={grid} readOnly={sheet.readOnly} locale={sheet.locale} onDone={() => gridRef.current?.focus()} />}
                        {Object.keys(sheet.cells).length === 0 && !sheet.readOnly && (
                            <p className="shrink-0 m-0 px-4 py-2 text-[13px] text-[var(--text-tertiary)]" data-testid="sheet-empty-hint">
                                {t('spreadsheet.empty_hint', 'Type a value or a formula such as =SUM(A1:A5)')}
                            </p>
                        )}
                        <SheetGrid grid={grid} cells={sheet.cells} computed={sheet.computed} readOnly={sheet.readOnly} flashed={assistant.flashed} ask={ask} containerRef={gridRef} onToggleFormulaBar={toggleFormulaBar} charts={chartsOnTab(charts.charts, sheet.activeTab)} onRemoveChart={(chartId) => { charts.removeChart(chartId).catch(() => undefined); }} />
                        <SheetStatusBar range={grid.range} kind={grid.kind} computed={sheet.computed} usedRows={sheet.usedRows} usedCols={grid.usedCols} />
                        <SheetTabs
                            tabs={sheet.tabs}
                            activeTab={sheet.activeTab}
                            readOnly={sheet.readOnly}
                            onChange={page.tabs.show}
                            onAdd={page.tabs.add}
                            onRename={page.tabs.rename}
                            // a removed tab takes its charts along on the server: show that list
                            onDelete={async (tabId) => { await page.tabs.remove(tabId); await charts.reload(); }}
                        />
                    </div>
                    {assistantOpen && <SheetAssistantPanel assistant={assistant} selection={selection} selectionKind={grid.kind} tier={tier} readOnly={sheet.readOnly} onClose={toggleAssistant} />}
                </div>
            )}
        </div>
    );
}

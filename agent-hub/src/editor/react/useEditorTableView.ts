import { useCallback, useEffect, useRef } from 'react';
import { tableToMatrix } from '../engine/formula.js';
import { chainOf } from './beeEditorHelpers';
import type { EditorShared } from './beeEditorTypes';
import { loadCollapsed, loadHiddenHeaders, saveCollapsed, saveHiddenHeaders } from './tableViewState';

/**
 * Table view state (collapse, hidden column names) and the chart modal of
 * BeeEditor: the third block of hooks of the component, in the order the body
 * always declared them.
 */
export default function useEditorTableView(s: EditorShared, notebookId: string | number | null | undefined, refreshChrome: () => void) {
  const { viewRef, collapsed, setCollapsed, hiddenHeaders, setHiddenHeaders, setChartConfig } = s;

  // Collapse state is view-only (never serialized): reload on notebook switch,
  // persist on change, and re-apply the `bf-collapsed` class to each table el
  // after every render (the reconciler may recreate table elements).
  const prevNbRef = useRef(notebookId);
  useEffect(() => {
    if (prevNbRef.current !== notebookId) {
      prevNbRef.current = notebookId;
      setCollapsed(loadCollapsed(notebookId));
      setHiddenHeaders(loadHiddenHeaders(notebookId));
    }
  }, [notebookId, setCollapsed, setHiddenHeaders]);
  useEffect(() => { saveCollapsed(notebookId, collapsed); }, [collapsed, notebookId]);
  useEffect(() => { saveHiddenHeaders(notebookId, hiddenHeaders); }, [hiddenHeaders, notebookId]);
  useEffect(() => {
    const v = viewRef.current;
    if (!v?.allTables) return;
    for (const { el, ordinal } of v.allTables()) { if (el) el.classList.toggle('bf-collapsed', collapsed.has(ordinal)); }
  });

  const toggleCollapseFocused = useCallback(() => {
    const info = viewRef.current?.tableInfo?.();
    if (!info) return;
    setCollapsed((prev) => { const n = new Set(prev); if (n.has(info.ordinal)) n.delete(info.ordinal); else n.add(info.ordinal); return n; });
  }, [setCollapsed, viewRef]);

  // Open the chart config modal, seeded with the current table's columns/rows.
  const openChartModal = useCallback(() => {
    const info = viewRef.current?.tableInfo?.();
    if (!info) return;
    const matrix = tableToMatrix(info.node);
    if (!matrix.length || !matrix[0]?.length) return;
    setChartConfig({ columns: matrix[0], rows: matrix.slice(1) });
  }, [setChartConfig, viewRef]);
  const createChart = useCallback((spec: unknown) => {
    setChartConfig(null);
    const view = viewRef.current;
    if (view) chainOf(view).focus().insertAfterTable({ type: 'chart', attrs: { spec: JSON.stringify(spec) } }).run();
    refreshChrome();
  }, [refreshChrome, setChartConfig, viewRef]);

  return { toggleCollapseFocused, openChartModal, createChart };
}

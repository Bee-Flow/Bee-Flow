/**
 * BeeEditorView — what BeeEditor draws: the toolbar, the scrolling surface
 * with the editable host and its overlays, the bubbles and menus, and the atom
 * portals. Purely presentational: every piece of state, every ref and every
 * handler comes from BeeEditor's hooks.
 */
import { ChevronDown, ChevronRight, Loader2, BarChart3 } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import AtomRenderer from './AtomRenderer';
import AskPortal from './bubbles/AskPortal';
import FormatBubble from './bubbles/FormatBubble';
import ImageBubble from './bubbles/ImageBubble';
import type { BeeEditorProps, EditorShared } from './beeEditorTypes';
import { makeFacade } from './editorFacade';
import ChartConfigModal from './ChartConfigModal';
import ChromeBoundary from './ChromeBoundary';
import { selectionRect, selectionText } from './editorDom';
import EditorToolbar from './EditorToolbar';
import FindBar from './FindBar';
import GeneratingOverlay from './GeneratingOverlay';
import { LinkBubble, LinkEditor } from './LinkTools';
import RangeOverlay from './RangeOverlay';
import RemoteCursorsLayer from './RemoteCursorsLayer';
import ShortcutsSheet from './ShortcutsSheet';
import SlashMenu from './SlashMenu';
import { TableControls } from './TableControls';
import { Item, mkTt } from './toolbarPrimitives';
import type useEditorInteractions from './useEditorInteractions';
import type { EditorSync } from './useEditorSync';
import type useEditorTableView from './useEditorTableView';

interface BeeEditorViewProps {
  s: EditorShared;
  props: BeeEditorProps;
  sync: EditorSync;
  ix: ReturnType<typeof useEditorInteractions>;
  tableView: ReturnType<typeof useEditorTableView>;
  uploadImage: (file: File) => Promise<void>;
  /** The section drag layer (a JavaScript component), drawn while the editor is editable. */
  dragLayer: ReactNode;
}

export default function BeeEditorView({ s, props, sync, ix, tableView, uploadImage, dragLayer }: BeeEditorViewProps) {
  const {
    onAIAction, onAIFill, onImportClick, saving, generating, aiFilling, askAiEnabled = true, collab: collabHandle = null,
  } = props;
  const {
    t, hostRef, viewInst, setWrapEl, wrapEl, tick, linkEdit, findOpen, setFindOpen, findFocus, setFindFocus,
    shortcutsOpen, setShortcutsOpen, uploadError, imageInputRef, atoms, wordCount, ask, setAsk,
    askQuery, setAskQuery, chartConfig, setChartConfig, collapsed, hiddenHeaders,
  } = s;
  const { chrome, collab, effectiveEditable, anchors } = sync;
  const { toggleHeadersFocused, openLinkEditor, closeLinkEditor, applyLinkHref, removeLinkHere, aiAction, openAskFromSelection, insertItems, toolbarInsertItems, runInsert, slash, setSlash, runSlash } = ix;
  const { toggleCollapseFocused, openChartModal, createChart } = tableView;

  const tt = mkTt(t);
  // The view and its facade come from state (set together with viewRef when the
  // view mounts), so render never reads a ref. The facade is stateless: one per view.
  const view = viewInst;
  const editor = useMemo(() => (view ? makeFacade(view) : null), [view]);
  const selectedAtomNode = view?.getSelectedNode?.() || null;
  // Re-evaluated each render; BeeEditor re-renders on selection changes (chrome),
  // so the toolbar's AI items enable/disable as the selection changes.
  const hasSelection = !!(view && selectionText(view).trim());
  // The table the caret sits in (for the on-edit add-row/add-column controls).
  const tableInfo = editor && effectiveEditable ? (view?.tableInfo?.() || null) : null;
  const tableCollapsed = tableInfo ? collapsed.has(tableInfo.ordinal) : false;
  const headersHidden = tableInfo ? hiddenHeaders.has(tableInfo.ordinal) : false;

  return (
    <div className="bf-editor flex flex-col h-full relative [background:var(--bg-primary)]">
      <input ref={imageInputRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.target.value = ''; }} />

      {editor && effectiveEditable && (
        <EditorToolbar
          editor={editor}
          t={t}
          onLink={openLinkEditor}
          onShowShortcuts={() => setShortcutsOpen(true)}
          onFind={() => { setFindOpen(true); setFindFocus((n) => n + 1); }}
          insertItems={toolbarInsertItems}
          onInsert={runInsert}
          onToggleColumnNames={toggleHeadersFocused}
          columnNamesHidden={headersHidden}
          onImportClick={onImportClick}
          onAIFill={onAIFill}
          aiFilling={aiFilling}
          askAiEnabled={askAiEnabled}
          saving={saving}
          wordCount={wordCount}
          onAIAction={aiAction}
          onAsk={openAskFromSelection}
          hasSelection={hasSelection}
          tableMenuExtras={({ inTable, setOpen }) => (
            <>
              <Item icon={BarChart3} label={tt('notebooks.create_chart', 'Create chart')} disabled={!inTable} onClick={() => { openChartModal(); setOpen(false); }} />
              <Item icon={tableCollapsed ? ChevronDown : ChevronRight} label={tableCollapsed ? tt('notebooks.expand_table', 'Expand table') : tt('notebooks.collapse_table', 'Collapse table')} disabled={!inTable} onClick={() => { toggleCollapseFocused(); setOpen(false); }} />
            </>
          )}
        />
      )}

      {generating && <GeneratingOverlay label={generating} t={t} />}

      {collab.loading && (
        <div role="status" className="bf-collab-loading">
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
          {t('editor.collab_loading', 'Opening the live document…')}
        </div>
      )}
      {uploadError && (
        <div role="status" className="bf-editor-notice">
          {t('editor.image_upload_failed', 'The image could not be uploaded. Try again, or use a smaller image.')}
        </div>
      )}

      <div className="flex-1 overflow-y-auto custom-scrollbar" onScroll={chrome.onScroll}>
        {findOpen && viewInst && (
          <FindBar
            view={viewInst}
            editable={effectiveEditable}
            tick={tick}
            container={wrapEl}
            focusSignal={findFocus}
            onClose={() => setFindOpen(false)}
          />
        )}
        <div ref={setWrapEl} className="bf-editor-surface max-w-[820px] mx-auto px-8 py-6">
          {editor && effectiveEditable && dragLayer}
          <div ref={hostRef} className="notebook-editor bf-content" aria-busy={collab.loading || undefined} />
          <RangeOverlay layers={anchors.layers} container={wrapEl} tick={tick} />
          {collab.bound && (
            <RemoteCursorsLayer view={viewInst} binding={collab.binding} peers={collabHandle?.peers || []} container={wrapEl} tick={tick} />
          )}
        </div>
      </div>

      {/* contextual format bubble (inline marks + block + AI) */}
      {editor && effectiveEditable && (
        <FormatBubble
          onLink={openLinkEditor}
          view={view}
          editor={editor}
          t={t}
          askAiEnabled={askAiEnabled}
          onAction={aiAction}
          onAsk={(anchor, from, to, text) => { setAsk({ anchor, from, to, text }); setAskQuery(''); }}
          askOpen={!!ask || !!linkEdit}
        />
      )}

      {/* slash command menu (/ for block insertion) */}
      {editor && effectiveEditable && slash && (
        <SlashMenu
          items={insertItems}
          query={slash.query}
          rect={slash.rect}
          onSelect={runSlash}
          onClose={() => setSlash(null)}
        />
      )}

      {/* table add-row / add-column + collapse controls (caret inside a table) */}
      {editor && effectiveEditable && tableInfo && (
        <ChromeBoundary label="table controls">
          <TableControls view={view} info={tableInfo} t={t} collapsed={tableCollapsed} onToggleCollapse={toggleCollapseFocused} headersHidden={headersHidden} />
        </ChromeBoundary>
      )}

      {/* image bubble */}
      {editor && effectiveEditable && selectedAtomNode?.type === 'image' && (
        <ImageBubble view={view} node={selectedAtomNode} />
      )}

      {/* link bubble (caret inside a link) and the inline link editor */}
      {editor && !linkEdit && editor.isActive('link') && (() => {
        const rect = selectionRect();
        if (!rect) return null;
        return <LinkBubble rect={rect} href={String(editor.getAttributes('link').href || '')} editable={effectiveEditable} onEdit={openLinkEditor} onRemove={removeLinkHere} />;
      })()}
      {linkEdit && linkEdit.rect && (
        <LinkEditor rect={linkEdit.rect} initialHref={linkEdit.href} canRemove={linkEdit.canRemove}
          onApply={applyLinkHref} onRemove={removeLinkHere} onClose={closeLinkEditor} />
      )}
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* ask AI floating portal */}
      {ask && (
        <AskPortal
          ask={ask} query={askQuery} setQuery={setAskQuery} t={t}
          onSubmit={() => { if (askQuery.trim()) onAIAction?.('ask', ask.text, { from: ask.from, to: ask.to }, askQuery.trim()); setAsk(null); }}
          onClose={() => setAsk(null)}
        />
      )}

      {/* chart config modal */}
      {chartConfig && (
        <ChartConfigModal
          columns={chartConfig.columns}
          rows={chartConfig.rows}
          t={t}
          onCreate={createChart}
          onClose={() => setChartConfig(null)}
        />
      )}

      {/* atom portals */}
      {atoms.map((a) => createPortal(
        <AtomRenderer
          node={a.node}
          view={view}
          selected={selectedAtomNode === a.node}
          editable={effectiveEditable}
          brokenLabel={t('notebooks.atom_render_failed', 'Could not display this block')}
        />,
        a.host, a.id,
      ))}
    </div>
  );
}

/**
 * SectionDragLayer — floating drag handle + heading-aware block reordering.
 *
 * Uses pointer events (not HTML5 draggable) because native drag fights
 * contenteditable. Hovering a top-level block shows a grip (or an H{n} section
 * badge for headings); dragging shows a drop-indicator line and on release moves
 * the block — or, for a heading, the whole section (until the next heading of
 * equal-or-higher level).
 *
 * While co-editing, a move is a delete plus an insert in the shared document,
 * so text a colleague is typing inside the moved part would be lost. `isLocked`
 * (fromIdx, count) says when someone's caret is in there; the handle then says
 * so and does not start a drag. Others keep editing during a drag, so the drop
 * moves the blocks that were grabbed wherever they are by then (not whatever
 * sits at their old index), to where the pointer is now, and asks `isLocked`
 * again; blocks that were changed or split up meanwhile are not moved.
 */
import React, { useEffect, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { mkTt } from './toolbarPrimitives.jsx';
import useTranslation from '../../hooks/useTranslation';
import { findBlocks, getSectionRange, moveBlocks } from '../engine/sectionDrag.js';

export default function SectionDragLayer({ hostRef, viewRef, isLocked = null }) {
  const { t } = useTranslation();
  // The ONE shared shim. It is a straight pass-through to `t`, which already
  // does key → dictionary → English fallback and interpolates `{level}` on
  // BOTH. The local copy this replaced resolved the fallback itself and
  // dropped the params argument, which is why the section title had to
  // `.replace('{level}', …)` afterwards — a patch that reached the dictionary
  // value only, so a missing key showed the literal `{level}` to the user.
  const tt = mkTt(t);
  const [hover, setHover] = useState(null); // { idx, top, level }
  const [dropTop, setDropTop] = useState(null);
  const dragRef = useRef(null);
  const isLockedRef = useRef(isLocked);
  useEffect(() => { isLockedRef.current = isLocked; }, [isLocked]);

  const blockItems = () => {
    const host = hostRef.current;
    if (!host) return [];
    return Array.from(host.children).map((el, i) => ({ el, i, rect: el.getBoundingClientRect() }));
  };
  const hostOriginTop = () => {
    const host = hostRef.current;
    return host.getBoundingClientRect().top - host.offsetTop;
  };
  /** The block index a drop at `clientY` lands before, and where to draw the line. */
  const dropTarget = (clientY) => {
    const items = blockItems();
    const origin = hostOriginTop();
    for (const it of items) {
      if (clientY < it.rect.top + it.rect.height / 2) return { dropIdx: it.i, lineTop: it.rect.top - origin };
    }
    return { dropIdx: items.length, lineTop: items.length ? items[items.length - 1].rect.bottom - origin : 0 };
  };

  useEffect(() => {
    const host = hostRef.current;
    // Listen on the wrapper (host + left gutter) so moving onto the handle, which
    // sits in the gutter, doesn't clear the hover before it can be grabbed.
    const container = host?.parentElement;
    if (!host || !container) return undefined;
    const onMove = (e) => {
      if (dragRef.current) return;
      const items = blockItems();
      let hit = items.find((it) => e.clientY >= it.rect.top - 2 && e.clientY <= it.rect.bottom + 2);
      if (!hit && items.length) hit = items[items.length - 1]; // below last block
      if (!hit) { setHover(null); return; }
      const view = viewRef.current;
      const node = view?.state.doc.content[hit.i];
      const lockedNow = !!(view && isLockedRef.current && isLockedRef.current(hit.i, getSectionRange(view.state.doc, hit.i)));
      setHover({ idx: hit.i, top: hit.rect.top - hostOriginTop(), level: node?.type === 'heading' ? (node.attrs?.level || 1) : null, locked: lockedNow });
    };
    const onLeave = () => { if (!dragRef.current) setHover(null); };
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    return () => { container.removeEventListener('mousemove', onMove); container.removeEventListener('mouseleave', onLeave); };
  }, [hostRef, viewRef]);

  const startDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const view = viewRef.current;
    if (!view || hover == null) return;
    const count = getSectionRange(view.state.doc, hover.idx);
    if (isLocked && isLocked(hover.idx, count)) return;
    // The blocks themselves, not their indices: others may edit above them meanwhile.
    const blocks = (view.state.doc.content || []).slice(hover.idx, hover.idx + count);
    dragRef.current = { fromIdx: hover.idx, blocks };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';

    const onMove = (ev) => { setDropTop(dropTarget(ev.clientY).lineTop); };
    const onUp = (ev) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      const d = dragRef.current;
      dragRef.current = null;
      setDropTop(null);
      setHover(null);
      if (!d) return;
      const { dropIdx } = dropTarget(ev.clientY);
      const n = d.blocks.length;
      view.dispatch((s) => {
        const from = findBlocks(s.doc, d.blocks, d.fromIdx);
        if (from < 0) return s;
        const lockedNow = isLockedRef.current;
        if (lockedNow && lockedNow(from, n)) return s;
        return moveBlocks(s, from, n, dropIdx);
      }, { kind: 'structural' });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const locked = !!hover?.locked;

  return (
    <>
      {hover && (
        <div
          className={`bf-drag-handle${locked ? ' bf-drag-handle--locked' : ''}`}
          onMouseDown={startDrag}
          style={{
            top: hover.top,
            background: hover.level ? 'rgba(59,130,246,0.12)' : 'transparent',
            border: hover.level ? '1px solid rgba(59,130,246,0.3)' : '1px solid transparent',
            color: hover.level ? '#60a5fa' : 'var(--text-tertiary)',
          }}
          title={locked
            ? tt('editor.drag_locked', 'Someone is editing here; you can move it when they are done')
            : hover.level
              ? tt('notebooks.drag_section', 'Drag to move the whole H{level} section', { level: hover.level })
              : tt('notebooks.drag_block', 'Drag to reorder this block')}
          aria-disabled={locked || undefined}
        >
          {hover.level
            ? <span style={{ fontSize: 9, fontWeight: 700, lineHeight: 1, userSelect: 'none' }}>H{hover.level}≡</span>
            : <GripVertical className="w-3.5 h-3.5" strokeWidth={2} />}
        </div>
      )}
      {dropTop != null && <div className="bf-drop-indicator" style={{ top: dropTop }} />}
    </>
  );
}

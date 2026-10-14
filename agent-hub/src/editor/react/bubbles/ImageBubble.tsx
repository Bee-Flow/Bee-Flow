/** ImageBubble — alignment, text wrap, width and delete for the selected image. */
import { AlignLeft, AlignCenter, AlignRight, Trash2, WrapText } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AtomNode } from '../AtomRenderer';

interface Props { view: any; node: AtomNode }

export default function ImageBubble({ view, node }: Props) {
  const rect = useNodeRect(view, node);
  if (!rect) return null;
  const attrs = node.attrs || {};
  const setAttr = (a: Record<string, unknown>) => view.updateAtom(node, a);
  const width = (pct: number) => { const w = pct === 100 ? null : Math.round(((view.host.clientWidth - 40) * pct) / 100); setAttr({ width: w }); };
  return (
    <div className="fixed z-[9998] flex items-center gap-0.5 px-1.5 py-1 rounded-xl shadow-xl border backdrop-blur-md"
      style={{ top: rect.top - 44, left: rect.left, background: 'var(--bg-primary)', borderColor: 'var(--border-default)' }}
      onMouseDown={(e) => e.preventDefault()}>
      {['left', 'center', 'right'].map((al) => {
        const Icon = al === 'left' ? AlignLeft : al === 'center' ? AlignCenter : AlignRight;
        return <button key={al} onClick={() => setAttr({ alignment: al })} className={`p-1.5 rounded-lg ${(attrs.alignment || 'center') === al ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}><Icon className="w-3.5 h-3.5" /></button>;
      })}
      <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border-subtle)' }} />
      <button onClick={() => setAttr({ textWrap: !attrs.textWrap })} className={`p-1.5 rounded-lg ${attrs.textWrap ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}><WrapText className="w-3.5 h-3.5" /></button>
      <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border-subtle)' }} />
      {[25, 50, 75, 100].map((p) => {
        const full = view.host ? view.host.clientWidth - 40 : 0;
        const cur = attrs.width || (full || null);
        const activePct = !attrs.width ? 100 : (full ? Math.round((attrs.width / full) * 100) : null);
        const isActive = activePct != null && Math.abs(activePct - p) <= 4;
        return <button key={p} title={`${p}%`} onClick={() => width(p)} className={`px-1.5 py-1 rounded-lg text-[10px] font-semibold ${isActive ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>{p}%</button>;
      })}
      <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border-subtle)' }} />
      <button onClick={() => view.deleteAtom(node)} className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10"><Trash2 className="w-3.5 h-3.5" /></button>
    </div>
  );
}

function useNodeRect(view: any, node: AtomNode) {
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!view) return undefined;
    const update = () => {
      const el = view.domForNode.get(node);
      if (el) { const r = el.getBoundingClientRect(); setRect({ top: r.top, left: r.left + 8 }); }
    };
    update();
    // Keep the bubble glued to the image while the document scrolls / resizes.
    const scroller = view.host?.closest('.overflow-y-auto') || window;
    scroller.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { scroller.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [view, node]);
  return rect;
}

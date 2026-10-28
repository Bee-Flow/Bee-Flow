/** AskPortal — the floating "Ask AI" box anchored on the selected text. */
import { Wand2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { mkTt } from '../toolbarPrimitives.jsx';

/** The selection the question is about, and where on screen to anchor the box. */
export interface AskState { anchor: { top: number; left: number }; from: number; to: number; text: string }

interface Props {
  ask: AskState;
  query: string;
  setQuery: (query: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  t: TranslateFn;
}

export default function AskPortal({ ask, query, setQuery, onSubmit, onClose, t }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const tt = mkTt(t);
  useEffect(() => { const id = requestAnimationFrame(() => inputRef.current?.focus()); return () => cancelAnimationFrame(id); }, []);
  useEffect(() => {
    const h = (e: MouseEvent) => { const p = document.querySelector('[data-ask-portal]'); if (p && !p.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  const preview = (ask.text || '').slice(0, 120);
  // Clamp to the viewport: keep within the right edge, and drop below the
  // selection when there isn't room above (mirrors the old editor).
  const W = 360;
  const left = Math.max(8, Math.min(ask.anchor.left, (typeof window !== 'undefined' ? window.innerWidth : 1200) - W - 8));
  const above = ask.anchor.top - 52;
  const top = above < 8 ? ask.anchor.top + 24 : above;
  return (
    <div data-ask-portal className="fixed z-[9999] flex flex-col rounded-xl shadow-2xl border backdrop-blur-md overflow-hidden"
      style={{ top, left, minWidth: 280, maxWidth: W, background: 'var(--bg-primary)', borderColor: 'var(--border-default)' }}
      onMouseDown={(e) => e.stopPropagation()}>
      {preview && (
        <div className="px-3 pt-2 pb-1.5 text-[10px] border-b [border-color:var(--border-subtle)]! [background:var(--bg-tertiary)] [color:var(--text-secondary)]!">
          <div className="text-[9px] font-semibold uppercase tracking-wide mb-0.5 text-[var(--text-tertiary)]">{tt('notebooks.selected_text', 'Selected text')}</div>
          <p className="italic line-clamp-3">{preview}</p>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Wand2 className="w-3 h-3 text-[var(--accent-primary)]" />
        <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tt('notebooks.ask_ai_placeholder', 'Ask me…')}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } else if (e.key === 'Escape') onClose(); }}
          className="bg-transparent border-none outline-none text-[11px] w-[200px] text-[var(--text-primary)]" />
        <button onMouseDown={(e) => { e.preventDefault(); onSubmit(); }} className="px-2 py-1 rounded-lg text-[10px] font-bold bg-[var(--accent-primary)] text-white" disabled={!query.trim()}>{tt('notebooks.send', 'Send')}</button>
        <button onMouseDown={(e) => { e.preventDefault(); onClose(); }} className="px-1.5 py-1 text-[var(--text-tertiary)]">×</button>
      </div>
    </div>
  );
}

/** GeneratingOverlay — the "Generating …" veil over the editor while an AI write runs. */
import { Loader2 } from 'lucide-react';
import type { TranslateFn } from '../../hooks/useTranslation';

interface Props {
  /** What is being generated (an id such as `meeting_notes`; underscores read as spaces). */
  label: string;
  t: TranslateFn;
}

export default function GeneratingOverlay({ label, t }: Props) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none [background:rgba(127,127,127,0.06)]">
      <div className="flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border text-sm font-semibold [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]!">
        <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)]" />
        <span>{t('editor.generating', 'Generating {what}…', { what: String(label).replace(/_/g, ' ') })}</span>
        <span className="flex gap-0.5">
          {[0, 1, 2].map((i) => <span key={i} className="w-1 h-1 rounded-full animate-bounce" style={{ background: 'var(--accent-primary)', animationDelay: `${i * 120}ms` }} />)}
        </span>
      </div>
    </div>
  );
}

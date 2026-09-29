import { Sparkles } from 'lucide-react';
import React from 'react';
import { createPortal } from 'react-dom';
import useTranslation from '../../../../../hooks/useTranslation';
import { APP_COMPONENT_TYPES } from '../runtime/componentRegistry';

/**
 * The dashed cell where the component being typed will land — portalled into
 * the real <section data-section-id> element (the same Map the empty-section
 * drop zone uses) so it takes a real grid slot at the type's default span.
 * The label reads as it is typed (caret while the string is open); the
 * kicker counts the batch. No accent on the ghost — the accent belongs to the
 * landing cell that replaces it.
 *
 * Under reduced motion the ghost still renders (it is information: where the
 * next card lands) but editor.css stills its dots and caret.
 */
export default function GhostCell({ draft, container }) {
    const { t } = useTranslation();
    if (!draft || !container) return null;
    const entry = draft.type ? APP_COMPONENT_TYPES[draft.type] : null;
    const Icon = (entry && entry.icon) || Sparkles;
    return createPortal(
        <div
            className="ase-ghost-cell pointer-events-none flex min-h-[64px] flex-col justify-center gap-1 rounded-[var(--app-radius,8px)] border border-dashed px-3 py-2"
            style={{ gridColumn: `span ${draft.span}`, borderColor: 'var(--border-default)', background: 'var(--bg-secondary)', opacity: 0.8 }}
            data-testid="ghost-cell"
            data-type={draft.type || undefined}
            aria-hidden="true"
        >
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-md" style={{ background: 'var(--bg-tertiary)' }}>
                    <Icon size={12} />
                </span>
                <span>{t('app_studio.builder.draft.component_of', 'Component {i} of {n}', { i: draft.index, n: draft.count })}</span>
                {draft.type && <span>· {draft.typeLabel}</span>}
            </div>
            <div className="flex items-center gap-1 text-sm text-[var(--text-secondary)]">
                <span className="truncate">{draft.caption}</span>
                {draft.partial && <span className="bf-caret" />}
            </div>
            <div className="flex gap-1">
                {[0, 1, 2].map((i) => (
                    <span key={i} className="inline-block h-1 w-1 animate-bounce rounded-full bg-[var(--text-tertiary)]" style={{ animationDelay: `${i * 150}ms` }} />
                ))}
            </div>
        </div>,
        container,
    );
}

/**
 * One place in a conversation where a document's fill-in form could be shown.
 * A conversation that fills in a template answers many times about the same
 * document; only the LAST of those places shows the form, the earlier ones a
 * line that leads there. So there is one form to fill in per document, however
 * long the conversation gets, and one read of the document, not one per answer.
 *
 * "Last" is the place furthest down the page, so it needs nothing from the
 * chat that renders the answers: a person's own chat and a project's team chat
 * wrap their forms in the same slot.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';

import useTranslation from '@/hooks/useTranslation';

const slots = new Map<string, Set<HTMLElement>>();
const listeners = new Set<() => void>();

const tell = () => { for (const listener of listeners) listener(); };

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function register(documentId: string, el: HTMLElement): () => void {
    const set = slots.get(documentId) ?? new Set<HTMLElement>();
    slots.set(documentId, set.add(el));
    tell();
    return () => {
        set.delete(el);
        if (set.size === 0) slots.delete(documentId);
        tell();
    };
}

/** The slot of this document furthest down the page, or null while none is on it. */
function lastSlot(documentId: string): HTMLElement | null {
    let last: HTMLElement | null = null;
    for (const el of slots.get(documentId) ?? []) {
        if (!last || (last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) last = el;
    }
    return last;
}

export default function FillSlot({ documentId, children }: { documentId: string; children: ReactNode }) {
    const { t } = useTranslation();
    const [el, setEl] = useState<HTMLDivElement | null>(null);
    const last = useSyncExternalStore(subscribe, () => lastSlot(documentId), () => null);
    useEffect(() => (el ? register(documentId, el) : undefined), [documentId, el]);
    // Until this place is on the page nothing is shown: an earlier answer never loads a form it will not show.
    const placed = el !== null && last !== null;
    return (
        <div ref={setEl} data-testid="template-fill-slot">
            {placed && last === el && children}
            {placed && last !== el && (
                <button type="button" data-testid="template-fill-earlier"
                    onClick={() => last.scrollIntoView?.({ block: 'start', behavior: 'smooth' })}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]">
                    <ArrowDown size={12} aria-hidden="true" />
                    {t('chat_templates.form_continues', 'The form continues under a later answer')}
                </button>
            )}
        </div>
    );
}

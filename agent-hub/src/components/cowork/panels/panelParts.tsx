/**
 * The small parts the four panels of the Cowork sheet share (Settings, Teamwork, Templates, Organisation): the panel
 * shell with its heading and Escape-to-close, a titled card, a switch row with a 44px target, a labelled field, and
 * the one-line problem and note styles. Bee Flow tokens only.
 */
import type { ReactNode } from 'react';
import { useId } from 'react';
import Toggle from '@/components/shared/Toggle';
import { errorMessage } from '@/utils/caughtError';

export const CARD = 'flex flex-col gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4';
export const META = 'text-[12.5px] leading-relaxed text-[var(--text-secondary)]';
export const INPUT = 'min-h-[44px] w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-[14px] text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
/** A button of the Button primitive that is at least 44px tall. */
export const TALL = 'min-h-[44px]';

/** The shell of a panel in the sheet: a heading, a one-line meta, and Escape asks the sheet to close. */
export function PanelShell({ title, meta, tag, onClose, testId, children }: { title: string; meta?: string; tag?: string; onClose: () => void; testId: string; children: ReactNode }) {
    const headingId = useId();
    return (
        <div
            className="flex flex-col gap-5 pb-6"
            data-testid={testId}
            aria-labelledby={headingId}
            role="region"
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        >
            <header className="flex flex-col gap-1">
                {tag && <span className="self-start rounded-full bg-[var(--bg-tertiary)] px-2.5 py-0.5 text-[11.5px] font-semibold text-[var(--text-primary)]">{tag}</span>}
                <h2 id={headingId} className="m-0 text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">{title}</h2>
                {meta && <p className={`m-0 ${META}`}>{meta}</p>}
            </header>
            {children}
        </div>
    );
}

/** A titled group of cards. */
export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
    const headingId = useId();
    return (
        <section className="flex flex-col gap-2.5" aria-labelledby={headingId}>
            <h3 id={headingId} className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{title}</h3>
            {children}
        </section>
    );
}

/** One switch with its sentence; the whole row is the 44px target. */
export function SwitchRow({ id, label, sub, checked, disabled, onChange }: { id: string; label: string; sub?: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
    return (
        <div className="flex min-h-[44px] items-center justify-between gap-4 py-1">
            <div className="min-w-0">
                <label htmlFor={id} className="block text-[14px] font-medium text-[var(--text-primary)]">{label}</label>
                {sub && <p className={`m-0 ${META}`}>{sub}</p>}
            </div>
            <Toggle id={id} checked={checked} disabled={disabled} onChange={onChange} />
        </div>
    );
}

/** A label tied to the one control inside it. */
export function LabeledField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor={id} className="text-[12.5px] font-medium text-[var(--text-primary)]">{label}</label>
            {children}
        </div>
    );
}

/** What went wrong, in one plain sentence. */
export function Problem({ error, fallback }: { error: Error | null | undefined; fallback: string }) {
    if (!error) return null;
    return <p role="alert" className="m-0 text-[12.5px] text-[var(--error-ink)]">{errorMessage(error) || fallback}</p>;
}

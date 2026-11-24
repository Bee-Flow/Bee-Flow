/**
 * The small parts the four pages beside the tasks share (Preferences, Teamwork, Templates, Admin rules): the page's
 * heading with its one-line meta, a titled section, a card, a switch row, a labelled field, and the one-line problem
 * style. The look is ../coworkUi.ts, so these pages and an opened task read as one product.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';
import Toggle from '@/components/shared/Toggle';
import { errorMessage } from '@/utils/caughtError';
import { ALERT, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD as SURFACE, FIELD_WIDE, ICON_BUTTON, LABEL, LINK_BUTTON, LINK_INLINE, TAG_PLAIN } from '../coworkUi';

export { META } from '../coworkUi';

export const CARD = `flex flex-col gap-3 p-4 ${SURFACE}`;
export const INPUT = FIELD_WIDE;
/** The body sentence of a card. */
export const BODY = 'm-0 text-[14px] leading-5 text-[var(--text-primary)]';
/** The small heading over a value (in a preview, an example). */
export const EYEBROW = 'text-[12px] leading-4 font-medium text-[var(--text-tertiary)]';
const META_LINE = 'm-0 text-[13px] leading-5 text-[var(--text-secondary)]';

const LOOK = { primary: BUTTON_PRIMARY, secondary: BUTTON_SECONDARY, link: LINK_BUTTON, inline: LINK_INLINE, icon: ICON_BUTTON } as const;

interface PanelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    /** The one primary action (the default), the secondary one, a quiet text action at the start of a line (`link`) or beside a button (`inline`), or one icon. */
    look?: keyof typeof LOOK;
    /** Work is in flight: the button is off until it ends. */
    busy?: boolean;
}

/** A button of these pages, in the one look of ../coworkUi.ts. */
export function PanelButton({ look = 'primary', busy = false, disabled, className = '', type = 'button', ...rest }: PanelButtonProps) {
    return <button type={type} {...rest} disabled={busy || disabled} aria-busy={busy || undefined} className={`${LOOK[look]} ${className}`} />;
}

/** A page: its heading (the page frame moves the focus to it), a one-line meta, then its sections. */
export function PanelShell({ title, meta, tag, testId, children }: { title: string; meta?: string; tag?: string; testId: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-6" data-testid={testId}>
            <header className="flex flex-col items-start gap-1">
                {tag && <span className={TAG_PLAIN}>{tag}</span>}
                <h1 className="m-0 text-[20px] leading-7 font-semibold text-[var(--text-primary)] outline-none">{title}</h1>
                {meta && <p className={META_LINE}>{meta}</p>}
            </header>
            {children}
        </div>
    );
}

/** A titled group of cards. */
export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
    const headingId = useId();
    return (
        <section className="flex flex-col gap-2" aria-labelledby={headingId}>
            <h2 id={headingId} className="m-0 text-[14px] leading-5 font-semibold text-[var(--text-primary)]">{title}</h2>
            {children}
        </section>
    );
}

/** One switch with its sentence; the whole row is the 44px target. */
export function SwitchRow({ id, label, sub, checked, disabled, onChange }: { id: string; label: string; sub?: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
    return (
        <div className="flex min-h-11 items-center justify-between gap-4">
            <div className="min-w-0">
                <label htmlFor={id} className="block text-[14px] leading-5 font-medium text-[var(--text-primary)]">{label}</label>
                {sub && <p className={META_LINE}>{sub}</p>}
            </div>
            <Toggle id={id} checked={checked} disabled={disabled} onChange={onChange} />
        </div>
    );
}

/** A label tied to the one control inside it. */
export function LabeledField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor={id} className={LABEL}>{label}</label>
            {children}
        </div>
    );
}

/** What went wrong, in one plain sentence. */
export function Problem({ error, fallback }: { error: Error | null | undefined; fallback: string }) {
    if (!error) return null;
    return <p role="alert" className={ALERT}>{errorMessage(error) || fallback}</p>;
}

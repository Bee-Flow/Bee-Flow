/**
 * The small parts the four pages beside the tasks share (Preferences, Teamwork, Templates, Admin rules): the page's
 * heading with its one-line meta, a titled section, a card, a switch row, a labelled field, and the one-line problem
 * style. The look is ../coworkUi.ts, so these pages and an opened task read as one product.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { GuidedPanelContext, PanelFocusContext } from './panelGuidance';
import CoworkOrb from '../CoworkOrb';
import { useTranslation } from '@/hooks/useTranslation';
import Toggle from '@/components/shared/Toggle';
import { errorMessage } from '@/utils/caughtError';
import { ALERT, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD as SURFACE, FIELD_WIDE, ICON_BUTTON, LABEL, LINK_BUTTON, LINK_INLINE, SECTION_HEADING, TAG_PLAIN } from '../coworkUi';

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


const PanelSectionsContext = createContext<string | null>(null);

/** The orb stays in place while the active form or advanced sections scroll. */
export function PanelLayout({ title, tag, meta, action, testId, viewKey, children }: { title: string; tag?: string; meta?: string; action?: ReactNode; testId: string; viewKey?: string | number; children: ReactNode }) {
    const content = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (content.current) content.current.scrollTop = 0;
    }, [viewKey]);
    return <section className="cowork-task-guided cowork-side-panel" data-testid={testId}>
        <div className="cowork-side-orb"><CoworkOrb tone="rest" work={{ action: 'ask' }} /></div>
        <div ref={content} className="cowork-side-content flex flex-col gap-4">
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="m-0 mr-auto text-[20px] leading-7 font-semibold text-[var(--text-primary)] outline-none">{title}</h1>
                {tag && <span className={TAG_PLAIN}>{tag}</span>}
                {action}
                {meta && <p className={`${META_LINE} basis-full`}>{meta}</p>}
            </header>
            {children}
        </div>
    </section>;
}

export function PanelShell({ title, meta, tag, testId, children }: { title: string; meta?: string; tag?: string; testId: string; children: ReactNode }) {
    const guided = useContext(GuidedPanelContext);
    const focus = useContext(PanelFocusContext);
    const [expandedAt, setExpandedAt] = useState<string | null>(null);
    const section = focus ?? '';
    const advanced = expandedAt === section;
    const group = useId();
    const { t } = useTranslation();
    return <PanelLayout title={title} meta={meta} tag={tag} testId={testId}
        viewKey={advanced ? 'expanded' : section}
        action={guided && <button type="button" className={LINK_INLINE} onClick={() => setExpandedAt(advanced ? null : section)}>
            {advanced ? t('cowork_task.orb.back', 'Back to the orb') : t('cowork_overview.advanced', 'Advanced')}
        </button>}>
        <PanelSectionsContext.Provider value={guided && !advanced ? group : null}>{children}</PanelSectionsContext.Provider>
    </PanelLayout>;
}

export function PanelLoading() {
    const { t } = useTranslation();
    return <p role="status" className={META_LINE}>{t('cowork_panels.loading', 'Loading…')}</p>;
}

/** A read failure leaves a retry next to the setting that could not be opened. */
export function PanelReadProblem({ error, retry }: { error: Error | null; retry: () => void }) {
    const { t } = useTranslation();
    if (!error) return null;
    return <div className="flex flex-wrap items-baseline gap-2">
        <p role="alert" className={ALERT}>{t('cowork_panels.failed_read', 'I couldn’t load this information.')}</p>
        <PanelButton look="inline" onClick={retry}>{t('cowork_task.retry', 'Try again')}</PanelButton>
    </div>;
}

export function PanelOverview({children}: {children: ReactNode}) {
    const group = useContext(PanelSectionsContext);
    const focus = useContext(PanelFocusContext);
    return group && focus ? null : children;
}

/** A titled group of cards. */
export function PanelSection({ title, children, section }: { title: string; section?: string; children: ReactNode }) {
    const headingId = useId();
    const group = useContext(PanelSectionsContext);
    const focus = useContext(PanelFocusContext);
    if (group && focus && focus !== section) return null;
    if (group && !focus) return <details name={group} className="rounded-[var(--radius-md)] bg-[var(--bg-secondary)] px-3 py-2">
        <summary className="cursor-pointer py-1 font-medium">{title}</summary><div className="mt-2">{children}</div>
    </details>;
    return (
        <section className="flex flex-col gap-2" aria-labelledby={headingId}>
            <h2 id={headingId} className={SECTION_HEADING}>{title}</h2>
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

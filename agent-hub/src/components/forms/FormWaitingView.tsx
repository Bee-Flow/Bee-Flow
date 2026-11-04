import React from 'react';
import useTranslation from '../../hooks/useTranslation';
import { typicalDurationText } from './formRules';
import { FormCustomCss, FormFooter, FormLogo } from './FormChrome';
import { CARD_CLASS, useFormLook } from './formLook';
import type { FormWaitingViewProps } from './PublicFormRenderer.types';

/** How long this form's runs usually take, when the poll knew; nothing otherwise. */
function TypicalDuration({ seconds }: { seconds: number | null | undefined }) {
    const { t } = useTranslation();
    const text = typicalDurationText(seconds, t);
    return text ? <span className="text-xs text-[var(--text-tertiary)]" data-testid="form-waiting-typical">{text}</span> : null;
}

/**
 * The screen a visitor sits on while the automation works.
 *
 * A multi-page form pauses the run at every question, and the stretch between
 * two questions is whatever the author put there — a web search, a model call,
 * a document being written. That is regularly a minute or more, and a bare
 * spinner over an empty page reads as "this broke".
 *
 * So it says WHERE the automation is. `progress` is the trail the poll sends:
 * titles only, outermost flowlet first, the node it is on last. The last
 * segment is the headline because that is the thing actually happening; the
 * flowlets above it are context and sit in the eyebrow.
 *
 * `note` is the running flowlet's own one-line description, when its author
 * gave it one. A name says where the automation is; the description says what it
 * is doing — "Searches Google for a given term and lets AI analyse top-ranking
 * pages…" is the difference between a wait that reads as progress and one that
 * reads as a hang. It takes the place of the generic reassurance line, which
 * steps back to a quieter tone rather than disappearing: it is the line that
 * says the length of the wait is expected.
 *
 * Themed like the form and the closing page — one card on the page's ground —
 * because a full-bleed dark page with two lines of grey text on it is not a
 * design, it is an absence of one.
 */
export function FormWaitingView({ theme = null, formStyle, progress = null, note = null, label = 'Working on it', typicalSeconds = null }: FormWaitingViewProps) {
    const look = useFormLook(theme, formStyle);
    const trail = Array.isArray(progress) ? progress.filter(Boolean) : [];
    const current = trail.length ? trail[trail.length - 1] : null;
    const context = trail.slice(0, -1);
    const summary = typeof note === 'string' && note.trim() ? note.trim() : null;

    return (
        <div style={look.rootStyle} data-bf-scope={look.scopeId} className={look.rootClass} data-testid="form-waiting" role="status" aria-live="polite">
            <style>{WAITING_KEYFRAMES}</style>
            <FormCustomCss css={look.css} />
            <div className={`bf-form__waiting flex flex-col gap-4 px-6 py-8 ${CARD_CLASS}`}>
                <FormLogo url={look.style.logoUrl} />
                <div className="flex items-start gap-4">
                    {/* A ring rather than a bare spinner: it reads as a process
                        that is running, not as a page that failed to load. */}
                    <span
                        aria-hidden="true"
                        className="flex-shrink-0 mt-0.5 w-[34px] h-[34px] [border-radius:999px] [border:2px_solid_var(--app-primary-soft)] [border-top-color:var(--app-primary)] [animation:bf-form-spin_900ms_linear_infinite]"
                    />
                    <div className="min-w-0 flex flex-col gap-1">
                        {context.length ? (
                            <span
                                className="text-[11px] font-medium uppercase tracking-wide truncate text-[var(--app-primary)]"
                                title={context.join(' › ')}
                            >
                                {context.join(' › ')}
                            </span>
                        ) : null}
                        <span className="text-base font-semibold leading-snug text-[var(--text-primary)]">
                            {current || `${label}…`}
                        </span>
                        {summary ? (
                            <span
                                className="text-xs leading-relaxed text-[var(--text-secondary)]"
                                data-testid="form-waiting-note"
                            >
                                {summary}
                            </span>
                        ) : null}
                        <span className={`text-xs ${summary ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`}>
                            {current ? `${label} — this can take a moment.` : 'This can take a moment.'}
                        </span>
                        {/* How long this form's runs usually take, when the poll knew:
                            a wait with a number on it reads as progress, not as a hang. */}
                        <TypicalDuration seconds={typicalSeconds} />
                    </div>
                </div>

                {/* Indeterminate on purpose. The automation cannot say how far
                    along it is — a percentage here would be a lie. */}
                <span
                    aria-hidden="true"
                    className="bf-form__progress block w-full overflow-hidden h-[3px] [border-radius:999px] [background:var(--app-primary-soft)]"
                >
                    <span
                        className="block h-full w-[38%] [border-radius:999px] [background:var(--app-primary)] [animation:bf-form-sweep_1.6s_ease-in-out_infinite]"
                    />
                </span>
                <FormFooter text={look.style.footerText} />
            </div>
        </div>
    );
}

const WAITING_KEYFRAMES = `
@keyframes bf-form-spin { to { transform: rotate(360deg); } }
@keyframes bf-form-sweep {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(300%); }
}
@media (prefers-reduced-motion: reduce) {
    [data-testid="form-waiting"] * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; }
}
`;

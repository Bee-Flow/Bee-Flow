import React, { useId } from 'react';

/**
 * A numbered check: the dark number, a title with a one-line subtitle, and
 * the check's settings as flush rows beneath a hairline.
 *
 * The number is the step's number on the path strip (3 or 4), so an admin can
 * match the step they clicked to the card that configures it.
 */
export function CheckCard({
    n, title, subtitle, footer, children,
}: {
    n: number;
    title: string;
    subtitle: string;
    footer?: React.ReactNode;
    children: React.ReactNode;
}) {
    const headingId = useId();
    return (
        <section
            aria-labelledby={headingId}
            className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] shadow-[var(--shadow-sm)] overflow-hidden"
        >
            <header className="flex items-center gap-2.5 px-[18px] py-3.5 border-b border-[var(--border-subtle)]">
                <span
                    aria-hidden="true"
                    className="w-[22px] h-[22px] rounded-full grid place-items-center shrink-0 text-[11px] font-bold bg-[var(--text-primary)] text-[rgb(from_var(--bg-card)_r_g_b_/_1)]"
                >
                    {n}
                </span>
                <div className="min-w-0">
                    <h3 id={headingId} className="m-0 text-sm font-semibold leading-5 text-[var(--text-primary)]">{title}</h3>
                    <p className="m-0 text-xs leading-4 text-[var(--text-tertiary)]">{subtitle}</p>
                </div>
            </header>
            <div>{children}</div>
            {footer}
        </section>
    );
}

export default CheckCard;

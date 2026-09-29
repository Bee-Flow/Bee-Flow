import React from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';

/**
 * The heading every state of "Your own data" opens with (the starters, the
 * list and the locked view), so the card reads the same whichever one the
 * admin lands on.
 *
 * Routines are only named when the shield also runs on them: an admin who
 * switched that off should not read that their own data is hidden there.
 */
export function OwnDataIntro({
    routines = true, action, children, t,
}: {
    /** Whether the shield also runs on routines; see above. */
    routines?: boolean;
    /** Sits to the right of the heading, e.g. "Add a type". */
    action?: React.ReactNode;
    /** Replaces the description, e.g. with the licence notice. */
    children?: React.ReactNode;
    t: TranslateFn;
}) {
    const desc = routines
        ? t('shield_data.landing_desc', 'Project code names, customer numbers, internal names. Add a type and the shield hides it just like names and email addresses, in chat, agents and routines.')
        : t('shield_data.landing_desc_no_routines', 'Project code names, customer numbers, internal names. Add a type and the shield hides it just like names and email addresses, in chat and agents.');
    return (
        <div className="flex items-start gap-4 flex-wrap">
            <div className="min-w-0 flex-1 flex flex-col gap-1">
                <h3 className="m-0 text-base font-semibold text-[var(--text-primary)]">
                    {t('shield_data.landing_title', 'Hide things only your organisation uses')}
                </h3>
                {children ?? <p className="m-0 max-w-[640px] text-xs leading-[18px] text-[var(--text-secondary)]">{desc}</p>}
            </div>
            {action}
        </div>
    );
}

/** A small uppercase label over a group, as in the rest of the shield. */
export function SectionLabel({ children, htmlFor, id }: { children: React.ReactNode; htmlFor?: string; id?: string }) {
    const cls = 'block text-[11px] font-bold uppercase tracking-[0.05em] text-[var(--text-tertiary)]';
    return htmlFor
        ? <label htmlFor={htmlFor} id={id} className={cls}>{children}</label>
        : <span id={id} className={cls}>{children}</span>;
}

export default OwnDataIntro;

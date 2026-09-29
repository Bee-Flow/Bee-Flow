import React from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { SWITCH_COLS } from './OwnDataRow';

/**
 * The table the org's own types live in: a real `<table>` with row headers
 * (the type's name) and column headers, for the same reason as the category
 * matrix. A switch cell has to announce which type AND which question it
 * answers, and a table cell does that on its own.
 */
export function OwnDataTable({
    caption, children, t,
}: { caption: string; children: React.ReactNode; t: TranslateFn }) {
    const th = 'px-3 py-2 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--text-tertiary)]';
    return (
        // `relative`: the scroller is the containing block of the sr-only
        // (absolutely positioned) labels and checkboxes inside, which would
        // otherwise escape it and scroll the whole page sideways.
        <div className="relative overflow-x-auto">
            <table className="w-full border-collapse">
                <caption className="sr-only">{caption}</caption>
                <thead>
                    <tr className="bg-[var(--bg-secondary)] border-b border-[var(--border-default)]">
                        <th scope="col" className={`${th} text-left`}>{t('shield_data.col_type', 'Type')}</th>
                        <th scope="col" className={`${th} text-left`}>{t('shield_data.col_method', 'How we find it')}</th>
                        {/* On a narrow pane the test result sits under "How we
                            find it" rather than in a column of its own. */}
                        <th scope="col" className={`${th} text-left @max-[999px]/pane:hidden`}>{t('shield_data.col_result', 'Test result')}</th>
                        {SWITCH_COLS.map(({ col, labelKey, fallback }) => (
                            <th key={col} scope="col" className={`${th} px-1 text-center w-[92px]`}>{t(labelKey, fallback)}</th>
                        ))}
                        <th scope="col" className={th}><span className="sr-only">{t('shield_data.col_actions', 'Actions')}</span></th>
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}

export default OwnDataTable;

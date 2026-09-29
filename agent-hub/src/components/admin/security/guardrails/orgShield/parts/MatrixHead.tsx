import React from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { MatrixColumn } from './categoryMatrixModel';

/**
 * The matrix's column headers. Each explains itself on two lines, so the
 * paragraph that used to sit above the table is no longer needed: what the
 * column does ("Hide from AI", "Hold back · outside tools"), and how much of
 * the catalogue it covers.
 *
 * The outside-tools header turns amber at 0 of 21 on a plan that has the
 * column: nothing is held back from a tool that leaves the organisation, and
 * that is the one state of this table that lets personal data out unchanged.
 */

const LABEL = 'block text-[10px] font-bold uppercase tracking-[0.05em]';
const SUB = 'block text-[11px] font-normal normal-case tracking-normal mt-0.5';
const CELL = 'px-1.5 py-2.5 text-left align-bottom';

interface MatrixHeadProps {
    counts: Record<MatrixColumn, number>;
    total: number;
    canBlockExternal: boolean;
    t: TranslateFn;
}

function ExternalHead({ n, total, canBlockExternal, t }: { n: number; total: number; canBlockExternal: boolean; t: TranslateFn }) {
    const open = canBlockExternal && n === 0;
    let sub = t('shield_look.col_count', '{n} of {total}', { n, total });
    if (!canBlockExternal) sub = t('shield_look.col_external_locked', '{n} of {total} · Enterprise', { n, total });
    else if (open) sub = t('shield_look.col_external_none', '{n} of {total} — anything may leave', { n, total });
    return (
        <th scope="col" className={CELL}>
            <span className={`${LABEL} ${open ? 'text-[var(--warning-ink)]' : 'text-[var(--text-primary)]'}`}>
                {t('shield_look.col_external', 'Hold back · outside tools')}
            </span>
            <span className={`${SUB} ${open ? 'text-[var(--warning-ink)]' : 'text-[var(--text-tertiary)]'}`}>{sub}</span>
        </th>
    );
}

export default function MatrixHead({ counts, total, canBlockExternal, t }: MatrixHeadProps) {
    return (
        <thead>
            <tr className="bg-[var(--bg-secondary)] border-y border-[var(--border-default)]">
                <th scope="col" className="pl-[18px] pr-1.5 py-2.5 text-left align-bottom">
                    <span className={`${LABEL} text-[var(--text-tertiary)]`}>
                        {t('admin.shield_matrix_col_kind', 'Kind')}
                    </span>
                </th>
                <th scope="col" className={CELL}>
                    <span className={`${LABEL} text-[var(--text-primary)]`}>
                        {t('admin.shield_matrix_col_detect', 'Hide from AI')}
                    </span>
                    <span className={`${SUB} text-[var(--text-tertiary)]`}>
                        {t('shield_look.col_detect_sub', 'look for it · {n} of {total}', { n: counts.detect, total })}
                    </span>
                </th>
                <ExternalHead n={counts.external} total={total} canBlockExternal={canBlockExternal} t={t} />
                <th scope="col" className="pl-1.5 pr-[18px] py-2.5 text-left align-bottom">
                    <span className={`${LABEL} text-[var(--text-primary)]`}>
                        {t('shield_look.col_internal', 'Hold back · own server')}
                    </span>
                    <span className={`${SUB} text-[var(--text-tertiary)]`}>
                        {t('shield_look.col_count', '{n} of {total}', { n: counts.internal, total })}
                    </span>
                </th>
            </tr>
        </thead>
    );
}

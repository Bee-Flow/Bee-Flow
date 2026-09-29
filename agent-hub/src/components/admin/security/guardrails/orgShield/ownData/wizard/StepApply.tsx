import { TriangleAlert } from 'lucide-react';
import React from 'react';

import Toggle from '../../../../../../shared/Toggle';
import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import LicenceLock from '../../parts/LicenceLock';
import { placeholderOf } from '../ownDataCopy';
import type { SwitchCol } from '../ownDataModel';
import { Note } from '../ui';
import type { StepProps } from './stepTypes';

/**
 * Step 3: the same three questions the built-in kinds answer in the matrix,
 * for this one type. They are ids in the shield's existing lists, so they
 * behave exactly like a built-in kind once saved.
 */

function summaryLine(apply: Record<SwitchCol, boolean>, tokenKey: string, t: TranslateFn): string {
    const parts: string[] = [];
    if (apply.detect) parts.push(t('shield_data.apply_sum_detect', 'The AI sees {placeholder} instead.', { placeholder: placeholderOf(tokenKey) }));
    if (apply.external) parts.push(t('shield_data.apply_sum_external', 'Outside tools never get it.'));
    if (apply.internal) parts.push(t('shield_data.apply_sum_internal', 'Tools on your own server never get it.'));
    return `${t('shield_data.apply_sum_lead', 'In short:')} ${parts.join(' ')}`;
}

export function StepApply({ state, dispatch, ctx, t }: StepProps) {
    const { apply } = state;
    const set = (col: SwitchCol) => (on: boolean) => dispatch({ type: 'set_apply', col, on });
    const allOff = !apply.detect && !apply.external && !apply.internal;
    return (
        <div className="flex flex-col gap-2.5 max-w-2xl">
            <Toggle
                checked={apply.detect}
                onChange={set('detect')}
                label={t('admin.shield_matrix_col_detect', 'Hide from AI')}
                description={t('shield_data.apply_detect_desc', 'Replaced by {placeholder} before a message reaches the AI. What happens next follows your setting under What happens.', { placeholder: placeholderOf(state.type.tokenKey) })}
            />
            <Toggle
                checked={ctx.canBlockExternal && apply.external}
                onChange={set('external')}
                disabled={!ctx.canBlockExternal}
                label={t('admin.shield_matrix_col_external', 'Outside tools')}
                description={t('shield_data.apply_external_desc', 'Never sent to tools outside your organisation, such as web search or email.')}
            />
            {!ctx.canBlockExternal && (
                <LicenceLock upgradeUrl={ctx.upgradeUrl} t={t}>
                    {t('admin.shield_tool_block_locked', 'Holding data back from outside tools is an Enterprise feature.')}
                </LicenceLock>
            )}
            <Toggle
                checked={apply.internal}
                onChange={set('internal')}
                label={t('admin.shield_matrix_col_internal', 'Own server')}
                description={t('shield_data.apply_internal_desc', 'Never sent to tools that run on your own server.')}
            />
            {allOff ? (
                <Note Icon={TriangleAlert} tone="warn" role="status">
                    {t('shield_data.apply_all_off', 'With all three off, this type is found but nothing happens.')}
                </Note>
            ) : (
                <p role="status" className="text-xs m-0 text-[var(--text-secondary)]">{summaryLine({ ...apply, external: ctx.canBlockExternal && apply.external }, state.type.tokenKey, t)}</p>
            )}
        </div>
    );
}

export default StepApply;

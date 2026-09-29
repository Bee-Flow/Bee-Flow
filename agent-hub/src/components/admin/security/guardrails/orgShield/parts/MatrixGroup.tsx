import React from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { MatrixColumn, MatrixGroup as Group, MatrixKind, MatrixSelection } from './categoryMatrixModel';
import {
    COLUMN_NAME, GROUP_DOT, GROUP_KEYS, OTHER_GROUP_DOT, hiddenInGroup, leftWithTools,
} from './categoryMatrixModel';
import MatrixCell from './MatrixCell';

/**
 * One group of the matrix ("Personal", "Contact", …) as its own <tbody>: a
 * header row with the group's dot and how many of its kinds are hidden, then
 * one row per kind.
 */

interface MatrixGroupProps {
    group: Group;
    sel: MatrixSelection;
    canBlockExternal: boolean;
    allowPublicOrgs: boolean;
    readOnly: boolean;
    /** Canonical id → tool calls that carried it in the last 30 days; null = unknown. */
    toolKinds: Record<string, number> | null;
    days: number;
    onToggle: (col: MatrixColumn, id: string, on: boolean) => void;
    t: TranslateFn;
}

type RowProps = Omit<MatrixGroupProps, 'group'> & { kind: MatrixKind };

/**
 * "33 left with tools", beside the outside-tools box. Real calls from the last
 * 30 days, not a setting: it is what the column would have held back.
 */
function LeftWithTools({ n, days, t }: { n: number; days: number; t: TranslateFn }) {
    return (
        <span
            className="text-[11px] font-semibold text-[var(--warning-ink)] whitespace-nowrap"
            title={t('shield_look.left_with_tools_title', '{n} tool calls carried this kind in the last {days} days.', { n, days })}
        >
            {t('shield_look.left_with_tools', '{n} left with tools', { n })}
        </span>
    );
}

function KindRow({ kind, sel, canBlockExternal, allowPublicOrgs, readOnly, toolKinds, days, onToggle, t }: RowProps) {
    const cell = (col: MatrixColumn) => (
        <MatrixCell
            checked={sel[col].has(kind.id)}
            disabled={readOnly}
            locked={col === 'external' && !canBlockExternal}
            name={`${kind.label} — ${t(...COLUMN_NAME[col])}`}
            onChange={on => onToggle(col, kind.id, on)}
        />
    );
    const left = leftWithTools(toolKinds, kind.id);
    return (
        <tr className="border-t border-[var(--border-subtle)]">
            <th scope="row" className="pl-[18px] pr-1.5 py-[7px] text-left font-normal text-[13px] leading-[18px] text-[var(--text-primary)]">
                <span className="flex items-baseline gap-2 min-w-0 flex-wrap">
                    <span>{kind.label}</span>
                    {/* The well-known-companies list applies to exactly this
                        one kind, so it is named on its row. */}
                    {kind.id === 'Organization' && allowPublicOrgs && (
                        <span className="text-[11px] text-[var(--text-tertiary)]">
                            {t('shield_look.public_orgs_note', '221 well-known companies are never hidden')}
                        </span>
                    )}
                </span>
            </th>
            <td className="px-1.5 py-[7px]">{cell('detect')}</td>
            <td className="px-1.5 py-[7px]">
                <span className="flex items-center gap-2">
                    {cell('external')}
                    {left !== null && <LeftWithTools n={left} days={days} t={t} />}
                </span>
            </td>
            <td className="pl-1.5 pr-[18px] py-[7px]">{cell('internal')}</td>
        </tr>
    );
}

export default function MatrixGroup({ group, ...rest }: MatrixGroupProps) {
    const { sel, t } = rest;
    const key = GROUP_KEYS[group.name];
    return (
        <tbody>
            <tr>
                <th scope="colgroup" colSpan={4} className="px-[18px] pt-3 pb-1.5 text-left font-normal">
                    <span className="flex items-center gap-2">
                        <span aria-hidden="true" className={`w-[7px] h-[7px] rounded-full shrink-0 ${GROUP_DOT[group.name] || OTHER_GROUP_DOT}`} />
                        <span className="text-[11px] font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]">
                            {key ? t(...key) : group.name}
                        </span>
                        <span className="text-[11px] text-[var(--text-tertiary)]">
                            {t('shield_look.group_hidden', '{n} of {total} hidden', { n: hiddenInGroup(group, sel), total: group.items.length })}
                        </span>
                    </span>
                </th>
            </tr>
            {group.items.map(kind => <KindRow key={kind.id} kind={kind} {...rest} />)}
        </tbody>
    );
}

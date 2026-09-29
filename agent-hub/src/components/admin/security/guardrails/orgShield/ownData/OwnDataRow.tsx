import { ChevronRight } from 'lucide-react';
import React, { useState } from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { methodLine, statusLine } from './ownDataCopy';
import type { CustomDataType, SwitchCol } from './ownDataModel';
import { statusFor } from './ownDataModel';
import {
    CheckCell, LinkButton, PlaceholderChip, Tag,
} from './ui';

/**
 * One type in the "Your own data" table. Shared by the Enterprise list and
 * the read-only Community view, which differ only in what is switchable and
 * which actions exist.
 */

export const SWITCH_COLS: { col: SwitchCol; labelKey: string; fallback: string }[] = [
    { col: 'detect', labelKey: 'admin.shield_matrix_col_detect', fallback: 'Hide from AI' },
    { col: 'external', labelKey: 'admin.shield_matrix_col_external', fallback: 'Outside tools' },
    { col: 'internal', labelKey: 'admin.shield_matrix_col_internal', fallback: 'Own server' },
];

export interface RowActions {
    onTest?: () => void;
    onEdit?: () => void;
    onRemove?: () => void;
}

interface OwnDataRowProps {
    type: CustomDataType;
    switches: Record<SwitchCol, boolean>;
    onSwitch: (col: SwitchCol, on: boolean) => void;
    licensed: boolean;
    canBlockExternal: boolean;
    readOnly: boolean;
    /** The server's refusal for this type on the last save, if any. */
    error?: string | null;
    /** Community view: the words or pattern can be unfolded, nothing edited. */
    expandable?: boolean;
    actions: RowActions;
    t: TranslateFn;
}

const STATUS_TONE: Record<string, string> = {
    invalid: 'text-[var(--error-ink)]',
    paused: 'text-[var(--warning-ink)]',
    stale: 'text-[var(--warning-ink)]',
    untested: 'text-[var(--text-tertiary)]',
    tested: 'text-[var(--text-secondary)]',
};

function TypeDetails({ type, t }: { type: CustomDataType; t: TranslateFn }) {
    if (type.method === 'pattern') {
        return <code className="block mt-1 text-[11px] font-mono break-all text-[var(--text-secondary)]">{type.pattern?.source}</code>;
    }
    if (type.method === 'words') {
        return (
            <ul className="mt-1 flex flex-wrap gap-1 list-none p-0 m-0" aria-label={t('shield_data.locked_words_label', 'The words')}>
                {(type.words?.values || []).map(v => (
                    <li key={v} className="text-[11px] px-1.5 py-px rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{v}</li>
                ))}
            </ul>
        );
    }
    return null;
}

function NameCell({ type, error, t }: { type: CustomDataType; error?: string | null; t: TranslateFn }) {
    return (
        <th scope="row" className="text-left font-normal px-3 py-2 align-top min-w-[180px]">
            <span className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[13px] font-medium text-[var(--text-primary)]">{type.name}</span>
                <PlaceholderChip tokenKey={type.tokenKey} />
                {type.origin === 'migrated' && <Tag>{t('shield_data.from_old_list', 'From your old list')}</Tag>}
            </span>
            {error && (
                <span role="alert" className="block mt-1 text-[11px] text-[var(--error-ink)]">
                    {t('shield_data.row_not_saved', 'Not saved: {error}', { error })}
                </span>
            )}
        </th>
    );
}

function MethodCell({ type, expandable, result, t }: { type: CustomDataType; expandable?: boolean; result: React.ReactNode; t: TranslateFn }) {
    const [open, setOpen] = useState(false);
    const canUnfold = expandable && type.method !== 'ai';
    return (
        <td className="px-3 py-2 align-top text-[12px] text-[var(--text-secondary)]">
            {canUnfold ? (
                <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpen(v => !v)}
                    className="inline-flex items-center gap-1 text-left hover:underline"
                >
                    <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
                    {methodLine(type, t)}
                </button>
            ) : methodLine(type, t)}
            {canUnfold && open && <TypeDetails type={type} t={t} />}
            {result}
        </td>
    );
}

function ActionsCell({ type, actions, t }: { type: CustomDataType; actions: RowActions; t: TranslateFn }) {
    return (
        <td className="px-3 py-2 align-top">
            <span className="flex gap-3 justify-end @max-[999px]/pane:flex-col @max-[999px]/pane:items-end @max-[999px]/pane:gap-1">
                {actions.onTest && (
                    <LinkButton onClick={actions.onTest} ariaLabel={t('shield_data.row_test_aria', 'Test and tune {name}', { name: type.name })}>
                        {t('shield_data.row_test', 'Test and tune')}
                    </LinkButton>
                )}
                {actions.onEdit && (
                    <LinkButton onClick={actions.onEdit} ariaLabel={t('shield_data.row_edit_aria', 'Edit {name}', { name: type.name })}>
                        {t('shield_data.row_edit', 'Edit')}
                    </LinkButton>
                )}
                {actions.onRemove && (
                    <LinkButton danger onClick={actions.onRemove} ariaLabel={t('shield_data.row_remove_aria', 'Remove {name}', { name: type.name })}>
                        {t('shield_data.row_remove', 'Remove')}
                    </LinkButton>
                )}
            </span>
        </td>
    );
}

export function OwnDataRow({
    type, switches, onSwitch, licensed, canBlockExternal, readOnly, error, expandable, actions, t,
}: OwnDataRowProps) {
    const status = statusFor(type, { licensed });
    return (
        <tr className="border-t border-[var(--border-subtle)]">
            <NameCell type={type} error={error} t={t} />
            <MethodCell
                type={type}
                expandable={expandable}
                // The same line again, shown only while its own column is folded away.
                result={<span className={`block mt-1 @min-[1000px]/pane:hidden ${STATUS_TONE[status.kind]}`}>{statusLine(status, t)}</span>}
                t={t}
            />
            <td className={`px-3 py-2 align-top text-[12px] @max-[999px]/pane:hidden ${STATUS_TONE[status.kind]}`}>{statusLine(status, t)}</td>
            {SWITCH_COLS.map(({ col, labelKey, fallback }) => (
                <td key={col} className="px-1 py-2 align-top text-center">
                    <CheckCell
                        checked={switches[col]}
                        disabled={readOnly}
                        locked={col === 'external' && !canBlockExternal}
                        name={`${type.name}, ${t(labelKey, fallback)}`}
                        onChange={on => onSwitch(col, on)}
                    />
                </td>
            ))}
            <ActionsCell type={type} actions={actions} t={t} />
        </tr>
    );
}

export default OwnDataRow;

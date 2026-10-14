import { ChevronDown, ChevronRight, History, Undo2 } from 'lucide-react';
import useTranslation from '../../../../../hooks/useTranslation';
import type { AppDefinition } from '../inspector/appDefinition';
import { findNode } from '../state/definitionOps';

/** What diffDefinitions reports: the ids a turn added and the ids it changed. */
export interface DraftDiff {
    addedIds: Set<string>;
    changedIds: Set<string>;
    [key: string]: unknown;
}

/** The "What changed" summary of a finished turn, and the draft it resolves against. */
export interface TurnChange {
    diff: DraftDiff;
    finalDef: AppDefinition;
}

interface WhatChangedProps {
    change: TurnChange;
    open: boolean;
    onToggle: () => void;
    onSelect?: (nodeId: string) => void;
    onUndo: (() => void) | null;
    onRevert: (() => void) | null;
}

const ACTION_BUTTON = 'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium transition-colors hover:bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)]';

/**
 * Collapsible post-turn summary of what the AI touched: added/changed node
 * ids (click to jump to them), an "Undo turn" affordance (the shell's single
 * history.undo, exposed as chrome.undoTurn), and "Revert to checkpoint".
 */
export default function WhatChanged({ change, open, onToggle, onSelect, onUndo, onRevert }: WhatChangedProps) {
    const { t } = useTranslation();
    const { diff, finalDef } = change;
    const added = [...(diff.addedIds || [])];
    const changed = [...(diff.changedIds || [])].filter((id) => !diff.addedIds?.has(id));
    const total = added.length + changed.length;
    if (!total) return null;

    const rows = [
        ...added.map((id) => ({ id, kind: 'added' })),
        ...changed.map((id) => ({ id, kind: 'changed' })),
    ].slice(0, 12);
    const Chevron = open ? ChevronDown : ChevronRight;

    return (
        <div
            className="flex w-full flex-col rounded-lg border text-xs border-[var(--border-default)] bg-[var(--bg-secondary)]"
            data-what-changed=""
        >
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-left font-medium text-[var(--text-secondary)]"
            >
                <Chevron size={13} className="shrink-0" aria-hidden="true" />
                {t('studio_apps_edit.chat.what_changed', 'What changed')}
                <span className="text-[var(--text-tertiary)]">
                    {total === 1 ? t('studio_apps_edit.chat.updates_one', '· 1 update') : t('studio_apps_edit.chat.updates_many', '· {n} updates', { n: total })}
                </span>
            </button>

            {open ? (
                <div className="flex flex-col gap-1.5 border-t px-2.5 py-2 border-[var(--border-default)]">
                    <ul className="flex flex-col gap-0.5">
                        {rows.map((row) => {
                            const type = findNode(finalDef, row.id)?.node?.type;
                            return (
                                <li key={`${row.kind}:${row.id}`}>
                                    <button
                                        type="button"
                                        onClick={() => onSelect?.(row.id)}
                                        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                                    >
                                        <span
                                            className="shrink-0 rounded px-1 text-[10px] font-medium"
                                            style={{
                                                background: row.kind === 'added'
                                                    ? 'color-mix(in srgb, var(--accent-primary) 18%, transparent)'
                                                    : 'rgba(148, 163, 184, 0.18)',
                                                color: row.kind === 'added' ? 'var(--accent-primary)' : 'var(--text-tertiary)',
                                            }}
                                        >
                                            {row.kind === 'added' ? t('studio_apps_edit.chat.row_new', 'new') : t('studio_apps_edit.chat.row_edit', 'edit')}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate">{type || row.id}</span>
                                    </button>
                                </li>
                            );
                        })}
                        {total > rows.length ? (
                            <li className="px-1 text-[11px] text-[var(--text-tertiary)]">
                                {t('studio_apps_edit.chat.more_changes', '+{n} more', { n: total - rows.length })}
                            </li>
                        ) : null}
                    </ul>
                    <div className="flex items-center gap-2 pt-0.5">
                        {onUndo ? (
                            <button type="button" onClick={() => onUndo()} className={ACTION_BUTTON}>
                                <Undo2 className="h-3 w-3" aria-hidden="true" />
                                {t('studio_apps_edit.chat.undo_turn', 'Undo turn')}
                            </button>
                        ) : null}
                        {onRevert ? (
                            <button type="button" onClick={() => onRevert()} className={ACTION_BUTTON}>
                                <History className="h-3 w-3" aria-hidden="true" />
                                {t('studio_apps_edit.chat.revert_checkpoint', 'Revert to checkpoint')}
                            </button>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

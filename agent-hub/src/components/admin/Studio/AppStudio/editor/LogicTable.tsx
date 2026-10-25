import { ArrowUpRight, ExternalLink, Workflow } from 'lucide-react';
import { kindColorVar } from '../../../../shared/kindColors';
import { automationHref } from '../inspector/AutomationTile';
import { getComponentEntry } from '../runtime/componentRegistry';
import type { TFn, LogicTableRow, RevealFn, LogicRowProps, StatusCellProps, GroupHeadingProps, LogicTableProps } from './LogicaTab.types';

/** De kleur van een rij: een automatisering draagt de automation-familie, de rest die van de app. */
function rowColor(row: { actionKind: string | null }) {
    return row.actionKind === 'run_automation' ? kindColorVar('automation') : kindColorVar('app');
}

function LogicRow({ row, status, notices, onReveal, t }: LogicRowProps) {
    const entry = row.nodeType ? getComponentEntry(row.nodeType) : null;
    const Icon = entry?.icon || Workflow;

    return (
        <tr
            data-logic-row={row.kind}
            data-logic-wired={row.wired ? 'true' : 'false'}
            className="align-top text-[var(--text-primary)]"
        >
            <td className="px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                    <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: rowColor(row) }} aria-hidden="true" />
                    <span className="min-w-0">
                        <span className="block">{row.when}</span>
                        {row.nodeType || row.surfaceLabel ? (
                            <span className="block text-[11px] text-[var(--text-tertiary)]">
                                {[entry?.label || row.nodeType, row.surfaceLabel].filter(Boolean).join(' · ')}
                            </span>
                        ) : null}
                    </span>
                </span>
            </td>

            <td className="px-3 py-2">
                {row.wired ? (
                    <span style={{ color: rowColor(row) }}>{row.what}</span>
                ) : (
                    <span
                        className="inline-block rounded border border-dashed px-1.5 py-0.5 border-[var(--border-default)] text-[var(--text-tertiary)]"
                    >
                        {row.what}
                    </span>
                )}
                {notices.map((n, i) => (
                    <span
                        key={`${n.code}-${i}`}
                        className="mt-1 block text-[11px]"
                        data-logic-notice={n.kind}
                        style={{ color: n.kind === 'error' ? 'var(--error)' : 'var(--text-secondary)' }}
                    >
                        {n.message}
                    </span>
                ))}
            </td>

            <StatusCell status={status} t={t} />

            <JumpCell row={row} onReveal={onReveal} t={t} />
        </tr>
    );
}

function StatusCell({ status, t }: StatusCellProps) {
    return (
        <td className="px-3 py-2" data-logic-status={status.state}>
            {status.state === 'known' ? (
                <span className="text-[var(--text-secondary)]">{status.text}</span>
            ) : null}
            {status.state === 'unknown' ? (
                // No dash and no zero: the word itself, because the difference from "there is nothing" is the whole message.
                <span className="text-[var(--text-tertiary)]">
                    {t('app_studio.logic.status_unknown', 'Not available')}
                </span>
            ) : null}
        </td>
    );
}

/**
 * ↗ means "take me there" everywhere. For a row that sits on a component that is the canvas — also when an
 * automation is behind it, because the wiring is changed at the button. Only a row WITHOUT a component (an
 * automation of this solution, an action that nothing points to) has no place on the canvas and links to the
 * Automations builder.
 */
function JumpCell({ row, onReveal, t }: { row: LogicTableRow; onReveal?: RevealFn; t: TFn }) {
    const canReveal = typeof onReveal === 'function' && !!row.screenId;
    const href = row.automationId ? automationHref(row.automationId) : null;
    return (
        <td className="px-3 py-2 text-right">
            {canReveal ? (
                <button
                    type="button"
                    onClick={() => onReveal({ screenId: row.screenId, nodeId: row.nodeId })}
                    className="inline-flex items-center rounded p-0.5 hover:bg-[var(--bg-tertiary)]"
                    aria-label={t('app_studio.logic.show_me', 'Show me')}
                >
                    <ArrowUpRight className="h-3.5 w-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                </button>
            ) : href ? (
                <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center rounded p-0.5 hover:bg-[var(--bg-tertiary)]"
                    aria-label={t('app_studio.inspector.tile_open', 'Open')}
                >
                    <ExternalLink className="h-3.5 w-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                </a>
            ) : null}
        </td>
    );
}

function GroupHeading({ title, hint = null }: GroupHeadingProps) {
    return (
        <tr>
            <th
                scope="colgroup"
                colSpan={4}
                className="border-t px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide border-[var(--border-default)] text-[var(--text-secondary)]"
            >
                {title}
                {hint ? (
                    <span className="block text-[11px] font-normal normal-case tracking-normal text-[var(--text-tertiary)]">
                        {hint}
                    </span>
                ) : null}
            </th>
        </tr>
    );
}

export function LogicTable({ groups, automations, statusOf, noticesByRow, onReveal, t }: LogicTableProps) {
    return (
        <table className="w-full border-collapse text-left text-xs" data-logic-table>
            <thead>
                <tr className="text-[var(--text-tertiary)]">
                    <th scope="col" className="w-[26%] px-3 py-1.5 font-medium">
                        {t('app_studio.logic.col_when', 'When')}
                    </th>
                    <th scope="col" className="px-3 py-1.5 font-medium">
                        {t('app_studio.logic.col_happens', 'What happens')}
                    </th>
                    <th scope="col" className="w-[24%] px-3 py-1.5 font-medium">
                        {t('app_studio.logic.col_status', 'Status')}
                    </th>
                    <th scope="col" className="w-8 px-3 py-1.5 font-medium">
                        <span className="sr-only">{t('app_studio.logic.col_open', 'Open')}</span>
                    </th>
                </tr>
            </thead>

            {groups.map((group) => (
                <tbody key={group.key}>
                    <GroupHeading title={group.name || t('app_studio.logic.group_app', 'This app')} />
                    {group.rows.map((row) => (
                        <LogicRow
                            key={row.key}
                            row={row}
                            status={statusOf(row)}
                            notices={noticesByRow.get(row.key) || []}
                            onReveal={onReveal}
                            t={t}
                        />
                    ))}
                </tbody>
            ))}

            {automations.length ? (
                <tbody data-logic-automations>
                    {/* "Yours" is in the heading because the list says so. The rows come from GET /api/automation →
                        getAutomationsForUser (`WHERE user_id = $1`), so these are the automations the VIEWER owns.
                        A colleague's nightly automation, in the same solution and on the same table, is not in it —
                        and an empty section is not distinguishable from "there are none". Narrowing is allowed;
                        silently putting "Automations in this solution" above it is not. */}
                    <GroupHeading
                        title={t('app_studio.logic.automations_title', 'Your automations in this solution')}
                        hint={t(
                            'app_studio.logic.automations_desc',
                            'Automations you own, filed in the same solution and working on the tables this app is bound to. They are not wired to a button — they run on their own. Automations owned by someone else are not listed here.',
                        )}
                    />
                    {automations.map((row) => (
                        <LogicRow key={row.key} row={row} status={statusOf(row)} notices={[]} onReveal={onReveal} t={t} />
                    ))}
                </tbody>
            ) : null}
        </table>
    );
}

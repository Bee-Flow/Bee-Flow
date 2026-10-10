/**
 * "Worth a look": the findings beside "In short", each with the filter that
 * shows its rows and, where one exists, the pane that fixes it. Drawn inside
 * its own card (ActivityBody), so the list is as tall as it needs to be.
 */

import { ArrowRight, Check, ListFilter, MapPinOff, ScanSearch, TriangleAlert } from 'lucide-react';
import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { isShowing, type Finding, type FindingAction, type FindingId, type FindingTone } from '../shieldFindings';
import { findingCopy } from './findingCopy';
import { Eyebrow } from './Panel';

const TILE: Record<FindingTone, string> = {
    warn: 'bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-[var(--warning-ink)]',
    info: 'bg-[color-mix(in_srgb,var(--info-ink)_12%,transparent)] text-[var(--info-ink)]',
    good: 'bg-[color-mix(in_srgb,var(--success-ink)_12%,transparent)] text-[var(--success-ink)]',
};

/** The icon says what KIND of finding it is; the tile's colour says how much it matters. */
const ICON: Record<FindingId, typeof Check> = {
    tool_pii: TriangleAlert,
    via_network: MapPinOff,
    unknown: TriangleAlert,
    low_score: TriangleAlert,
    many_catches: ScanSearch,
    protected: Check,
};

interface Props {
    findings: Finding[];
    filters: Record<string, unknown>;
    onShow: (action: FindingAction) => void;
    onGoTo?: (pane: string) => void;
    fmt: (n: number) => string;
    t: TranslateFn;
}

function FindingCard({ finding, showing, onShow, onGoTo, fmt, t }: Omit<Props, 'findings' | 'filters'> & { finding: Finding; showing: boolean }) {
    const { title, body } = findingCopy(finding, t, fmt);
    const Icon = ICON[finding.id];
    const { action } = finding;
    return (
        <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-2.5 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2.5">
            <span aria-hidden="true" className={`grid h-[22px] w-[22px] place-items-center rounded-md ${TILE[finding.tone]}`}>
                <Icon className="h-[13px] w-[13px]" aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-col gap-[3px]">
                <p className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{title}</p>
                {body && <p className="m-0 text-xs leading-[17px] text-[var(--text-secondary)] [text-wrap:pretty]">{body}</p>}
                {(action || (finding.link && onGoTo)) && (
                    <div className="mt-[3px] flex flex-wrap gap-3 text-xs font-semibold">
                        {action && (
                            <button
                                type="button"
                                aria-pressed={showing}
                                onClick={() => onShow(action)}
                                className="inline-flex items-center gap-1 text-[var(--text-primary)] hover:underline"
                            >
                                <ListFilter className="h-3 w-3" aria-hidden="true" />
                                {showing ? t('shield_activity.showing_these', 'Showing these') : t('shield_activity.show_these', 'Show these')}
                            </button>
                        )}
                        {finding.link && onGoTo && (
                            <button
                                type="button"
                                onClick={() => onGoTo(finding.link as string)}
                                className="inline-flex items-center gap-1 text-[var(--info-ink)] hover:underline"
                            >
                                {t('shield_activity.fix_tools_link', 'Hold kinds back from tools')}
                                <ArrowRight className="h-3 w-3" aria-hidden="true" />
                            </button>
                        )}
                    </div>
                )}
            </div>
        </li>
    );
}

export function WorthALook({ findings, filters, onShow, onGoTo, fmt, t }: Props) {
    return (
        <div className="flex flex-col gap-2 px-[18px] py-4">
            <div className="flex items-center gap-2">
                <Eyebrow>{t('shield_activity.worth_a_look', 'Worth a look')}</Eyebrow>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                    {findings.length === 1
                        ? t('shield_activity.findings_one', '1 finding')
                        : t('shield_activity.findings_many', '{n} findings', { n: findings.length })}
                </span>
            </div>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {findings.map(f => (
                    <FindingCard
                        key={f.id}
                        finding={f}
                        showing={isShowing(f, filters)}
                        onShow={onShow}
                        onGoTo={onGoTo}
                        fmt={fmt}
                        t={t}
                    />
                ))}
            </ul>
        </div>
    );
}

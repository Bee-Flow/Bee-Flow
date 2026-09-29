import { ArrowRight, MessageSquare, Wrench } from 'lucide-react';
import React from 'react';

import { actionStep, lastCheckReadout } from './checksModel';
import type { GoTo, TranslateFn } from './checksTypes';

/**
 * The path a message takes, drawn once above the two cards that configure it.
 *
 * The commonest misreading of this pane was treating the two checks as
 * alternatives: an admin sets step ① to "Do not send the message", expects
 * people to get the Ask dialog, and never sees one. Drawn as a path it is
 * plain that ① runs on every message and ② is one extra look on the branch
 * to an outside AI.
 *
 * The tool box on the right is the gap an admin does not expect: a tool call
 * is not a message, so neither check sees it. It links to where that IS set.
 */

const STEP_ONE = '①';

function Arrow({ small = false }: { small?: boolean }) {
    return (
        <ArrowRight
            aria-hidden="true"
            className={`${small ? 'w-3 h-3' : 'w-3.5 h-3.5'} shrink-0 text-[var(--text-tertiary)]`}
        />
    );
}

function Box({ outlined = false, warn = false, title, sub, subWarn = false }: {
    outlined?: boolean;
    warn?: boolean;
    title: React.ReactNode;
    sub: string;
    subWarn?: boolean;
}) {
    const frame = !outlined
        ? 'bg-[var(--bg-secondary)]'
        : warn ? 'border-2 border-[var(--warning)]' : 'border-2 border-[var(--text-primary)]';
    return (
        <div className={`px-3 py-2 rounded-[9px] flex flex-col gap-px ${frame}`}>
            <span className="font-semibold">{title}</span>
            <span className={subWarn ? 'text-[var(--warning-ink)]' : 'text-[var(--text-tertiary)]'}>{sub}</span>
        </div>
    );
}

function Branches({ readout, t }: { readout: string; t: TranslateFn }) {
    return (
        <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
            <li className="flex items-center gap-2">
                <span className="px-2.5 py-1.5 rounded-lg font-semibold bg-[color-mix(in_srgb,var(--success-ink)_10%,transparent)] text-[var(--success-ink)]">
                    {t('shield_checks.flow_inside', 'AI on your server')}
                </span>
                <Arrow small />
                <span className="text-[var(--text-tertiary)]">{t('shield_checks.flow_done', 'done')}</span>
            </li>
            <li className="flex flex-wrap items-center gap-2">
                <span className="px-2.5 py-1.5 rounded-lg font-semibold border-2 border-[var(--text-primary)]">
                    {t('shield_checks.flow_outside', '② Outside AI: last check')}
                </span>
                <span className="text-[var(--text-tertiary)]">{readout}</span>
                <Arrow small />
                <span className="text-[var(--text-tertiary)]">{t('admin.shield_pipeline_out', 'AI model')}</span>
            </li>
        </ul>
    );
}

function ToolsBox({ onGoTo, t }: { onGoTo?: GoTo; t: TranslateFn }) {
    return (
        <button
            type="button"
            onClick={() => onGoTo?.('detection')}
            className="ml-auto max-w-[260px] @max-[1119px]/pane:ml-0 @max-[1119px]/pane:max-w-none @max-[1119px]/pane:w-full px-3 py-2 rounded-[9px] flex flex-col gap-px text-left bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning-ink)] hover:bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] transition-colors"
        >
            <span className="flex items-center gap-1.5 font-semibold">
                <Wrench aria-hidden="true" className="w-[13px] h-[13px] shrink-0" />
                {t('shield_checks.flow_tools_skip', 'Tool calls skip ① and ②')}
            </span>
            <span>{t('shield_checks.flow_tools_follow', 'They follow the tool columns in the matrix.')}</span>
        </button>
    );
}

export function ChecksFlow({
    kinds, piiAction, canTokenize, dlpEnabled, dlpMode, onGoTo, t,
}: {
    /** Built-in kinds the detector looks for — the strip's "n of 21". */
    kinds: number;
    piiAction: string;
    canTokenize: boolean;
    dlpEnabled: boolean;
    dlpMode: string;
    onGoTo?: GoTo;
    t: TranslateFn;
}) {
    const action = actionStep(piiAction, canTokenize);
    const check = lastCheckReadout(dlpEnabled, dlpMode);
    return (
        <div className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] shadow-[var(--shadow-sm)] px-[18px] py-4 flex flex-wrap items-center gap-x-2.5 gap-y-3 text-xs text-[var(--text-primary)]">
            <ol
                aria-label={t('shield_checks.flow_label', 'How a message is checked')}
                className="m-0 p-0 list-none flex flex-wrap items-center gap-2.5"
            >
                <li className="px-3 py-2 rounded-[9px] bg-[var(--bg-secondary)] flex items-center gap-1.5 font-semibold">
                    <MessageSquare aria-hidden="true" className="w-[13px] h-[13px] shrink-0" />
                    {t('admin.shield_pipeline_in', 'Message')}
                </li>
                <li className="flex items-center gap-2.5">
                    <Arrow />
                    <Box
                        title={t('shield_checks.flow_look', 'Look for personal data')}
                        sub={t('shield_checks.flow_kinds', '{n} kinds · on your server', { n: kinds })}
                        subWarn={kinds === 0}
                    />
                </li>
                <li className="flex items-center gap-2.5">
                    <Arrow />
                    <Box
                        outlined
                        warn={action.unlicensed}
                        title={<>{STEP_ONE} {t(action.key, action.fallback)}</>}
                        sub={action.unlicensed
                            ? t('shield_checks.flow_unlicensed', 'not in your plan · stopped instead')
                            : t('shield_checks.flow_every', 'every message, always')}
                        subWarn={action.unlicensed}
                    />
                </li>
                <li className="flex items-center gap-2.5">
                    <Arrow />
                    <Branches readout={t(check.key, check.fallback)} t={t} />
                </li>
            </ol>
            <ToolsBox onGoTo={onGoTo} t={t} />
        </div>
    );
}

export default ChecksFlow;

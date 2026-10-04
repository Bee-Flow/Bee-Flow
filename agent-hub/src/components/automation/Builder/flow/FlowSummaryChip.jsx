import React from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { isInlineId } from './inlineFlowlets';

const BRANCHERS = new Set(['condition', 'switch', 'filter', 'guard']);

/**
 * What the canvas holds, in one line: "14 steps · 1 branch · 1 loop" — the
 * context chip in the north-west zone (design 1a). Counts the numbered
 * cards: triggers and top-level steps, not notes, not the folded-in
 * contents of an expanded container.
 *
 * Pure; exported for the test.
 */
export function flowSummary(definition) {
    if (!definition?.trigger) return { steps: 0, branches: 0, loops: 0, empty: true };
    const nodes = [definition.trigger, ...(definition.triggers || []), ...(definition.steps || [])]
        .filter(s => s && s.id && !isInlineId(s.id) && s.type !== 'note');
    let branches = 0;
    let loops = 0;
    for (const s of nodes) {
        if (BRANCHERS.has(s.type)) branches += 1;
        if (s.type === 'loop') loops += 1;
    }
    return { steps: nodes.length, branches, loops, empty: false };
}

export default function FlowSummaryChip({ definition }) {
    const { t } = useTranslation();
    const s = flowSummary(definition);
    const parts = s.empty
        ? [t('automations.canvas.summary_empty', 'New automation · no trigger yet')]
        : [
            s.steps === 1 ? t('automations.canvas.summary_step', '{n} step', { n: s.steps }) : t('automations.canvas.summary_steps', '{n} steps', { n: s.steps }),
            ...(s.branches ? [s.branches === 1 ? t('automations.canvas.summary_branch', '{n} branch', { n: 1 }) : t('automations.canvas.summary_branches', '{n} branches', { n: s.branches })] : []),
            ...(s.loops ? [s.loops === 1 ? t('automations.canvas.summary_loop', '{n} loop', { n: 1 }) : t('automations.canvas.summary_loops', '{n} loops', { n: s.loops })] : []),
        ];
    return (
        <div
            className="px-2.5 py-[5px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] text-[12px] text-[var(--text-secondary)] shadow-sm whitespace-nowrap"
            data-testid="flow-summary"
        >
            {parts.join(' · ')}
        </div>
    );
}

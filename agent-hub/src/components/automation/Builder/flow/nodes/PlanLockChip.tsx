import React from 'react';
import { Lock } from 'lucide-react';
import { NodeChip } from './StepNodeBase';
import { useTranslation } from '../../../../../hooks/useTranslation';

/**
 * The plan lock on a step that is already on the canvas (flow/planLockModel.ts;
 * the node reads `reason` with usePlanLockReason (flow/usePlanLocks.ts) and passes it in, so a card
 * without a lock gets no badge slot at all).
 *
 * A chip, not a disabled card: the step may well be live and running, which it
 * keeps doing after a lapse, and nothing about it is broken. What the plan
 * refuses is going live or testing with it as a NEW step, and the title says
 * so.
 */
export default function PlanLockChip({ reason }: { reason: string | null }) {
    const { t } = useTranslation();
    if (!reason) return null;
    return (
        <NodeChip tone="warn" title={reason}>
            <Lock size={10} aria-hidden /> {t('automation.plan.badge', 'Enterprise')}
        </NodeChip>
    );
}

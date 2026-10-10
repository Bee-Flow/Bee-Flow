import React from 'react';

import type { ShieldEvidence } from '../activity/useShieldEvidence';
import type { ChecksEnv, ChecksFields, ChecksLicence, GoTo, TranslateFn } from './checks/checksTypes';
import { EveryMessageCard } from './checks/EveryMessageCard';
import { LeavingCard } from './checks/LeavingCard';

/** The two check steps of the path, by their tab id. */
export type CheckStep = 'processing' | 'outbound';

/**
 * Steps 3 and 4 of the path: one card each.
 *
 * ── Why one pane per step ─────────────────────────────────────────────────
 * The two checks used to share a pane: both tab ids rendered a flow drawing
 * plus both cards, so `?tab=processing` and `?tab=outbound` were the same
 * screen with a different step lit up on the strip. That read as a bug
 * ("two tabs, one page"), and the drawing repeated what the numbered strip
 * already says. The strip is now the one picture of the order; each step
 * shows the settings it owns, numbered as on the strip (3, 4), and each
 * card's subtitle says when it runs: step 3 on every message, step 4 only on
 * the way to an AI outside the organisation.
 *
 * Which kinds a TOOL may carry is not here: it lives in the detection matrix,
 * beside "do we even look for this". Card 4's footer points there.
 */
export function ChecksTab({
    step, f, readOnly = false, licence, env, evidence = null, onGoTo, t,
}: {
    step: CheckStep;
    f: ChecksFields;
    readOnly?: boolean;
    licence: ChecksLicence;
    env: ChecksEnv;
    /** The last 30 days in numbers; null = unknown, never a zero. */
    evidence?: ShieldEvidence | null;
    onGoTo?: GoTo;
    t: TranslateFn;
}) {
    if (step === 'outbound') {
        return (
            <LeavingCard
                f={f}
                readOnly={readOnly}
                licence={licence}
                env={env}
                evidence={evidence}
                onGoTo={onGoTo}
                t={t}
            />
        );
    }
    return <EveryMessageCard f={f} readOnly={readOnly} licence={licence} t={t} />;
}

export default ChecksTab;

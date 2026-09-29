import React from 'react';

import type { ShieldEvidence } from '../activity/useShieldEvidence';
import { builtInOnly } from '../ownData/ownDataModel';
import { ChecksFlow } from './checks/ChecksFlow';
import type { ChecksEnv, ChecksFields, ChecksLicence, GoTo, TranslateFn } from './checks/checksTypes';
import { EveryMessageCard } from './checks/EveryMessageCard';
import { LeavingCard } from './checks/LeavingCard';

/**
 * The two checks, in the order they run: the path a message takes on top,
 * then one card per check.
 *
 * ── Why this is ONE pane and not two ──────────────────────────────────────
 * "When we find something" and "Leaving your org" used to be separate tabs,
 * and the commonest misreading of this screen was treating them as
 * alternatives. They are not: ① closes on EVERY message; ② is one extra look,
 * only when the model is outside the organisation, and the only place an
 * employee gets a say. Both pipeline ids (`processing`, `outbound`) render
 * this pane, so old `?tab=` bookmarks keep working; the header marks which
 * step was asked for, so the pane no longer emphasises a column itself
 * (`emphasis` is still accepted, and ignored).
 *
 * Which kinds a TOOL may carry is not here: it lives in the detection matrix,
 * beside "do we even look for this". Both the flow and card ② point there.
 */
export function ChecksTab({
    f, readOnly = false, licence, env, evidence = null, onGoTo, t,
}: {
    f: ChecksFields;
    readOnly?: boolean;
    licence: ChecksLicence;
    env: ChecksEnv;
    /** The last 30 days in numbers; null = unknown, never a zero. */
    evidence?: ShieldEvidence | null;
    emphasis?: string;
    onGoTo?: GoTo;
    t: TranslateFn;
}) {
    return (
        <div className="flex flex-col gap-3.5">
            <ChecksFlow
                // The org's own types are not "kinds" in the strip's n of 21.
                kinds={builtInOnly(f.piiCategories).length}
                piiAction={f.piiAction}
                canTokenize={licence.canTokenizePii}
                dlpEnabled={f.dlpEnabled}
                dlpMode={f.dlpMode}
                onGoTo={onGoTo}
                t={t}
            />
            <div className="grid grid-cols-1 @min-[1180px]/pane:grid-cols-2 gap-3.5 items-start">
                <EveryMessageCard f={f} readOnly={readOnly} licence={licence} t={t} />
                <LeavingCard
                    f={f}
                    readOnly={readOnly}
                    licence={licence}
                    env={env}
                    evidence={evidence}
                    onGoTo={onGoTo}
                    t={t}
                />
            </div>
        </div>
    );
}

export default ChecksTab;

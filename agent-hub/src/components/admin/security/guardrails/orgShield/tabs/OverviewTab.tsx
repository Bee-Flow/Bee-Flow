import { Layers, ShieldOff } from 'lucide-react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { ShieldEvidence } from '../activity/useShieldEvidence';
import { reviewItems } from '../orgShieldPosture';
import ComplianceLink from '../overview/ComplianceLink';
import LastThirtyDays from '../overview/LastThirtyDays';
import MasterSwitch from '../overview/MasterSwitch';
import type { CopyContext } from '../overview/overviewCopy';
import ReviewCard from '../overview/ReviewCard';
import StepCards from '../overview/StepCards';
import type { GoTo, GuardStatus, OverviewFields, Posture, PostureRow } from '../overview/types';
import WhatPeopleSee from '../overview/WhatPeopleSee';

/**
 * "How does this organisation stand right now?"
 *
 * The master switch; then what asks for attention (the review card); then the
 * whole posture, grouped by the step of the path where a message meets each
 * setting. On the right, the consequences: the last 30 days, what people see
 * in a chat, and which Compliance checks this document drives.
 *
 * Everything below the switch is DERIVED (see orgShieldPosture.js). No
 * setting has a second home here; every link jumps to the pane that owns it.
 */

export interface OverviewTabProps {
    f: OverviewFields;
    posture: Posture;
    guard: GuardStatus | null;
    meta?: { updatedAt?: string | number | null; updatedBy?: string | null } | null;
    readOnly?: boolean;
    /** The last 30 days, or null when unknown — then nothing evidence-based is drawn. */
    evidence?: ShieldEvidence | null;
    /** The mount offers "What happened" and the plan includes it. */
    showActivity?: boolean;
    licence?: { canUseCustomData?: boolean };
    t: TranslateFn;
    onGoTo: GoTo;
    onDiagnoseGuard?: () => void;
    onOpenCompliance?: () => void;
}

function ShieldOffNote({ t }: { t: TranslateFn }) {
    return (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
            <ShieldOff className="w-4 h-4 shrink-0 mt-0.5 text-[var(--text-tertiary)]" aria-hidden="true" />
            <p className="m-0 text-xs leading-relaxed text-[var(--text-secondary)]">
                {t('admin.shield_disabled_note_steps',
                    'Protection is off for this organisation. Messages go to the AI unchanged, and the other steps stay inactive until you turn it on.')}
            </p>
        </div>
    );
}

/** Where these rules sit relative to an agent's own: first, and stricter wins. */
function RulesOrderNote({ t }: { t: TranslateFn }) {
    return (
        <div className="flex gap-2.5 items-start px-4 py-3 rounded-xl bg-[color-mix(in_srgb,var(--info-ink)_6%,transparent)] text-xs leading-[18px] text-[var(--text-secondary)]">
            <Layers className="w-[15px] h-[15px] shrink-0 mt-px text-[var(--info-ink)]" aria-hidden="true" />
            <p className="m-0">
                <strong className="font-semibold text-[var(--text-primary)]">
                    {t('shield_overview.rules_lead', 'Agents can be stricter, never looser.')}
                </strong>{' '}
                {t('shield_overview.rules_body',
                    'These rules run before any rules on an individual agent. If the two disagree, the stricter one wins.')}
            </p>
        </div>
    );
}

type LeftProps = OverviewTabProps & { ctx: CopyContext; items: PostureRow[] };

function PostureColumn({ posture, evidence, showActivity = false, ctx, items, t, onGoTo, onDiagnoseGuard }: LeftProps) {
    return (
        <>
            <ReviewCard
                items={items}
                hasEvidence={!!evidence}
                showActivity={showActivity}
                t={t}
                onGoTo={onGoTo}
                onDiagnoseGuard={onDiagnoseGuard}
            />
            <StepCards posture={posture} ctx={ctx} onGoTo={onGoTo} />
            <RulesOrderNote t={t} />
        </>
    );
}

export function OverviewTab(props: OverviewTabProps) {
    const { f, posture, guard, meta, readOnly, evidence = null, showActivity = false, licence, t, onGoTo, onOpenCompliance } = props;
    const ctx: CopyContext = {
        t,
        ownDataLicensed: licence?.canUseCustomData !== false,
        customTypes: f.customDataTypes || [],
        guard,
    };
    return (
        // Asymmetric on a wide screen: the posture earns the room, the
        // consequences column is a fixed 380px. One column below that.
        <div className="grid gap-4 items-start grid-cols-1 @min-[960px]/pane:grid-cols-[minmax(0,1fr)_340px] @min-[1280px]/pane:grid-cols-[minmax(0,1fr)_380px]">
            <div className="flex flex-col gap-3.5 min-w-0">
                <MasterSwitch enabled={!!f.enabled} onChange={f.setEnabled} readOnly={readOnly} t={t} />
                {posture.off
                    ? <ShieldOffNote t={t} />
                    : <PostureColumn {...props} ctx={ctx} items={reviewItems(posture) as PostureRow[]} />}
            </div>
            <div className="flex flex-col gap-3.5 min-w-0">
                {showActivity && evidence && <LastThirtyDays evidence={evidence} t={t} onGoTo={onGoTo} />}
                <WhatPeopleSee f={f} guard={guard} t={t} />
                <ComplianceLink f={f} updatedAt={meta?.updatedAt} updatedBy={meta?.updatedBy} onOpen={onOpenCompliance} t={t} />
            </div>
        </div>
    );
}

export default OverviewTab;

import React from 'react';
import { STAGE_DOT, STAGE_INK, STAGE_TINT, useStageLabel } from './StageSwitcher';
import type { StageName } from './stagesApi';

/**
 * A stage as a small chip: dot + text label (colour is never the only signal),
 * tinted when `active`.
 */
export interface StageChipProps {
    stage: StageName;
    /** Replaces the stage name (for example "UAT · R2"). */
    label?: string;
    active?: boolean;
}

export default function StageChip({ stage, label, active = false }: StageChipProps) {
    const stageName = useStageLabel();
    return (
        <span
            data-testid={`stage-chip-${stage}`}
            data-active={active ? 'true' : 'false'}
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${active ? `${STAGE_TINT[stage]} ${STAGE_INK[stage]}` : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}
        >
            <span className={`inline-block w-2 h-2 rounded-full ${STAGE_DOT[stage]}`} aria-hidden="true" />
            {label ?? stageName(stage)}
        </span>
    );
}

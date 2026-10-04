/**
 * The stage for the phase in hand, chosen by its KIND — a custom recipe's
 * phases carry any key.
 */

import React from 'react';

import { AccessStage } from './AccessStage';
import { BuilderStage } from './BuilderStage';
import { ComplianceStage } from './ComplianceStage';
import { DesignStage } from './DesignStage';
import { FillStage } from './FillStage';
import { TableStage } from './TableStage';
import { kindOf, type PlaybookEvent } from '../model/phaseMachine';
import type { Phase, Playbook } from '../model/types';

export interface StageProps {
    playbook: Playbook;
    phase: Phase;
    dispatch: (event: PlaybookEvent) => Promise<Playbook | null>;
}

export function Stage({ playbook, phase, dispatch }: StageProps) {
    switch (kindOf(phase)) {
        case 'table': return <TableStage playbook={playbook} phase={phase} />;
        case 'fill': return <FillStage playbook={playbook} phase={phase} />;
        case 'design': return <DesignStage phase={phase} dispatch={dispatch} />;
        case 'automation':
        case 'app':
        case 'app_turn': return <BuilderStage phase={phase} dispatch={dispatch} />;
        case 'access': return <AccessStage playbook={playbook} phase={phase} dispatch={dispatch} />;
        case 'compliance': return <ComplianceStage playbook={playbook} phase={phase} />;
        default: return null;
    }
}

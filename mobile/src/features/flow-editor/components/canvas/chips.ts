/**
 * The words and tone of a line's chip — the web's edges.jsx CHIP_TEXT and
 * its tone ladder. A brancher's port already prints its branch's name, so a
 * line out of it shows no chip (edgeModel `labelledAtPort`); what is left is
 * an error path out of an ordinary step, a case whose port is gone, and the
 * warning that an unlabelled line out of a brancher never runs.
 *
 * The web says these in fixed English; the phone uses the outline's lane
 * words for the same branches, so a lane and a line read the same.
 */

import type { TranslateFn } from '@/core/i18n';
import type { LaneTone } from '@/features/flow-editor/model/outline';

/** A chip's colour: a lane tone, or the red dashed warning. */
export type ChipTone = LaneTone | 'unrouted';

const TONE: Readonly<Record<string, ChipTone>> = {
    then: 'then',
    pii_clean: 'then',
    else: 'else',
    pii_found: 'else',
    default: 'default',
    on_error: 'error',
    unrouted: 'unrouted',
};

export function chipTone(kind: string): ChipTone {
    return Object.prototype.hasOwnProperty.call(TONE, kind) ? (TONE[kind] as ChipTone) : 'case';
}

/** A branch name is the author's own word; the rest are the canvas's. */
export function chipWords(kind: string, t: TranslateFn): string {
    switch (kind) {
        case 'then':
            return t('mobile.flow.lane.match', 'match');
        case 'else':
        case 'default':
            return t('mobile.flow.lane.otherwise', 'otherwise');
        case 'pii_found':
            return t('mobile.flow.lane.personal_data', 'personal data');
        case 'pii_clean':
            return t('mobile.flow.lane.clean', 'clean');
        case 'on_error':
            return t('routines.canvas.loop_port_on_error', 'On error');
        case 'unrouted':
            return t('mobile.flow.canvas.never_runs', 'never runs');
        default:
            return kind;
    }
}

/** Whether a line shows a chip at all. */
export function showsChip(edge: { kind: string | null; labelledAtPort: boolean }): boolean {
    return !!edge.kind && !edge.labelledAtPort;
}

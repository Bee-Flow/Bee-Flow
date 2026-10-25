/**
 * AiActLadderModal — "Does the AI Act apply here?", the three-step ladder per
 * automation or agent (Compliance Center redesign, Sep 2026; artboard frame
 * 1f). Art. 5 → Art. 50 → Annex III, in that order: the answers to 1 and 3
 * are a human's declaration (negation chips), step 2 is what the checks see
 * in the signals (disclosure shown, marking enabled) and is never answered by
 * hand.
 *
 * Mounted OUTSIDE the hub (automation builder Settings tab, agent wizard
 * Advanced drawer, and FE-7's per-automation table), so it carries its own
 * data hook (`useAiActAssessment`) and reads through data/api.js directly.
 * Two ways to mount it:
 *   <AiActLadderModal open kind target data={hookResult} onClose />   — the block passes its hook
 *   <AiActLadderModal open kind target onClose />                     — standalone; the modal owns the hook
 *
 * Colours: the kind tile in --kind-compliance, the AI sparkle in --type-ai,
 * verdicts through statusTone TONES (raw for hairlines/discs, ink for text).
 */
import { type LucideIcon } from 'lucide-react';
import type { LadderData, LadderSubject } from '../useAiActAssessment';
import type { LadderModalViewProps } from '../AiActLadderModal.types';
import { StandaloneLadder, LadderModalView } from './StandaloneLadder';
;

export default function AiActLadderModal(props: LadderModalViewProps) {
    if (props.data) return <LadderModalView {...props} />;
    return <StandaloneLadder {...props} />;
}

/* ----------------------------------------------------------------------- */


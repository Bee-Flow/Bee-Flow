/**
 * The web's `agent-hub/src/components/automation/Builder/flow/settings/formState/approvalStages.ts`,
 * generated into mirror/ by scripts/gen-shared-mirror.mjs (npm run gen:shared;
 * npm run lint:shared-mirror fails on a stale copy). Change the web file, never
 * the mirror; this path stays so the phone's importers did not change. The two
 * readers take `unknown` here: a definition arrives from the API untyped.
 */
import {
    cleanApprovalSeat as webCleanApprovalSeat,
    stageSeats as webStageSeats,
    type ApprovalSeat,
} from '../bindings/mirror/formState/approvalStages';

export {
    approvalSeatKey,
    MAX_APPROVAL_STAGES,
    MAX_SEATS_PER_STAGE,
    MAX_STAGE_DESCRIPTION_LEN,
    MAX_STAGE_NAME_LEN,
    MAX_TOTAL_STAGE_SEATS,
    newStageKey,
    sanitizeApprovalStages,
    STAGE_RULES,
    totalStageSeats,
    type ApprovalSeat as Seat,
} from '../bindings/mirror/formState/approvalStages';

export const cleanApprovalSeat = webCleanApprovalSeat as (raw: unknown) => ApprovalSeat | null;
export const stageSeats = webStageSeats as (stage: unknown) => ApprovalSeat[];

import { useEffect, useState } from 'react';
import useAutomationApi from '@/hooks/useAutomationApi';
import { STAGE_RULES, stageSeats, newStageKey } from './formState';
import { seatFromSelectValue } from './approvalTypes';
import type { ApprovalDirectory, ApprovalDraft, SeatSlot, SetDraft } from './approvalTypes';

type Translate = (key: string, fallback: string) => string;

const EMPTY_DIRECTORY: ApprovalDirectory = { members: [], groups: [] };

function isDirectory(value: unknown): value is ApprovalDirectory {
    return !!value && typeof value === 'object';
}

/**
 * The org directory that feeds the approver picker. Loaded lazily and cached
 * for the editor's lifetime; a failed load degrades to owner-only rather than
 * blocking the section.
 */
export function useApprovalDirectory(): ApprovalDirectory | null {
    const api = useAutomationApi();
    const [directory, setDirectory] = useState<ApprovalDirectory | null>(null);
    useEffect(() => {
        let alive = true;
        api.approvalDirectory()
            .then(d => { if (alive) setDirectory(isDirectory(d) ? d : EMPTY_DIRECTORY); })
            .catch(() => { if (alive) setDirectory(EMPTY_DIRECTORY); });
        return () => { alive = false; };
    }, [api]);
    return directory;
}

const isPicked = (seat: SeatSlot | undefined): boolean => !!seat && !!(seat.userId || seat.groupId);

/** Replace seat `i` of the panel by the encoded <select> value. */
export function withSeat(panelSeats: SeatSlot[], i: number, encoded: string): SeatSlot[] {
    return panelSeats.map((seat, idx) => (idx === i ? seatFromSelectValue(encoded) : seat));
}

/**
 * Switch to stage mode. Stages and the legacy fields (assignee / panel / final
 * sign-off / escalation) SUPERSEDE one another: validate.js errors on the
 * combination (approval.stages_conflict) rather than silently never ask
 * someone who believes they are in the chain. So this is a MODE SWITCH, not a
 * second section — turning stages on clears the legacy fields, and turning
 * them off clears the chain.
 */
export function startStages(draft: ApprovalDraft, panelSeats: SeatSlot[], set: SetDraft, t: Translate): void {
    const picked = panelSeats.filter(isPicked);
    const first = picked.length ? picked : (draft.assignee ? [draft.assignee] : []);
    const rule = picked.length >= 2 && draft.rule && STAGE_RULES.includes(draft.rule) ? draft.rule : 'all';
    const chain = [{
        // A fresh chain, so `newStageKey` simply yields s1 — but it is
        // the ONLY minting path, and it never re-uses a key in play.
        key: newStageKey([]),
        name: '',
        description: '',
        // A stage with no seat yet still opens with one empty row to pick in.
        approvers: first.length ? first : [null],
        rule: picked.length >= 2 ? rule : 'all',
        ...(picked.length >= 2 && rule === 'quorum' ? { quorum: Number(draft.quorum) || 2 } : {}),
    }];
    const finalSeat = draft.finalApprover;
    if (finalSeat?.userId || finalSeat?.groupId) {
        chain.push({
            key: newStageKey(chain),
            name: t('automations.builder.approval_final_stage_name', 'Final sign-off'),
            description: '',
            approvers: [finalSeat],
            rule: 'first',
        });
    }
    // Seed first, THEN clear — nothing the author already picked is lost.
    set('stages', chain);
    set('assignee', null);
    set('approvers', []);
    set('finalApprover', null);
    set('escalateTo', null);
    set('escalateAfterHours', '');
}

/**
 * Back to the simple shape. Carries back everything it can still express: the
 * first stage becomes the approver(s), and a single-seat last stage becomes the
 * final sign-off. The stages in between have nowhere to go, which is what the
 * button's copy says.
 */
export function dropStages(stages: Array<Record<string, unknown>>, set: SetDraft): void {
    const first = stages[0] || null;
    const firstSeats = stageSeats(first);
    const last = stages.length > 1 ? stages[stages.length - 1] : null;
    const lastSeats = stageSeats(last);
    set('stages', []);
    if (firstSeats.length > 1) {
        set('approvers', firstSeats);
        set('assignee', null);
        set('rule', typeof first?.rule === 'string' && STAGE_RULES.includes(first.rule) ? first.rule : 'all');
        if (first?.rule === 'quorum') set('quorum', Math.min(Math.max(Number(first.quorum) || 2, 1), firstSeats.length));
    } else {
        set('approvers', []);
        set('assignee', firstSeats[0] || null);
    }
    set('finalApprover', lastSeats.length === 1 ? lastSeats[0] : null);
}

/** extractFormState for the approval step: flattened for the form, re-nested by buildPatch. */
import type { TypeExtractor } from '../types';

export const approvalExtractors: Record<string, TypeExtractor> = {
    approval: (step, base) => {
        return {
            ...base,
            prompt: step.prompt || '',
            // Flattened for the form, re-nested by buildPatch. The NESTED
            // value is read first and the legacy top-level one second, in the
            // engine's own precedence order — an editor that showed 7 days
            // while the run enforced 2 would be worse than showing nothing.
            expiresInHours: typeof step.approval?.expiresInHours === 'number' ? step.approval.expiresInHours
                : (typeof step.expiresInHours === 'number' ? step.expiresInHours : 168),
            // The rich half. Kept as the persisted shapes — the editor's rows
            // edit them in place and buildPatch re-normalizes.
            assignee: (step.approval?.assignee && typeof step.approval.assignee === 'object') ? step.approval.assignee : null,
            details: step.approval?.details || '',
            attachments: Array.isArray(step.approval?.attachments) ? step.approval.attachments : [],
            approvalFields: Array.isArray(step.approval?.fields) ? step.approval.fields : [],
            // v2 clocks: '' = off (a reminder is opt-in, unlike the deadline).
            remindAfterHours: typeof step.approval?.remindAfterHours === 'number' ? step.approval.remindAfterHours : '',
            escalateTo: (step.approval?.escalateTo && typeof step.approval.escalateTo === 'object') ? step.approval.escalateTo : null,
            escalateAfterHours: typeof step.approval?.escalateAfterHours === 'number' ? step.approval.escalateAfterHours : '',
            // Panel: seats ({userId}|{groupId}), how votes resolve, and the
            // optional final sign-off. Empty array = single-approver mode.
            approvers: Array.isArray(step.approval?.approvers) ? step.approval.approvers : [],
            rule: ['all', 'first', 'quorum'].includes(step.approval?.rule) ? step.approval.rule : 'all',
            quorum: typeof step.approval?.quorum === 'number' ? step.approval.quorum : 2,
            finalApprover: (step.approval?.finalApprover && typeof step.approval.finalApprover === 'object') ? step.approval.finalApprover : null,
            // The stage CHAIN. Kept as the persisted array so the editor's
            // rows edit the very objects that were saved — in particular each
            // stage's `key`, which is what already-cast votes are filed under.
            // Rebuilding the keys here (or anywhere positional) would orphan
            // the votes of a stage that already ran the moment the author
            // reordered or renamed one.
            stages: Array.isArray(step.approval?.stages) ? step.approval.stages : [],
        };
    },
};

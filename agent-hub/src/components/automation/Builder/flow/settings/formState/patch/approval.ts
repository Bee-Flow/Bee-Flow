/** buildPatch for the approval step: the nested `approval` config, normalised like the server's. */
import { sanitizeApprovalStages } from '../approvalStages';
import { clamp } from '../primitives';
import type { FormRecord, JsonValue, TypePatcher } from '../types';

export const approvalPatchers: Record<string, TypePatcher> = {
    approval: (patch, step, draft) => {
        patch.prompt = draft.prompt || '';
        // Bounds AND unset-handling mirror clampApprovalHours /
        // normalizeApprovalConfig in server/automation/builderTools.js, so a
        // hand-built approval and an AI-built one are the same object.
        // The `|| 0` idiom used everywhere else in this file would be a bug
        // here: 0 is the meaningful value "no deadline", so an ABSENT field
        // must fall through to the 7-day default rather than collapsing into
        // an approval that never expires.
        const rawHours = draft.expiresInHours;
        const approvalCfg: FormRecord = {
            expiresInHours: (rawHours === null || rawHours === undefined || rawHours === '' || !Number.isFinite(Number(rawHours)))
                ? 168
                : clamp(Math.round(Number(rawHours)), 0, 720),
        };
        // The stage chain SUPERSEDES every legacy approver field. validate.js
        // refuses the combination outright (approval.stages_conflict) rather
        // than let someone believe they are in the chain and never be asked,
        // so with stages present the assignee / panel / final sign-off /
        // escalation are not written at all — the editor presents them as a
        // mode switch for exactly this reason.
        const chain = sanitizeApprovalStages(draft.stages);
        if (chain.length) approvalCfg.stages = chain;
        const a = chain.length ? null : draft.assignee;
        if (a && typeof a === 'object') {
            if (typeof a.userId === 'string' && a.userId.trim()) approvalCfg.assignee = { userId: a.userId.trim() };
            else if (typeof a.groupId === 'string' && a.groupId.trim()) approvalCfg.assignee = { groupId: a.groupId.trim() };
        }
        if (typeof draft.details === 'string' && draft.details.trim()) approvalCfg.details = draft.details;
        const atts = (Array.isArray(draft.attachments) ? draft.attachments : [])
            .filter(x => x && typeof x.binding === 'string' && x.binding.trim())
            .slice(0, 5)
            .map(x => ({ binding: x.binding, ...(x.label && x.label.trim() ? { label: x.label } : {}) }));
        if (atts.length) approvalCfg.attachments = atts;
        const qs = (Array.isArray(draft.approvalFields) ? draft.approvalFields : [])
            .filter(f => f && typeof f === 'object' && (f.name || f.label))
            .slice(0, 20);
        if (qs.length) approvalCfg.fields = qs;
        // Panel mirrors normalizeApprovalConfig: seats cleaned to exactly one
        // of userId/groupId, deduped, capped at 10; a panel present drops the
        // single assignee and (below) the escalation — the final approver is
        // the panel's takeover mechanism.
        const cleanSeat = (x: JsonValue): FormRecord | null => {
            if (!x || typeof x !== 'object') return null;
            if (typeof x.userId === 'string' && x.userId.trim()) return { userId: x.userId.trim() };
            if (typeof x.groupId === 'string' && x.groupId.trim()) return { groupId: x.groupId.trim() };
            return null;
        };
        const seatKeySeen = new Set<string>();
        const seats = chain.length ? [] : (Array.isArray(draft.approvers) ? draft.approvers : [])
            .map(cleanSeat)
            .filter(Boolean)
            .filter((seatObj: JsonValue) => {
                const key = seatObj.userId ? `u:${seatObj.userId}` : `g:${seatObj.groupId}`;
                if (seatKeySeen.has(key)) return false;
                seatKeySeen.add(key);
                return true;
            })
            .slice(0, 10);
        if (seats.length) {
            approvalCfg.approvers = seats;
            delete approvalCfg.assignee;
            approvalCfg.rule = ['all', 'first', 'quorum'].includes(draft.rule) ? draft.rule : 'all';
            if (approvalCfg.rule === 'quorum') {
                const n = Math.round(Number(draft.quorum));
                approvalCfg.quorum = Number.isFinite(n) ? Math.min(Math.max(n, 1), seats.length) : Math.min(2, seats.length);
            }
        }
        const fa = chain.length ? null : cleanSeat(draft.finalApprover);
        if (fa) approvalCfg.finalApprover = fa;
        // Clocks mirror normalizeApprovalConfig: whole hours 1..720, and the
        // escalation is BOTH a target and a delay or nothing — half a config
        // must not persist as a control that silently does nothing.
        const hoursOrNull = (v: JsonValue): number | null => {
            const n = Math.round(Number(v));
            return Number.isFinite(n) && n >= 1 ? Math.min(n, 720) : null;
        };
        const remind = hoursOrNull(draft.remindAfterHours);
        if (remind) approvalCfg.remindAfterHours = remind;
        const et = draft.escalateTo;
        const escTarget = (et && typeof et === 'object')
            ? (typeof et.userId === 'string' && et.userId.trim() ? { userId: et.userId.trim() }
                : (typeof et.groupId === 'string' && et.groupId.trim() ? { groupId: et.groupId.trim() } : null))
            : null;
        const escAfter = hoursOrNull(draft.escalateAfterHours);
        if (escTarget && escAfter && !approvalCfg.approvers && !chain.length) {
            approvalCfg.escalateTo = escTarget;
            approvalCfg.escalateAfterHours = escAfter;
        }
        patch.approval = approvalCfg;
        // undefined REMOVES the key. One field owns the deadline: leaving a
        // legacy top-level expiresInHours behind would let the two disagree,
        // and the engine reads the nested one first.
        patch.expiresInHours = undefined;
    },
};

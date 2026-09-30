/** Contract readers for approvals (server/stores/automationStore/approvals.js). */

import { field, shapeOf } from '@/core/api/contract';

import type { Approval, ApprovalDetail } from '../model/types';

export const readApproval: (raw: unknown) => Approval = shapeOf({
    id: field.str(''),
    automationId: field.strOrNull,
    automationTitle: field.str(''),
    projectTitle: field.str(''),
    runId: field.strOrNull,
    stepId: field.strOrNull,
    source: field.str('run'),
    status: field.str('pending'),
    prompt: field.str(''),
    detailsMd: field.strOrNull,
    context: field.recordOrNull,
    decidedByName: field.strOrNull,
    decisionReason: field.strOrNull,
    decidedAt: field.strOrNull,
    expiresAt: field.strOrNull,
    createdAt: field.str(''),
});

/** `canDecide` and `canWithdraw` read fail-closed: anything but `true` is no. */
export const readApprovalDetail: (raw: unknown) => ApprovalDetail = shapeOf({
    approval: readApproval,
    canDecide: field.bool(false),
    canWithdraw: field.bool(false),
});

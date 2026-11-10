/**
 * App Studio validator — the approver questions of a request_approval step (field type
 * `approvalQuestions`). Split from validate/actions.js; the rules are unchanged.
 *
 * Approver questions: the form vocabulary, ≤ 20, and never `file` — approvers
 * download attachments, they do not upload (matches the automation-approval
 * rule in automation/validate.js).
 */

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (f: Finding) => void };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const APPROVAL_QUESTION_TYPES = new Set(['text', 'textarea', 'number', 'date', 'email', 'select', 'checkbox']);

export function validateApprovalQuestions(field: string, value: unknown, path: string, ctx: Ctx): void {
    const { pushE } = ctx;
    if (!Array.isArray(value)) { pushE({ code: 'action.approval_questions_invalid', severity: 'error', path, message: `\`${field}\` must be an array of question objects.`, hint: 'Use [{ name, label, type, required? }].' }); return; }
    if (value.length > 20) { pushE({ code: 'action.approval_questions_invalid', severity: 'error', path, message: `Too many approver questions (${value.length}; max 20).`, hint: 'An approval is a decision, not a form.' }); return; }
    const seen = new Set<string>();
    value.forEach((q: unknown, i: number) => {
        const qp = `${path}[${i}]`;
        if (!isObject(q) || typeof q.name !== 'string' || !q.name) {
            pushE({ code: 'action.approval_questions_invalid', severity: 'error', path: qp, message: 'Each question needs a `name`.', hint: 'Use { name, label, type }.' });
            return;
        }
        if (seen.has(q.name)) pushE({ code: 'action.approval_questions_invalid', severity: 'error', path: `${qp}.name`, message: `Duplicate question name ${JSON.stringify(q.name)}.`, hint: 'Names key the answers — keep them unique.' });
        seen.add(q.name);
        if (q.type !== undefined && !APPROVAL_QUESTION_TYPES.has(q.type as string)) {
            pushE({ code: 'action.approval_questions_invalid', severity: 'error', path: `${qp}.type`, message: `Question type ${JSON.stringify(q.type)} is not legal.`, hint: `Use one of: ${[...APPROVAL_QUESTION_TYPES].join(', ')}. File uploads from approvers are not supported.` });
        }
    });
}

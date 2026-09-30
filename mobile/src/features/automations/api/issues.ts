/**
 * The flow validator's findings, read tolerantly.
 *
 * Every save path (POST, PUT, activate, restore, import) answers a 400 as
 * `{ error, details: [issue] }` and a success with `warnings: [issue]`, but
 * not every issue comes from the validator: the approval-assignee check sends
 * `{path, message}` only, and the import envelope check sends bare sentences.
 * So a detail is read field by field, a string becomes its own message, and
 * the severity the CALL SITE knows (a 400's details are errors, a save's
 * warnings are warnings) fills the gap. A row with nothing to say is dropped.
 */

import { ApiError } from '@/core/api/client';
import { field, pick } from '@/core/api/contract';

import type { AutomationIssue } from '../model/types';

type Severity = AutomationIssue['severity'];

const SEVERITIES = ['error', 'warning'] as const;

function readIssueRow(raw: unknown, severity: Severity): AutomationIssue | null {
    if (typeof raw === 'string') return raw.trim() ? { severity, message: raw } : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const code = field.optStr(row.code);
    const message = field.optStr(row.message) || field.optStr(row.error) || code || '';
    if (!message) return null;
    const out: AutomationIssue = { severity: field.oneOf(SEVERITIES, severity)(row.severity), message };
    if (code) out.code = code;
    const path = field.optStr(row.path);
    if (path) out.path = path;
    const hint = field.optStr(row.hint);
    if (hint) out.hint = hint;
    const blockedAt = field.optStr(row.blockedAt);
    if (blockedAt) out.blockedAt = blockedAt;
    return out;
}

/** A list of findings; anything that is not a list reads as none. */
export function readIssues(raw: unknown, severity: Severity): AutomationIssue[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((row) => readIssueRow(row, severity)).filter((row): row is AutomationIssue => row !== null);
}

/**
 * The `details` of a refused save or activation — the errors that say WHY —
 * or none when the error is not the server's answer at all.
 */
export function issueDetailsOf(err: unknown): AutomationIssue[] {
    if (!(err instanceof ApiError)) return [];
    return readIssues(pick(err.body, 'details'), 'error');
}

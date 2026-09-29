/**
 * Turning server state into the words and colours these three screens use.
 *
 * Kept out of the components because the same judgement is made in more than
 * one place — a share is "dead" in the list row, in the action sheet, and in
 * the analytics total — and a rule that lives in three renders drifts.
 */

import type { McpServer, WebpageShare } from './types';
import type { BadgeTone } from '../../ui/Badge';

export interface StatusToken {
    label: string;
    tone: BadgeTone;
}

/**
 * A share is usable only while it is neither revoked nor past its expiry.
 *
 * Mirrors isShareLinkable in server/routes/webpageShareUrls.js, including its
 * fail-closed handling of an unparseable expiry: a date we cannot reason about
 * is treated as gone, because the viewer route will reject it anyway and an
 * optimistic "still live" here would just be a lie with a copy button.
 */
export function isShareLive(share: WebpageShare, now: number = Date.now()): boolean {
    if (share.revokedAt) return false;
    if (!share.expiresAt) return true;
    const expiry = Date.parse(share.expiresAt);
    if (Number.isNaN(expiry)) return false;
    return expiry >= now;
}

export function shareStatus(share: WebpageShare, now: number = Date.now()): StatusToken {
    if (share.revokedAt) return { label: 'Revoked', tone: 'neutral' };
    if (!isShareLive(share, now)) return { label: 'Expired', tone: 'warning' };
    if (share.accessMode === 'password') return { label: 'Password', tone: 'accent' };
    if (share.accessMode === 'email') return { label: 'Invite only', tone: 'accent' };
    return { label: 'Live', tone: 'success' };
}

/**
 * How an MCP server is doing.
 *
 * 'disconnected' is the column default, so it means "never probed" far more
 * often than it means "was up, now down" — worth saying, because the fix is a
 * refresh rather than a call to whoever runs the server.
 */
export function mcpStatus(server: McpServer): StatusToken {
    if (!server.enabled) return { label: 'Disabled', tone: 'neutral' };
    switch (server.status) {
        case 'ready':
            return { label: 'Ready', tone: 'success' };
        case 'pending_credentials':
            return { label: 'Needs a key', tone: 'warning' };
        case 'error':
            return { label: 'Failing', tone: 'error' };
        default:
            return { label: 'Not checked', tone: 'neutral' };
    }
}

/** The one-line explanation under an MCP server's name. */
export function mcpSubtitle(server: McpServer): string {
    const where = server.transport === 'stdio' ? server.command || 'local command' : server.url || server.transport;
    const tools = server.toolCount === 1 ? '1 tool' : `${server.toolCount} tools`;
    return `${tools} · ${where}`;
}

/**
 * What became of a submission.
 *
 * A submission is a run, so it carries the runner's status vocabulary rather
 * than a form one — and the words matter here: 'awaiting_form' means the
 * routine paused for a LATER page of a multi-page form, which reads as
 * "half-finished" to the person who sent it and as "working correctly" to the
 * person who built it. 'success' is deliberately "Accepted": the answers
 * arrived either way, and whether the routine behind them worked is a separate
 * question the run history answers.
 */
export function submissionStatus(status: string): StatusToken {
    switch (status) {
        case 'success':
            return { label: 'Accepted', tone: 'success' };
        case 'running':
        case 'queued':
            return { label: 'Processing', tone: 'accent' };
        case 'awaiting_form':
            return { label: 'Part-filled', tone: 'warning' };
        case 'awaiting_approval':
            return { label: 'Needs approval', tone: 'warning' };
        case 'cancelled':
            return { label: 'Cancelled', tone: 'neutral' };
        case 'error':
        case 'failed':
            return { label: 'Failed', tone: 'error' };
        default:
            return { label: status || 'Unknown', tone: 'neutral' };
    }
}

/**
 * A form submission's answers, flattened for display.
 *
 * The payload is the coerced field map, so values are already scalars except
 * for file answers, which are `{ kind: 'form_upload', filename, … }` objects
 * (routes/automation/formPublic.js). Those become the filename, because the
 * bytes live behind a session-scoped endpoint this screen has no session for.
 */
export function submissionAnswers(payload: unknown): { field: string; value: string }[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
    return Object.entries(payload as Record<string, unknown>).map(([field, raw]) => ({
        field,
        value: answerToText(raw),
    }));
}

function answerToText(raw: unknown): string {
    if (raw === null || raw === undefined || raw === '') return '—';
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
    if (Array.isArray(raw)) return raw.map(answerToText).join(', ');
    if (typeof raw === 'object') {
        const obj = raw as { kind?: unknown; filename?: unknown };
        if (obj.kind === 'form_upload' && typeof obj.filename === 'string') return obj.filename;
        try {
            return JSON.stringify(raw);
        } catch {
            return '—';
        }
    }
    return '—';
}

/**
 * Field ids are what the author typed into the builder — `full_name`,
 * `company-size`. Rendering them raw makes a submission read like a database
 * dump, and the form's own labels are not on this payload.
 */
export function humaniseField(field: string): string {
    const words = field.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    if (!words) return field;
    return words.charAt(0).toUpperCase() + words.slice(1);
}

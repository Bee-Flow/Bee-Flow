// A form's test link (Studio → Forms → Share): a separate address that serves
// the automation's WORKING copy to its own audience, whether or not the form is
// live. Every submission through it is a test run (server:
// routes/automation/formTestLink.js, automation/formSubmission.mts).
//
// The ONLY place that knows these wire contracts; GET /forms/:automationId
// already carries `testLink`, so there is no read here.

import { API_BASE, authFetch } from '@/utils/helpers';
import { errorBody } from '@/hooks/useAutomationApi';

/** Who may open the test link: the owner's view of the audience. */
interface TestLinkAudience {
    mode: string;
    groups: string[];
    users: string[];
}

export interface FormTestLink {
    token: string;
    url: string;
    createdAt?: string | null;
    /** null: the link does not expire (AUTOMATION_FORM_TEST_LINK_DAYS = 0). */
    expiresAt: string | null;
    issuedByUserId: string | null;
    audience: TestLinkAudience;
}

/** The body PUT .../audience takes, the same as the form's own audience. */
interface AudienceWrite {
    audience: string;
    sharedGroups: string[];
    sharedUserIds: string[];
}

interface FormTestLinkError extends Error {
    status?: number;
    code?: string;
}

async function send<T>(method: string, automationId: string, tail = '', body?: unknown): Promise<T> {
    const res = await authFetch(`${API_BASE}/api/automation/forms/${encodeURIComponent(automationId)}/test-link${tail}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
        const { message, code } = await errorBody(res);
        const err: FormTestLinkError = new Error(message || `${method} test link failed (${res.status})`);
        err.status = res.status;
        if (code) err.code = code;
        throw err;
    }
    return res.json() as Promise<T>;
}

export interface FormTestLinkApi {
    create: (automationId: string) => Promise<{ testLink: FormTestLink }>;
    revoke: (automationId: string) => Promise<{ revoked: boolean }>;
    setAudience: (automationId: string, body: AudienceWrite) => Promise<{ testLink: FormTestLink }>;
}

export const formTestLinkApi: FormTestLinkApi = {
    /** POST: a fresh link, the maker's alone; the one it replaces stops working at once. */
    create: (automationId) => send('POST', automationId),
    /** DELETE: the link stops working now. */
    revoke: (automationId) => send('DELETE', automationId),
    /** PUT .../audience: who may open it. */
    setAudience: (automationId, body) => send('PUT', automationId, '/audience', body),
};

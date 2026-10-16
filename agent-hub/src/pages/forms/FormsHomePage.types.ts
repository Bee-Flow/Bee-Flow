/** One row of GET /api/automation/forms: a published form of the organisation. */
export interface OrgFormRow {
    id: string;
    url: string;
    automationId: string;
    triggerStepId: string | null;
    title: string;
    description: string | null;
    live: boolean;
    /** The visitor gate's verdict for this person; a row without the flag is let through. */
    canOpen?: boolean;
    submissions: number;
    lastSeenAt: string | null;
    createdAt: string;
    mine: boolean;
}

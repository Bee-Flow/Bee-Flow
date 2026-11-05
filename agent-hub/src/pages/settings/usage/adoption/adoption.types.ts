/**
 * The wire shapes of GET /api/usage/adoption/* (the contract the server's
 * routes/usageAdoption.js answers with). `calls` is optional everywhere: a
 * cloud caller who is not the platform operator gets marked-up cost and no
 * call or token counts, so every call count renders only when present.
 */

interface AdoptionRange {
    startDate: string;
    endDate: string;
    days: number | null;
    /** True when the period came from `days`: then seen/dormant are read from last sign-in. */
    relative: boolean;
}

export interface AdoptionSummary {
    range: AdoptionRange;
    members: {
        total: number;
        aiActive: number;
        seenOnly: number | null;
        dormant: number | null;
        never: number | null;
        newInPeriod: number;
        seats: { used: number; max: number | null };
    };
    makers: { total: number; newInPeriod: number };
    spend: { cost: number; calls?: number; people: number; perActiveMember: number };
    /** 0..100 = aiActive / total. */
    adoptionRate: number;
    prev: { aiActive: number; adoptionRate: number; cost: number; calls?: number } | null;
    partial: boolean;
}

export interface AdoptionAreaSource { source: string; calls?: number; cost: number }

export interface AdoptionArea {
    area: string;
    kind: string | null;
    calls?: number;
    cost: number;
    people: number;
    objects: number;
    sources: AdoptionAreaSource[];
}

interface AdoptionWeek {
    /** ISO week, `2026-W41`. */
    week: string;
    start: string;
    end: string;
    complete: boolean;
    total: number;
    byArea: Record<string, number>;
}

export interface AdoptionAreas {
    areas: AdoptionArea[];
    timeline: { weeks: AdoptionWeek[] };
    partial: boolean;
}

export type UsageLabel =
    | 'conversations' | 'runs' | 'submissions' | 'action_runs' | 'activations'
    | 'public_views' | 'recordings' | 'activities' | 'cowork_runs';

export interface AdoptionKind {
    kind: string;
    total: number;
    published: number;
    makers: number;
    newInPeriod: number;
    /** null: nothing records use of this kind yet ("no signal"). */
    usage: { events: number; people: number; label: UsageLabel } | null;
    cost: number | null;
    trend: number[];
    deltaPct: number | null;
}

export interface AdoptionStudio { kinds: AdoptionKind[]; partial: boolean }

export type Audience = 'org' | 'group' | 'private' | 'public';

export interface AdoptionItem {
    id: string;
    name: string;
    ownerId: string;
    ownerName: string;
    audience: Audience;
    createdAt: string;
    lastUsedAt: string | null;
    people: number | null;
    uses: number | null;
    cost: number | null;
}

export interface AdoptionStudioItems {
    kind: string;
    items: AdoptionItem[];
    /** Always pseudonymous, at most five. */
    topPeople: Array<{ person: string; uses: number; cost: number }>;
    unused: Array<{ id: string; name: string; ownerName: string; publishedAt: string; lastUsedAt: string | null }>;
    total: number;
}

interface AdoptionGroupRow {
    id: string;
    name: string;
    source: 'entra' | 'nextcloud' | 'local';
    members: number;
    aiActive: number;
    adoptionRate: number;
    makers: number;
    cost: number;
    topArea: string | null;
}

/** The small groups merged into one row; the figures are null when the merged set is itself under five people. */
interface AdoptionFoldedGroups {
    count: number;
    members: number;
    aiActive: number | null;
    adoptionRate: number | null;
    makers: number | null;
    cost: number | null;
    topArea: string | null;
}

export interface AdoptionGroups {
    groups: AdoptionGroupRow[];
    /** The groups with fewer than five members, merged into one row. */
    folded: AdoptionFoldedGroups | null;
    partial: boolean;
}

export type PersonStatus = 'ai_active' | 'seen_only' | 'dormant' | 'never' | 'unknown';

export interface AdoptionPerson {
    /** The pseudonym unless the answer is revealed. */
    id: string;
    /** `Member · K7Q2` unless the answer is revealed. */
    name: string;
    avatarType: string | null;
    avatar: string | null;
    role: string;
    groups: string[];
    lastSeenAt: string | null;
    status: PersonStatus;
    calls?: number;
    cost: number;
    areas: string[];
    built: Record<string, number>;
    firstAiUseAt: string | null;
}

export interface AdoptionPeoplePage {
    reveal: boolean;
    auditRecorded: boolean;
    people: AdoptionPerson[];
    total: number;
    nextCursor: number | null;
}

/** The view of the people list the table renders: every loaded page merged. */
export interface AdoptionPeopleView {
    reveal: boolean;
    auditRecorded: boolean;
    people: AdoptionPerson[];
    total: number;
}

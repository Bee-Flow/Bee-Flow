/**
 * What the /api/studio aggregates answer, as the phone reads them
 * (api/readers.ts). Their server sources are named on each shape.
 */

import type { KindKey } from '@/shared/ui';

/** GET /api/studio/counts (routes/studio/counts.js). A key you may not see is absent. */
export interface StudioCounts {
    counts: Readonly<Record<string, number>>;
    /** Distinct owners across the counted kinds; null when the server could not vouch for it. */
    makers: number | null;
}

/** One row of GET /api/studio/attention (attention.js toRow). */
export interface AttentionRow {
    /** The attention source that produced it (attentionChecks.js SOURCES). */
    source: string;
    code: string;
    severity: 'error' | 'warning' | 'info';
    kind: string | null;
    targetId: string | null;
    /** The producer's own sentence, with the object's name in it. */
    message: string;
    remediation: string | null;
    /** `/app/studio/<segment>/<id>`, or null when the producer had no id. */
    deepLink: string | null;
}

/** GET /api/studio/attention. `complete` is the only licence to say "nothing needs attention". */
export interface StudioAttention {
    rows: AttentionRow[];
    /** Everything found, before the per-source cap. */
    total: number;
    unavailable: string[];
    capped: string[];
    gated: string[];
    complete: boolean;
}

export interface StudioHit {
    id: string;
    name: string;
}

/** GET /api/studio/search?q= (routes/studio/search.js). */
export interface StudioSearch {
    query: string;
    tooShort: boolean;
    /** Per search kind (automations, datatables, apps, …); absent = not searched. */
    results: Readonly<Record<string, StudioHit[]>>;
    /** Kinds whose search failed — absent from `results`, and NOT "no match". */
    errors: string[];
}

/** A building block the plan also needs. Shown for context: nothing is made from it (the web's H4b). */
export interface DescribeItCompanion {
    kind: KindKey;
    name: string;
}

/**
 * POST /api/studio/ai/route (routes/studio/aiRoute.js): which ONE building
 * block a description is about. `kind` null is an answer too — `available`
 * and `undecided` say why (model/describeIt.ts `noKindCode`).
 */
export interface DescribeItAnswer {
    kind: KindKey | null;
    name: string;
    /** The brief for that kind's builder, in the language of the request. */
    seed: string;
    companions: DescribeItCompanion[];
    /** The kinds this person may build; null when the server did not say (unknown, not "all"). */
    available: KindKey[] | null;
    /** The kinds whose gate could not be read just now: "we could not tell", never "you may not". */
    undecided: KindKey[];
}

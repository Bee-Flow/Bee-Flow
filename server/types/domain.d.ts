// Shapes shared between a store, its callers and their tests, kept out of the .js files so a typed
// signature does not push a file past its size ceiling (scripts/file-budget.mjs). Types only.

declare namespace Subscriptions {
    /** A subscription's limits with the plan's filling the gaps (stores/user/subscriptions.js getEffectiveLimits). */
    interface EffectiveLimits {
        status: string;
        billing_cycle_start: string | Date | null;
        max_messages_per_month?: number | null;
        max_tokens_per_month?: number | null;
        max_cost_per_month?: number | null;
        max_users?: number | null;
        max_agents?: number | null;
        max_knowledge_sources?: number | null;
        seat_count?: number;
        per_seat?: boolean;
        max_messages_per_seat?: number;
        max_messages_by_type?: Record<string, number> | null;
        allowed_features?: string[];
        allowed_models?: string[];
        /** null: unrestricted; absent when no plan governs. */
        allowed_beta_features?: string[] | null;
    }
}

declare namespace Support {
    /** What a caller may hand the support AI responder as its per-run config (services/supportAiResponder.js). */
    interface ResponderConfig {
        agentId?: string | null;
        kbIds?: string[];
        replyMode?: string;
        autoresolveThreshold?: number | string;
        v2Enabled?: boolean;
        toolsEnabled?: boolean;
        enabledToolIds?: string[];
        operatorUserId?: string | null;
        operatorOrgId?: string | null;
        orgId?: string | null;
    }
    interface ResponderOptions {
        aiUserId?: string;
        config?: ResponderConfig;
        resolveConfig?: (thread: object) => Promise<ResponderConfig | null | undefined>;
    }
}

declare namespace Inference {
    /** The JSON Schema subset asked for from a schemaless AI step (core/automationRunner/aiOutputInference.js). */
    interface Schema {
        type: string;
        items?: Schema;
        properties?: Record<string, Schema>;
    }
    /** What the answer reads from a step output so far: a tree of fields. */
    interface ReadNode {
        list?: boolean;
        weakList?: boolean;
        whole?: boolean;
        items?: ReadNode | null;
        props: Map<string, ReadNode>;
    }
}

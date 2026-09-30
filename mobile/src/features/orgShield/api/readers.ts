/**
 * Contract readers for the org Privacy Shield and its activity endpoints.
 * Every numeric aggregate goes through `field.num`, which accepts the strings
 * node-postgres returns for COUNT(*) and SUM().
 */

import { field, nullable, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type { DestinationRow } from '../model/activity';
import type { EgressRow, GuardEvent, GuardOverview, IntegrationOverview } from '../model/activityTypes';
import type { GuardStatus, ShieldDoc, ShieldEnv, ShieldSaveResult, StalenessWarning } from '../model/types';

const readStaleness = shapeListOf({
    collectionId: field.str(''),
    ruleId: field.optStr,
    reason: field.str(''),
});

const readDocMeta = shapeOf({
    clamped_fields: field.strArray,
    clamped_tier: field.strOrNull,
    stalenessWarnings: field.raw,
    updatedAt: field.strOrNull,
    updatedBy: field.strOrNull,
});

/** The document, kept whole: the PUT rebuilds the row, so unknown keys must travel back. */
export function readShieldDoc(raw: unknown): ShieldDoc | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const meta = readDocMeta(raw);
    const stalenessWarnings: StalenessWarning[] = readStaleness(meta.stalenessWarnings);
    return {
        raw: { ...(raw as Record<string, unknown>) },
        clampedFields: meta.clamped_fields,
        clampedTier: meta.clamped_tier,
        stalenessWarnings,
        updatedAt: meta.updatedAt,
        updatedBy: meta.updatedBy,
    };
}

const readTermErrors = shapeListOf({
    id: field.strOrNull,
    label: field.str(''),
    error: field.str(''),
});

export function readSaveResult(raw: unknown): ShieldSaveResult {
    const config = field.recordOrNull(pick(raw, 'config'));
    return {
        config,
        termErrors: readTermErrors(pick(raw, 'termErrors')),
        clampedFields: field.strArray(pick(raw, 'clamped_fields')),
        clampedTier: field.strOrNull(pick(raw, 'clamped_tier')),
    };
}

/** `configured !== false` / `reachable !== false`, as the web reads it. */
export const readGuardStatus: (raw: unknown) => GuardStatus | null = nullable(
    shapeOf({ configured: field.bool(true), reachable: field.bool(true) }),
);

/** `/ai/config` → is a web search provider set? */
export function readWebSearchEnabled(raw: unknown): boolean {
    const provider = field.strOrNull(pick(raw, 'searchProvider'));
    return Boolean(provider && provider !== 'disabled');
}

/** `/ai/config/chat-models-eu` → a tier map; any tier with a model id means EU models exist. */
export function readEuModelsConfigured(raw: unknown): boolean {
    const tiers = field.recordOrNull(raw);
    if (!tiers) return false;
    return Object.values(tiers).some((tier) => {
        const id = field.strOrNull(pick(tier, 'modelId'));
        return Boolean(id && id.trim());
    });
}

export function readShieldEnv(config: unknown, euTiers: unknown): ShieldEnv {
    return { hasWebSearchEnabled: readWebSearchEnabled(config), hasEuModelsConfigured: readEuModelsConfigured(euTiers) };
}

// ── Activity ──────────────────────────────────────────────────────────

const readCategoryCounts = shapeListOf({ category: field.str(''), count: field.num(0) });

const readTopUsers = shapeListOf({ user_id: field.str(''), display_name: field.str(''), total: field.num(0) });

export function readGuardOverview(raw: unknown): GuardOverview {
    const summary = shapeOf({
        total_events: field.num(0),
        pii_count: field.num(0),
        dlp_blocked: field.num(0),
        unique_users: field.num(0),
    })(pick(raw, 'summary'));
    return {
        totalEvents: summary.total_events,
        piiCount: summary.pii_count,
        dlpBlocked: summary.dlp_blocked,
        uniqueUsers: summary.unique_users,
        topCategories: readCategoryCounts(pick(raw, 'top_categories')),
        topUsers: readTopUsers(pick(raw, 'top_users')).map((u) => ({
            userId: u.user_id,
            name: u.display_name || u.user_id,
            total: u.total,
        })),
        lastEventAt: field.strOrNull(pick(pick(raw, 'health'), 'last_event_at')),
    };
}

const readDestinations: (raw: unknown) => DestinationRow[] = shapeListOf({
    country_code: field.strOrNull,
    country_name: field.strOrNull,
    is_eu: field.bool(false),
    is_local: field.bool(false),
    total: field.num(0),
    pii_events: field.num(0),
});

export function readIntegrationOverview(raw: unknown): IntegrationOverview {
    const summary = shapeOf({
        total_calls: field.num(0),
        non_eu_count: field.num(0),
        pii_non_eu_count: field.num(0),
        blocked_count: field.num(0),
        sovereignty_score: field.numOrNull,
        score_delta: field.numOrNull,
    })(pick(raw, 'summary'));
    return {
        totalCalls: summary.total_calls,
        nonEuCount: summary.non_eu_count,
        piiNonEuCount: summary.pii_non_eu_count,
        blockedCount: summary.blocked_count,
        sovereigntyScore: summary.sovereignty_score,
        scoreDelta: summary.score_delta,
        // Every destination host (the web's map), folded per country on screen;
        // an older server sends only its top ten, under `top`.
        destinations: readDestinations(pick(pick(raw, 'map'), 'destinations') ?? pick(pick(raw, 'top'), 'destinations')),
        piiCategories: readCategoryCounts(pick(raw, 'pii_categories')),
    };
}

const readEventRows = shapeListOf({
    id: field.num(0),
    timestamp: field.str(''),
    violation_type: field.str(''),
    violation_categories: field.str(''),
    action_taken: field.strOrNull,
    display_name: field.str(''),
    user_id: field.str(''),
    source: field.strOrNull,
    agent_name: field.strOrNull,
    agent_id: field.strOrNull,
    automation_id: field.strOrNull,
});

export function readGuardEvents(raw: unknown): GuardEvent[] {
    return readEventRows(raw).map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        violationType: r.violation_type,
        categories: r.violation_categories,
        action: r.action_taken,
        userName: r.display_name || r.user_id,
        source: r.source,
        agentName: r.agent_name,
        agentId: r.agent_id,
        automationId: r.automation_id,
    }));
}

const readEgressRows = shapeListOf({
    id: field.num(0),
    timestamp: field.str(''),
    integration_type: field.str(''),
    tool_name: field.str(''),
    dest_host: field.strOrNull,
    server_endpoint: field.strOrNull,
    country_name: field.strOrNull,
    is_eu: field.bool(false),
    is_local: field.bool(false),
    pii_categories_detected: field.str(''),
    status: field.strOrNull,
    display_name: field.str(''),
    user_id: field.str(''),
});

export function readEgress(raw: unknown): EgressRow[] {
    return readEgressRows(raw).map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        integration: r.integration_type || r.tool_name,
        destination: r.dest_host || r.server_endpoint || '—',
        countryName: r.country_name,
        isEu: r.is_eu,
        isLocal: r.is_local,
        piiCategories: r.pii_categories_detected,
        status: r.status,
        userName: r.display_name || r.user_id,
    }));
}

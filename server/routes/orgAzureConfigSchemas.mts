/**
 * What the routes of routes/orgAzureConfig.js accept.
 *
 *   PUT /:orgId                        ConfigBody, one `section` per save
 *   PUT /:orgId/sync-groups/settings   SyncSettingsBody
 *   POST /:orgId/sync-groups           NoBody
 *
 * The save is one PUT with a `section`, and every section writes GLOBAL keys.
 * It read the body key by key, so a mistake was never refused:
 *
 *   - an unknown `section` ('SSO', 'opnai') matched no branch and answered
 *     `{ ok: true }` — "Saved" in the panel, nothing written. So did a key
 *     sent under the wrong section, or misspelled;
 *   - `!!x` read the STRING "false" as true: `useAzureDocProcessing: "false"`
 *     switched document processing ON (documents start going to Azure),
 *     `autoApproveSSO: "false"` auto-approved every Microsoft sign-in into the
 *     organisation, `piiDetectionEnabled: "false"` switched PII detection on;
 *   - `chatModelTiers` was rebuilt from four tier names, so a save DROPPED the
 *     `standard` and `swarm` tiers the admin dashboard keeps in the same key —
 *     and every agent on `tier:standard` fell back to the fast model. A tier
 *     map with a misspelled name reset the four to empty. Tiers not sent are
 *     now kept, and a tier name nothing reads is refused;
 *   - on the sync settings, `destructiveSync: "false"` switched DESTRUCTIVE
 *     sync on — group memberships removed on the next run — and an interval
 *     outside 1..168 hours was silently not saved.
 *
 * Inside a tier the object stays OPEN (modelId, label, maxTokens, temperature,
 * reasoning knobs): it is the model-tier config the admin dashboard owns too.
 * An empty or absent secret keeps the stored one, as the screens rely on.
 */

import { createRequire } from 'node:module';
import type { ZodRawShape } from 'zod';
import type { $ZodRawIssue } from 'zod/v4/core';

const nodeRequire = createRequire(import.meta.url);
const { z, typeError } = nodeRequire('../utils/zod.js') as typeof import('../utils/zod.js');
const { worded, choice } = nodeRequire('../core/http/schemaParts.js') as typeof import('../core/http/schemaParts.js');

/** A body that also accepts no body: Express 5 leaves `req.body` undefined then. */
const bodyOf = <S extends ZodRawShape>(shape: S) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { error: typeError({ invalid: 'Send the settings as a JSON object.' }) }).strict(),
);

const flag = (name: string) => z.boolean({ error: typeError({ invalid: `${name} is true or false.` }) }).optional();
const text = (name: string) => worded(`${name} is text.`).trim().optional();

/** An address the SDK can call, or '' to clear it. */
const endpoint = (name: string) => {
    const message = `${name} is an https:// address, or empty to clear it.`;
    return worded(message).trim().refine((v: string) => v === '' || /^https?:\/\/\S+$/i.test(v), message).optional();
};

const TIER_NAMES = ['fast', 'standard', 'swarm', 'thinking', 'writer', 'pro',
    // A hand-written legacy alias that still wins where someone set it
    // (core/meetingNotes/summaryHelpers.js), so it has to survive a save.
    'smart'];
const TIER_TEXT = 'A tier is an object: { modelId, … }.';
const Tier = z.object({
    modelId: z.string({ error: typeError({ invalid: 'A tier\'s modelId is text.' }) }).optional(),
    label: z.string({ error: typeError({ invalid: 'A tier\'s label is text.' }) }).optional(),
}, { error: typeError({ invalid: TIER_TEXT }) }).passthrough();
const TIERS_TEXT = `chatModelTiers is a map of tiers: ${TIER_NAMES.join(', ')}.`;
const TierMap = z.object(Object.fromEntries(TIER_NAMES.map((n) => [n, Tier.optional()])),
    { error: typeError({ required: TIERS_TEXT, invalid: TIERS_TEXT }) }).strict();
/** The four the Azure panel shows, as a save always wrote them when absent. */
export const PANEL_TIERS: Record<string, string> = { fast: 'Fast', thinking: 'Thinking', writer: 'Writer', pro: 'Deep Thinking' };

const PII_ACTIONS: [string, ...string[]] = ['block', 'tokenize', 'warn'];
const TENANT_ALIASES = ['common', 'organizations', 'consumers'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_TEXT = 'ssoTenantId is your directory (tenant) GUID, or one of common, organizations, consumers.';
const THRESHOLD_TEXT = 'piiDetectionConfidenceThreshold is a number from 0 to 1.';
const CATEGORY_TEXT = 'piiDetectionCategories is a list of categories, or null for all of them.';

const section = <N extends string, S extends ZodRawShape>(name: N, shape: S) =>
    z.object({ section: z.literal(name), ...shape }).strict();

const SECTION_TEXT = 'section is one of openai, chatModels, piiDetection, docProcessing or sso.';
export const ConfigBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.discriminatedUnion('section', [
        section('openai', {
            azureEndpoint: endpoint('azureEndpoint'),
            azureApiKey: text('azureApiKey'),
            // Accepted and ignored: Azure runs on the v1 GA API, which has no
            // api-version, and installed apps older than that still send it.
            azureApiVersion: text('azureApiVersion'),
            azureModels: text('azureModels'),
        }),
        section('chatModels', { chatModelTiers: TierMap }),
        section('piiDetection', {
            piiDetectionEnabled: flag('piiDetectionEnabled'),
            piiDetectionCategories: z.array(worded(CATEGORY_TEXT).trim().min(1, CATEGORY_TEXT),
                { error: typeError({ invalid: CATEGORY_TEXT }) }).nullable().optional(),
            piiDetectionConfidenceThreshold: z.number({ error: typeError({ invalid: THRESHOLD_TEXT }) })
                .min(0, THRESHOLD_TEXT).max(1, THRESHOLD_TEXT).optional(),
            piiDetectionScope: z.object({
                userInput: flag('piiDetectionScope.userInput'),
                agentOutput: flag('piiDetectionScope.agentOutput'),
            }, { error: typeError({ invalid: 'piiDetectionScope is { userInput, agentOutput }, each true or false.' }) })
                .strict().optional(),
            piiDetectionAction: choice(PII_ACTIONS, `piiDetectionAction is one of ${PII_ACTIONS.join(', ')}.`).optional(),
        }),
        section('docProcessing', {
            useAzureDocProcessing: flag('useAzureDocProcessing'),
            azureDocIntelligenceEndpoint: endpoint('azureDocIntelligenceEndpoint'),
            azureDocIntelligenceKey: text('azureDocIntelligenceKey'),
            azureOpenaiEmbeddingEndpoint: endpoint('azureOpenaiEmbeddingEndpoint'),
            azureOpenaiEmbeddingKey: text('azureOpenaiEmbeddingKey'),
            azureOpenaiEmbeddingModel: text('azureOpenaiEmbeddingModel'),
        }),
        section('sso', {
            ssoClientId: text('ssoClientId'),
            ssoClientSecret: text('ssoClientSecret'),
            ssoTenantId: worded(TENANT_TEXT).trim()
                .refine((v: string) => v === '' || TENANT_ALIASES.includes(v.toLowerCase()) || GUID.test(v), TENANT_TEXT)
                .optional(),
            autoApproveSSO: flag('autoApproveSSO'),
        }),
    ], {
        error: (iss: $ZodRawIssue) => {
            if (iss.code === 'invalid_union' && iss.note === 'No matching discriminator') return SECTION_TEXT;
            return iss.code === 'invalid_type' ? 'Send the settings as a JSON object.' : undefined;
        },
    }),
);

const INTERVAL_TEXT = 'syncIntervalHours is a whole number of hours from 1 to 168.';
export const SyncSettingsBody = bodyOf({
    destructiveSync: flag('destructiveSync'),
    autoActivateUsers: flag('autoActivateUsers'),
    periodicSync: flag('periodicSync'),
    syncIntervalHours: z.number({ error: typeError({ invalid: INTERVAL_TEXT }) })
        .int(INTERVAL_TEXT).min(1, INTERVAL_TEXT).max(168, INTERVAL_TEXT).optional(),
});

/** A sync run takes no options — a `dryRun` it ignored would still run for real. */
export const NoBody = bodyOf({});

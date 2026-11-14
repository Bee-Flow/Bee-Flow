/**
 * What the tier-set routes of routes/ai/config/modelTiers.js accept.
 *
 *   POST /config/chat-models, /config/chat-models-eu   { fast?, standard?, swarm?, thinking?, writer?, pro?, smart? }
 *   POST /config/custom-chat-models                    { tiers }
 *   POST /config/org-custom-chat-models                { tiers, orgId? }
 *
 * A standard tier stays an open document (`modelId`, `label`, `maxTokens`,
 * `reasoningEffort`, … as the admin screen keeps them): the routes store it as
 * sent. A custom tier stays open too: normalizeCustomTier is its allow-list and
 * drops what it does not read. Only the envelope is closed, so a misspelled
 * tier name is refused by name instead of being saved as an empty tier.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { z, typeError } = nodeRequire('../../../utils/zod.js') as typeof import('../../../utils/zod.js');
const { bodyOf, worded } = nodeRequire('../../../core/http/schemaParts.js') as typeof import('../../../core/http/schemaParts.js');

const TIER_TEXT = 'A tier is an object: { modelId, label, … }, or null for the default.';
const Tier = z.object({
    modelId: z.string({ error: typeError({ invalid: 'A tier\'s modelId is text.' }) }).optional(),
}, { error: typeError({ invalid: TIER_TEXT }) }).passthrough().nullish();

const STANDARD_TIERS = ['fast', 'standard', 'swarm', 'thinking', 'writer', 'pro'] as const;

/**
 * The six standard tiers. `smart` is a legacy alias some installations still
 * store (routes/orgAzureConfig.js keeps it); the screen reads the stored set and
 * sends it back whole, so it is taken here and, as before, not saved.
 * @param {string} subject
 */
export const tierSetBody = (subject: string) => bodyOf({
    ...Object.fromEntries(STANDARD_TIERS.map((name) => [name, Tier])) as Record<typeof STANDARD_TIERS[number], typeof Tier>,
    smart: z.unknown().optional(),
}, subject);

const TIERS_TEXT = 'tiers is a list of custom tiers.';
const tiers = z.array(z.unknown(), { error: typeError({ required: TIERS_TEXT, invalid: TIERS_TEXT }) });

export const CustomTiersBody = bodyOf({ tiers }, 'Saving the custom tiers');

const ORG_TEXT = 'orgId is the id of an organisation.';
export const OrgCustomTiersBody = bodyOf({
    tiers,
    orgId: worded(ORG_TEXT).max(200, ORG_TEXT).optional(),
}, 'Saving the organisation\'s custom tiers');

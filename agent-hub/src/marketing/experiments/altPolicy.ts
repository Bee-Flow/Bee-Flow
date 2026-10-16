/**
 * What an A/B alternative may not change (privacy).
 *
 * The server validates and records a form submission against the PUBLISHED
 * block's own content (consent wording, fields, automation), never against
 * what a variant-B visitor saw. An alternative that swapped the consent text
 * or the fields would make the recorded consent differ from what was shown.
 * So these keys never come from `abAlt`, and blocks that take submissions run
 * no experiment at all. Mirrored by server/cmsBuilder/experiments.js (warning).
 */

/** Keys no alternative may override, on any block type. */
const ALT_DENY_ALL = ['consent', 'automationId'] as const;

/** Extra keys per block type. */
const ALT_DENY_BY_TYPE: Record<string, readonly string[]> = {
    form: ['fields'],
    'customer-support': ['fields'],
};

/** Block types that take submissions: no experiment, whatever the content says. */
const NO_EXPERIMENT_TYPES: readonly string[] = ['form', 'customer-support'];

export const supportsExperiment = (type?: string): boolean => !type || !NO_EXPERIMENT_TYPES.includes(type);

/** The alternative without the keys it may not change. */
export function sanitizeAlternative(alt: Record<string, unknown>, type?: string): Record<string, unknown> {
    const denied = new Set<string>([...ALT_DENY_ALL, ...((type && ALT_DENY_BY_TYPE[type]) || [])]);
    return Object.fromEntries(Object.entries(alt).filter(([k]) => !denied.has(k)));
}

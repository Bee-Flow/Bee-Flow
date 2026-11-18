/**
 * Sanctions lists as tools (integration `sanctions-lists`, licence feature `sanctions_screening`).
 *
 *   sanctions_screen              screen a person's or organisation's name, optionally with a
 *                                 birth date, a country and a job title / function, against
 *                                 the stored EU, UN, Dutch, OFAC and UK lists
 *   sanctions_pep_function_check  is a job title a prominent public function (PEP) on the Dutch
 *                                 or EU list?
 *
 * Read-only and LOCAL: the screening runs on this server against the imported public lists
 * (core/sanctions/service.mts); core/integrations/integrationToolMap.js marks the `sanctions_`
 * family isLocal, so the egress ledger and the outside-tools PII rules do not count a screening
 * as data leaving the platform. Offered to automation steps (automation/toolRegistry.js) and to
 * agents that have the integration on; getIntegrationTools only offers them when the
 * organisation switched the integration on and holds the licence. The executor checks the
 * licence again, because a stored automation step can outlive a licence.
 */

import { createRequire } from 'node:module';
import { LIST_IDS } from '../core/sanctions/sources.mts';

const nodeRequire = createRequire(import.meta.url);

type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type Service = typeof import('../core/sanctions/service.mts');
type Pep = typeof import('../core/sanctions/pepFunctions.mts');

const service = (): Service => nodeRequire('../core/sanctions/service.mts') as Service;
const pep = (): Pep => nodeRequire('../core/sanctions/pepFunctions.mts') as Pep;

export const SANCTIONS_TOOLS: ToolDef[] = [
    {
        type: 'function',
        function: {
            name: 'sanctions_screen',
            description: 'Screen the name of a person or organisation against the official sanctions lists (EU consolidated financial sanctions, UN Security Council, Dutch national terrorism list, OFAC SDN, UK Sanctions List). '
                + 'Runs on this server; nothing is sent outside it. Returns candidates with a score from 0 to 1, the list, the matched name, birth dates, countries and the list\'s own reference and link. '
                + 'A candidate is a possible match for a person to check, not a finding. Give a birth date and a country when you have them: they lower the score of namesakes. '
                + 'Read `complete`: false means a requested list is missing, failed to refresh or is out of date (`warnings` says which), so no candidate is not a clean result. When no requested list holds data the call fails with code lists_unavailable. '
                + 'Give `function` (a job title) to also check whether it is a prominent public function (PEP).',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The full name of the person or organisation.' },
                    birthDate: { type: 'string', description: 'Birth date as YYYY-MM-DD, DD-MM-YYYY or a year (optional).' },
                    country: { type: 'string', description: 'Nationality or country, as an ISO code (NL) or English name (optional).' },
                    function: { type: 'string', description: 'Job title or function, checked against the Dutch and EU lists of prominent public functions (optional).' },
                    lists: { type: 'array', items: { type: 'string', enum: [...LIST_IDS] }, description: 'Only these lists (default: all).' },
                    minScore: { type: 'number', description: 'Lowest score returned, 0.5 to 1 (default 0.85).' },
                    maxResults: { type: 'integer', description: 'At most this many candidates, 1 to 50 (default 10).' },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sanctions_pep_function_check',
            description: 'Check whether a job title or function is a prominent public function (politically exposed person, PEP) on the official Dutch list (Uitvoeringsbesluit Wwft 2018, article 2) or the EU list. '
                + 'Checks the function only, never a person. Returns isPep, possiblePep (a function whose organisation keeps its own list), former (the title says former) and every matching entry with its list and category.',
            parameters: {
                type: 'object',
                properties: {
                    function: { type: 'string', description: 'The job title or function, e.g. "Lid van de Tweede Kamer" or "Ambassador".' },
                },
                required: ['function'],
            },
        },
    },
];

const NAMES = new Set(SANCTIONS_TOOLS.map((t) => t.function.name));

export function isSanctionsTool(name: string): boolean {
    return NAMES.has(name);
}

type Args = Record<string, unknown>;

export async function executeSanctionsTool(name: string, args: Args, ctx: { userId?: string | null; orgId?: string | null } = {}): Promise<unknown> {
    const allowed = await service().access({ userId: ctx.userId ?? null, orgId: ctx.orgId ?? null });
    if (!allowed.ok) return { error: allowed.error, code: allowed.code };
    const a = args && typeof args === 'object' ? args : {};
    if (name === 'sanctions_screen') {
        if (typeof a.name !== 'string' || !a.name.trim()) return { error: 'name is required: the full name to screen.' };
        try {
            return await service().screen(a);
        } catch (e) {
            if (e instanceof service().ListsUnavailableError) return { error: e.message, code: e.code };
            throw e;
        }
    }
    if (name === 'sanctions_pep_function_check') {
        if (typeof a.function !== 'string' || !a.function.trim()) return { error: 'function is required: the job title to check.' };
        return pep().checkPepFunction(a.function);
    }
    throw new Error(`Unknown sanctions tool: ${name}`);
}

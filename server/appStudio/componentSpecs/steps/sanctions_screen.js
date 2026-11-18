// @typecheck strict
/**
 * Step kind `sanctions_screen`: screen a name against the imported official sanctions lists (EU,
 * UN, Dutch national terrorism list, OFAC SDN, UK Sanctions List), and optionally check a job
 * title against the Dutch and EU lists of prominent public functions (PEP). Executor:
 * actionExecutor/steps/sanctions_screen.mts, which calls core/sanctions/service.mts (the same
 * screening the automation tool `sanctions_screen` runs).
 *
 * Runs on this server against the stored public lists: nothing about the person leaves it, so
 * the step runs in a mailbox hook and an unattended run too. Not on an anonymous public page:
 * the screening is a paid feature of the owner's organisation (licence `sanctions_screening`,
 * plus the `sanctions-lists` integration switched on by an organisation admin).
 */

'use strict';

/** The list ids a step may narrow to (core/sanctions/sources.mts LIST_IDS). */
const LIST_IDS = ['eu_fsf', 'un_sc', 'nl_terrorism', 'us_ofac_sdn', 'uk_fcdo'];

module.exports = {
    kind: 'sanctions_screen',
    since: 3,
    side: 'server',
    fields: {
        name: { type: 'binding', description: 'The full name of the person or organisation to screen, e.g. { "kind": "field", "name": "fullName" }. Leave out to check only `function`.' },
        birthDate: { type: 'binding', description: 'Birth date (YYYY-MM-DD, DD-MM-YYYY or a year). Optional; lowers the score of namesakes.' },
        country: { type: 'binding', description: 'Nationality or country, an ISO code (NL) or English name. Optional.' },
        function: { type: 'binding', description: 'A job title or function, checked against the Dutch and EU lists of prominent public functions (PEP). Optional.' },
        lists: { type: 'stringList', description: `Only these lists: ${LIST_IDS.join(', ')}. Empty: all of them.` },
        minScore: { type: 'number', min: 0.5, max: 1, description: 'The lowest score a candidate needs, 0.5 to 1 (default 0.85).' },
        maxResults: { type: 'int', min: 1, max: 50, description: 'At most this many candidates (default 10).' },
        resultVar: { type: 'string', maxLen: 60, description: 'The variable that gets the result: { candidates, candidateCount, complete, warnings, pep, lists, missingLists, checkedAt }.' },
    },
    childSlots: [],
    // A read of the stored lists: running it again changes nothing.
    retrySafe: true,
    budget: 'light',
    handler: 'file',
    policy: { click: 'step', background: 'run', mailboxHook: 'run', unattended: 'run', mcpRun: 'run', mcpDryRun: 'run', public: 'refuse' },
    /** @param {Record<string, unknown>} s */
    summary: (s) => `sanctions_screen→${typeof s.resultVar === 'string' && s.resultVar ? s.resultVar : '?'}`,
    description: 'Screens a name against the sanctions lists and checks a PEP function. '
        + 'Give `name` (a binding to the name), and optionally `birthDate`, `country` and `function`. The screening runs on this server against the stored EU, UN, Dutch, OFAC and UK lists: nothing is sent outside it. '
        + 'The result lands in `resultVar`: vars.<resultVar>.candidates is a list of { score (0..1), listId, entityId, matchedName, primaryName, birthDates, countries, programmes, reference, url, reasons }, best first; candidateCount is their number; '
        + 'vars.<resultVar>.pep is { isPep, possiblePep, former, matches } when `function` was given; missingLists names lists that hold no data yet. '
        + 'vars.<resultVar>.complete is false when a requested list is missing, failed to refresh or is out of date (vars.<resultVar>.warnings says which): then no candidate is not a clean result, so route complete = false to a review too. When no requested list holds data the step fails with error.code "lists_unavailable". '
        + 'A candidate is a possible match for a person to review, never a finding: store the result and route a non-zero candidateCount to a review step. '
        + 'Needs the Sanctions lists integration switched on for the organisation and the licence; otherwise it fails with error.code "feature_locked" or "integration_off". Not on a public page. '
        + 'Example: { "kind": "sanctions_screen", "name": { "kind": "field", "name": "clientName" }, "birthDate": { "kind": "field", "name": "birthDate" }, "function": { "kind": "field", "name": "jobTitle" }, "resultVar": "screening" }.',
};

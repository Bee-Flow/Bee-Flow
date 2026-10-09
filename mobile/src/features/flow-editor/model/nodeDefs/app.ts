/**
 * The app family: reaching outside the automation — a connected app, a web
 * service, your own code, a reusable Step.
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `automations.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const APP_DEFS: Record<string, NodeDefSource> = {
    integration_action: {
        family: 'app',
        typeLabel: 'Action',
        defaultLabel: 'Integration',
        help: 'Does one thing in a connected app — send the email, create the file, update the row.',
        sectionKeys: ['basics', 'inputs', 'advanced'],
        simpleSections: ['basics', 'inputs'],
        issueSections: {
            fallback: 'basics',
            map: { label: FLAT, tool: 'basics', operation: 'basics', inputs: 'inputs', forEach: 'advanced' },
        },
    },
    http_request: {
        family: 'app',
        typeLabel: 'Web service call',
        defaultLabel: 'Call a web service',
        desc: 'Send a request to a system that has no ready-made action here',
        help: 'Sends a request straight to another system’s web address and passes on what it sends back. For systems with no ready-made action in the Action list. If you let it reuse an answer, a retry after a later failure uses the answer it already has instead of asking again — and a test run neither reuses one nor keeps one.',
        sectionKeys: ['request', 'query', 'auth', 'headers', 'body', 'options', 'advanced'],
        simpleSections: ['request', 'query', 'auth', 'body'],
        issueSections: {
            fallback: 'request',
            map: {
                label: FLAT,
                url: 'request',
                method: 'request',
                headers: 'headers',
                body: 'body',
                query: 'query',
                timeoutMs: 'options',
                blockPrivateTargets: 'options',
                auth: 'auth',
                forEach: 'advanced',
                askOnce: 'advanced',
            },
        },
        labelFallback: 'Call a web service',
    },
    code: {
        family: 'app',
        typeLabel: 'Code',
        defaultLabel: 'Code',
        desc: 'Run custom JavaScript',
        help: 'Runs a snippet of JavaScript in a sandbox and passes on whatever it returns.',
        sectionKeys: ['code', 'advanced'],
        simpleSections: ['code'],
        issueSections: { fallback: 'code', map: { label: FLAT, code: 'code', language: 'code', forEach: 'advanced' } },
        labelFallback: 'Code',
    },
    call_block: {
        family: 'app',
        typeLabel: 'Step',
        defaultLabel: 'Step',
        help: 'Runs a reusable Step from your library, then carries on with what it returns.',
        sectionKeys: ['step', 'inputs', 'returns'],
        simpleSections: ['step', 'inputs', 'returns'],
        issueSections: { fallback: 'inputs', map: { label: FLAT, blockId: 'step', inputs: 'inputs' } },
    },
};

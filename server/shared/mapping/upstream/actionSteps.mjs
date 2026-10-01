/**
 * Steps that DO one thing and hand back a flat result object: the integration
 * call, the HTTP request, code, a notification, and the three privacy steps
 * (check / hide / restore personal data).
 *
 * Every describer here mirrors its exec's real return shape in
 * server/core/automationRunner/: a field this file invents is a binding that
 * resolves to undefined at run time, which is how several of them were found.
 */
import { groupLabel } from './env.mjs';
import { fieldAt, stepBase, stepGroup } from './sampleFields.mjs';

/**
 * An integration's output is the catalog's curated sample. A sample that is
 * not an object (a markdown string, a top-level list) has no named fields,
 * so the whole output is offered as one field rather than nothing.
 */
export function describeIntegration(node, meta) {
    const sample = meta?.sample ?? {};
    const label = node.label || node.tool || node.id;
    if (sample !== null && typeof sample === 'object' && !Array.isArray(sample)) {
        return stepGroup(node, label, 'integration_action', sample);
    }
    return stepGroup(node, label, 'integration_action', sample, [wholeOutput(node, sample)]);
}

/** One field for a step's whole output. */
export function wholeOutput(node, sample) {
    return { ...fieldAt(stepBase(node.id), [], sample), key: 'output' };
}

// Mirrors execHttpRequest's return shape (automationRunner/execOutbound.js):
// status/ok/headers/body/truncated, regardless of method.
export function describeHttpRequest(node, env) {
    // `data` is the parsed body when the response is JSON: the field to bind a
    // list to, since `body` is a string. The run leaves it out when the body
    // is not JSON; overlayGroupWithReal marks it unconfirmed then.
    const sample = {
        status: 200, ok: true, headers: {},
        body: '<response body>',
        ...(node.parseResponse === 'never' ? {} : { data: '<parsed body>' }),
        truncated: false,
    };
    return stepGroup(node, node.label || groupLabel(env, 'http_request', 'HTTP Request'), 'http_request', sample);
}

export function describeCode(node, env) {
    return stepGroup(node, node.label || groupLabel(env, 'node.code', 'Code'), 'code', { result: '<code result>' });
}

export function describeNotification(node, env) {
    // Mirrors execNotification's real output: `{ delivered: { title, body,
    // channels } }`.
    const sample = { delivered: { title: node.title || '<title>', body: node.body || '<body>', channels: ['notification'] } };
    return stepGroup(node, node.label || groupLabel(env, 'node.notification', 'Notification'), 'notification', sample);
}

/** Mirrors execGuard's output: the branch plus what it found. */
export function describeGuard(node, env) {
    const sample = {
        branch: 'then', hasPii: true, count: 2,
        categories: { Person: 1, Email: 1 },
        groups: { Personal: 1, Contact: 1 },
        scanned: 1200,
    };
    return stepGroup(node, node.label || groupLabel(env, 'guard', 'Check for personal data'), 'guard', sample);
}

/**
 * Mirrors execTokenize's output. `text` leads because it is the whole point
 * of the step: the value every downstream node should bind to.
 */
export function describeTokenize(node, env) {
    const sample = {
        text: 'mail [person_1] at [email_1]',
        count: 2,
        categories: { Person: 1, Email: 1 },
        groups: { Personal: 1, Contact: 1 },
        vaultSize: 2,
    };
    return stepGroup(node, node.label || groupLabel(env, 'node.tokenize', 'Hide personal data'), 'tokenize', sample);
}

/** Mirrors execUntokenize's output, including what it could NOT resolve. */
export function describeUntokenize(node, env) {
    const sample = {
        text: 'mail Jan de Vries at jan@acme.nl',
        value: 'mail Jan de Vries at jan@acme.nl',
        restored: 2,
        unresolved: 0,
        vaultSize: 2,
    };
    return stepGroup(node, node.label || groupLabel(env, 'node.untokenize', 'Show real values again'), 'untokenize', sample);
}

/**
 * Steps that DO one thing and hand back a flat result object: the integration
 * call, the HTTP request, code, a notification, and the three privacy steps
 * (check / hide / restore personal data).
 *
 * Every describer here mirrors its exec's real return shape in
 * server/core/automationRunner/ — a field this file invents is a binding that
 * resolves to undefined at run time, which is how several of them were found.
 */
import { sampleToFields } from './sampleFields';

export function describeIntegration(node, meta) {
    const sample = meta?.sample || {};
    return {
        id: node.id,
        label: node.label || node.tool || node.id,
        kind: 'integration_action',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

// Mirrors execHttpRequest's actual return shape (server/core/automationRunner/
// engine.js) — status/ok/headers/body/truncated, regardless of method.
export function describeHttpRequest(node) {
    // `data` is the parsed body when the response is JSON — the field to bind a
    // list to, since `body` is a string and arrayRef/repeat_for_each both need
    // a real array. A placeholder here is enough: overlayGroupWithReal replaces
    // the whole subtree with the actual response once the step has run
    // (upstream.realOverlay.test.js pins that).
    const sample = {
        status: 200, ok: true, headers: {},
        body: '<response body>',
        ...(node.parseResponse === 'never' ? {} : { data: '<parsed body>' }),
        truncated: false,
    };
    return {
        id: node.id,
        label: node.label || 'HTTP Request',
        kind: 'http_request',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

export function describeCode(node) {
    // The code can return ANYTHING — a string, a record, a list — so the shape
    // is not known before a run. `null` is the codebase's "not seen yet" sample
    // (a switch's `value` does the same): the UI says so instead of claiming a
    // type. The real output replaces it once the step has run or is pinned
    // (realOverlay). `logs` and `httpCalls` are diagnostics next to `result`
    // (see flow/stepPayload) and are deliberately not offered as fields.
    return {
        id: node.id,
        label: node.label || 'Code',
        kind: 'code',
        basePath: `steps.${node.id}.output`,
        sample: { result: null },
        fields: [{ key: 'result', path: `steps.${node.id}.output.result`, sample: null }],
    };
}

export function describeNotification(node) {
    // Mirrors execNotification's real output — `{ delivered: { title, body,
    // channels } }`. The old `{ sent: true }` field has never existed at run
    // time (C22).
    const sample = { delivered: { title: node.title || '<title>', body: node.body || '<body>', channels: ['notification'] } };
    return {
        id: node.id,
        label: node.label || 'Notification',
        kind: 'notification',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

/** Mirrors execGuard's output — the branch plus what it found. */
export function describeGuard(node) {
    const sample = {
        branch: 'then', hasPii: true, count: 2,
        categories: { Person: 1, Email: 1 },
        groups: { Personal: 1, Contact: 1 },
        scanned: 1200,
    };
    return {
        id: node.id,
        label: node.label || 'Check for personal data',
        kind: 'guard',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

/**
 * Mirrors execTokenize's output. `text` leads because it is the whole point of
 * the step — the value every downstream node should bind to.
 */
export function describeTokenize(node) {
    const sample = {
        text: 'mail [person_1] at [email_1]',
        count: 2,
        categories: { Person: 1, Email: 1 },
        groups: { Personal: 1, Contact: 1 },
        vaultSize: 2,
    };
    return {
        id: node.id,
        label: node.label || 'Hide personal data',
        kind: 'tokenize',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

/** Mirrors execUntokenize's output, including what it could NOT resolve. */
export function describeUntokenize(node) {
    const sample = {
        text: 'mail Jan de Vries at jan@acme.nl',
        value: 'mail Jan de Vries at jan@acme.nl',
        restored: 2,
        unresolved: 0,
        vaultSize: 2,
    };
    return {
        id: node.id,
        label: node.label || 'Show real values again',
        kind: 'untokenize',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

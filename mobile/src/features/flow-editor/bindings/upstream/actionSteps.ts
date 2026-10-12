/**
 * Steps that DO one thing and hand back a flat result: the integration call,
 * HTTP, code, a notification and the three privacy steps. Every sample mirrors
 * its exec's real return shape in server/core/automationRunner/. Port of
 * agent-hub `Builder/mapping/upstream/actionSteps.js`.
 */

import { translate as t } from '@/core/i18n';
import { nodeDefaultLabel } from '@/features/flow-editor/model/nodeDefs';

import type { FlowNode, VariableGroup } from '../types';
import { outputFields } from './fieldTree';
import { stepGroup } from './sampleFields';

/** A tool whose sample IS a list (a root array) offers that list, with its columns, at the base path. */
export function describeIntegration(node: FlowNode, meta: { sample?: unknown } | null | undefined): VariableGroup {
    const sample = meta?.sample || {};
    return stepGroup(node, { label: node.label || node.tool || node.id, kind: 'integration_action' }, sample, outputFields(sample, `steps.${node.id}.output`));
}

/** execHttpRequest's shape; `data` is the parsed JSON body unless parsing is off. */
export function describeHttpRequest(node: FlowNode): VariableGroup {
    const sample = {
        status: 200, ok: true, headers: {},
        body: '<response body>',
        ...(node.parseResponse === 'never' ? {} : { data: '<parsed body>' }),
        truncated: false,
    };
    return stepGroup(node, { label: node.label || t('mobile.flow.group.http_request', 'HTTP Request'), kind: 'http_request' }, sample);
}

export function describeCode(node: FlowNode): VariableGroup {
    const base = `steps.${node.id}.output`;
    // The code can return anything, so the shape is unknown before a run:
    // `null` is "not seen yet" (the web's describeCode). `logs` and
    // `httpCalls` are diagnostics, never offered as fields.
    return stepGroup(node, { label: node.label || nodeDefaultLabel('code', t), kind: 'code' }, { result: null }, [
        { key: 'result', path: `${base}.result`, sample: null },
    ]);
}

/** execNotification's real output — `{ delivered: { title, body, channels } }`. */
export function describeNotification(node: FlowNode): VariableGroup {
    const delivered = { title: node.title || '<title>', body: node.body || '<body>', channels: ['notification'] };
    return stepGroup(node, { label: node.label || nodeDefaultLabel('notification', t), kind: 'notification' }, { delivered });
}

/** execGuard's output — the branch plus what it found. */
export function describeGuard(node: FlowNode): VariableGroup {
    const sample = {
        branch: 'then', hasPii: true, count: 2,
        categories: { Person: 1, Email: 1 },
        groups: { Personal: 1, Contact: 1 },
        scanned: 1200,
    };
    return stepGroup(node, { label: node.label || t('mobile.flow.group.guard', 'Check for personal data'), kind: 'guard' }, sample);
}

/** execTokenize's output; `text` leads because it is the point of the step. */
export function describeTokenize(node: FlowNode): VariableGroup {
    const sample = {
        text: 'mail [person_1] at [email_1]',
        count: 2,
        categories: { Person: 1, Email: 1 },
        groups: { Personal: 1, Contact: 1 },
        vaultSize: 2,
    };
    return stepGroup(node, { label: node.label || nodeDefaultLabel('tokenize', t), kind: 'tokenize' }, sample);
}

/** execUntokenize's output, including what it could NOT resolve. */
export function describeUntokenize(node: FlowNode): VariableGroup {
    const sample = {
        text: 'mail Jan de Vries at jan@acme.nl',
        value: 'mail Jan de Vries at jan@acme.nl',
        restored: 2,
        unresolved: 0,
        vaultSize: 2,
    };
    return stepGroup(node, { label: node.label || nodeDefaultLabel('untokenize', t), kind: 'untokenize' }, sample);
}

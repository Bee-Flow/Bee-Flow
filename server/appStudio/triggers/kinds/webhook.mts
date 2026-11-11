/**
 * The `webhook` trigger: run an action when another system calls the trigger's address.
 *
 *   { id, kind: 'webhook', actionId, auth: 'hmac' }
 *
 * `auth` is how a delivery proves where it comes from. `hmac` is the only way: the sender signs
 * every delivery with the trigger's secret (webhook/webhookReceive.mts has the recipe). It is
 * written out so a later way is a new value, never a changed default.
 *
 * What is NOT in the definition, on purpose: the address and the secret. Both are made when the
 * app is published (webhook/webhookEndpoints.mts) and live in their own table, so a copy of the
 * definition (an export, a template, a Blueprint, a version, what the AI builder reads) never
 * carries them, and a copy of an app never answers at the original's address.
 *
 * A webhook run may not carry an http_request step: what a delivery brings in does not leave
 * again over HTTP (personal data leaves Bee Flow only by e-mail, and a webhook must not become
 * a relay). Everything else an unattended run may do, it may do. The same holds for every run
 * further down a chain a delivery starts: a record trigger that fires on a row a webhook run
 * wrote runs no http_request either (recordTriggerRule.mts rule 6).
 */

import type { Finding, KindValidateCtx, Obj, Push, TriggerKind } from '../triggerKinds.mts';
import { INBOUND_REFUSED_KINDS } from '../recordTriggerRule.mts';

export const WEBHOOK_AUTH = 'hmac';

const PROBLEM = 'auth is "hmac": every delivery is signed with the trigger\'s secret';

function canon(raw: Obj, at: string, push: Push): Obj | null {
    if (raw.auth !== undefined && raw.auth !== null && raw.auth !== WEBHOOK_AUTH) {
        push('triggers.webhook_invalid', `${at}.auth`, `${PROBLEM} — the trigger was removed.`);
        return null;
    }
    return { auth: WEBHOOK_AUTH };
}

function validate(trigger: Obj, at: string, ctx: KindValidateCtx): void {
    if (trigger.auth === WEBHOOK_AUTH) return;
    const finding: Finding = {
        code: 'triggers.webhook_invalid', severity: 'error', path: `${at}.auth`, message: `Webhook trigger: ${PROBLEM}.`,
        hint: 'Write auth: "hmac". The address and the secret are not part of the app: they are made when the app is published.',
    };
    ctx.pushE(finding);
}

const webhook: TriggerKind = {
    kind: 'webhook',
    since: 3,
    fields: ['auth'],
    canon,
    validate,
    config: () => ({ auth: WEBHOOK_AUTH }),
    refusedKinds: INBOUND_REFUSED_KINDS,
    shape: '{ id, kind: "webhook", actionId, auth: "hmac", enabled? }',
    description: 'webhook runs the action when another system sends a signed POST with a JSON body to the trigger\'s address. '
        + 'The action reads the delivery as trigger.webhook.body (the parsed JSON), trigger.webhook.headers, trigger.webhook.deliveryId and trigger.webhook.receivedAt. '
        + 'The body is untrusted input: check what you read from it, as with a form. '
        + 'The address and the signing secret are made when the app is published and are shown to the owner in the Triggers panel; they are never part of the app and you cannot read or set them. '
        + 'A webhook run may not hold an http_request step, and neither may a record trigger\'s run that a row written by a webhook run starts.',
};

export default webhook;

// @typecheck strict
/**
 * Step kind `http_request`: one call to a web service, through a `rest` connector of the app.
 * The host, the stored credential and the fixed headers come from the connector a person made
 * under Data; the step only says which path on that host, with what method, query, headers and
 * body. There is no field for a URL (actionExecutor/steps/http_request.mts).
 *
 * It runs in an unattended run (a schedule trigger) like on a click: the same connector, the same
 * privacy check and limits, the owner's stored credential. A trigger kind that must not call out
 * lists the step in its `refusedKinds` (triggers/triggerKinds.mts).
 */

'use strict';

/** The methods a step may use. Anything but GET changes something on the other side. */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

module.exports = {
    kind: 'http_request',
    since: 3,
    side: 'server',
    fields: {
        connectorId: { type: 'string', required: true, maxLen: 80, description: 'The id of a `rest` connector of this app (app_list_connectors lists them). It fixes the host and the credential.' },
        method: { type: 'enum', values: HTTP_METHODS, default: 'GET', description: 'GET reads. POST, PUT, PATCH and DELETE change something on the other side.' },
        path: { type: 'string', maxLen: 500, description: 'The path on the connector\'s host, starting with "/". {{form.x}}, {{vars.x}}, {{item.x}} and {{params.x}} are filled in URL-encoded. No "?" or "#" (use `query`).' },
        query: { type: 'recordValues', description: 'Query parameters: { <name>: binding }. A list sends the name once per item, an empty value is left out.' },
        headers: { type: 'recordValues', description: 'Extra request headers: { <name>: binding }. Authorization, Cookie and the headers the connector sets are refused.' },
        body: { type: 'binding', description: 'The request body of a POST, PUT, PATCH or DELETE. A static value is a template: a record, list or JSON text whose text values may hold {{form.x}}, {{vars.x}}, {{item.x}}, {{params.x}} (a value that is exactly one placeholder keeps its type). A formula or field binding is sent as the value it yields.' },
        bodyFormat: { type: 'enum', values: ['json', 'form', 'text'], default: 'json', description: 'How `body` is sent: json (application/json), form (application/x-www-form-urlencoded) or text (text/plain).' },
        expect: { type: 'enum', values: ['json', 'text'], default: 'json', description: 'How the answer is read: json (parsed, an empty answer is null) or text.' },
        idempotencyKey: { type: 'binding', description: 'A value that names this one write (an order id, a uuid from an earlier step). Sent as the Idempotency-Key header, and what makes `retry` allowed on a write.' },
        resultVar: { type: 'string', maxLen: 60, description: 'The variable that gets { status, body }.' },
    },
    childSlots: [],
    // A GET may be tried again, a write only with an idempotencyKey: the validator refuses `retry`
    // on a write without one and the executor answers such a failure with retryable: false.
    retrySafe: true,
    budget: 'heavy',
    handler: 'file',
    policy: { click: 'step', background: 'run', mailboxHook: 'refuse', unattended: 'run', mcpRun: 'run', mcpDryRun: 'run', public: 'refuse' },
    /** @param {Record<string, unknown>} s */
    summary: (s) => `http_request(${typeof s.method === 'string' ? s.method : 'GET'} ${typeof s.path === 'string' && s.path ? s.path.slice(0, 60) : '/'})`,
    description: 'Calls a web service through a REST connection of this app. '
        + 'There is no URL field: `connectorId` names a `rest` connector a person created under Data (you cannot create one; ask the person when app_list_connectors shows none), and the request goes to that connector\'s host with its stored credential and fixed headers. '
        + 'You choose `method`, `path` (on that host), `query`, `headers` and `body`. `query` and `headers` are maps of bindings; `path` and a static `body` take {{form.x}} / {{vars.x}} / {{item.x}} / {{params.x}} placeholders (path reads, not formulas). '
        + 'The answer lands in `resultVar` as { status, body }: read vars.<resultVar>.body.<field> in later steps. A status outside 200-299 fails the step with error.code "http_status" (handle it with onError). '
        + 'Everything the step sends (path values, query, headers, body) passes the organisation\'s privacy check first: when it finds personal data the step fails with error.code "pii_blocked" and nothing is sent; there is no override, so send ids and amounts, not names or e-mail addresses. '
        + 'A write (anything but GET) is never repeated on its own: `retry` on a write needs `idempotencyKey`. '
        + 'Runs on a click, in a background action and in an action a schedule trigger starts; not on a public page and not from a mailbox hook. In app_run_action with dryRun a GET is really sent, a write is simulated (the result says what would be sent). '
        + 'The answer is at most 1 MB. Example: { "kind": "http_request", "connectorId": "conn_ab12cd", "method": "POST", "path": "/v1/orders/{{form.orderId}}/notes", "body": { "kind": "static", "value": { "text": "{{form.note}}", "lines": "{{vars.lineCount}}" } }, "idempotencyKey": { "kind": "formula", "expr": "form.orderId" }, "resultVar": "note" }.',
};

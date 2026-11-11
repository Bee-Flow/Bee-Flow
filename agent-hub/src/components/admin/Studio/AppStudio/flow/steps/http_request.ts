import { Cable } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * Step kind `http_request`: one call to a web service through a REST connection of this app.
 * The connection (Data · Connections) decides the host and the credential, so the settings ask
 * for a path on that host and never for an address. The connection picker lists REST
 * connections only: a step that names any other kind is refused by the server.
 */
const NS = 'studio_apps_step_http';

const httpRequest: StepKindModule = {
    kind: 'http_request',
    meta: {
        label: 'Call a web service', labelKey: `${NS}.label`, group: 'Data', icon: Cable,
        blurb: 'Send a request to a service through one of this app’s REST connections.',
        blurbKey: `${NS}.blurb`,
        server: true,
    },
    newStep: () => ({ kind: 'http_request', connectorId: '', method: 'GET', path: '/' }),
    fields: {
        connectorId: {
            options: 'restConnector',
            hint: [`${NS}.hint_connector`, 'A REST connection from Data · Connections. It decides the host and the credential; a step cannot call any other address.'],
        },
        method: { hint: [`${NS}.hint_method`, 'GET reads. The other methods change something on the other side.'] },
        path: { hint: [`${NS}.hint_path`, 'The path on the connection’s host, such as /v1/orders/{{form.orderId}}. A placeholder reads form, vars, item or params.'] },
        query: { label: [`${NS}.field_query`, 'Query parameters'] },
        headers: { label: [`${NS}.field_headers`, 'Extra headers'] },
        body: { hint: [`${NS}.hint_body`, 'What a POST, PUT, PATCH or DELETE sends. A fixed text may hold placeholders such as {{form.note}}; with the JSON format, write JSON.'] },
        bodyFormat: { label: [`${NS}.field_body_format`, 'Body format'] },
        expect: { label: [`${NS}.field_expect`, 'Read the answer as'] },
        idempotencyKey: {
            label: [`${NS}.field_idempotency_key`, 'Idempotency key'],
            hint: [`${NS}.hint_idempotency_key`, 'A value that names this one write, such as an order number. A write is only tried again when it has one.'],
        },
        resultVar: { hint: [`${NS}.hint_result_var`, 'The variable that gets the answer: vars.<name>.status and vars.<name>.body.'] },
    },
};

export default httpRequest;

// @typecheck strict
// English GUI defaults — namespace "studio_apps_step_http": every key whose part before the first "." is "studio_apps_step_http".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_step_http.json. App Studio sequence step editor: the http_request step ("Call a web
// service"), its name in the step palette and the labels and hints of its settings.
module.exports = {
    "studio_apps_step_http.blurb": "Send a request to a service through one of this app’s REST connections.",
    "studio_apps_step_http.field_body_format": "Body format",
    "studio_apps_step_http.field_expect": "Read the answer as",
    "studio_apps_step_http.field_headers": "Extra headers",
    "studio_apps_step_http.field_idempotency_key": "Idempotency key",
    "studio_apps_step_http.field_query": "Query parameters",
    "studio_apps_step_http.hint_body": "What a POST, PUT, PATCH or DELETE sends. A fixed text may hold placeholders such as {{form.note}}; with the JSON format, write JSON.",
    "studio_apps_step_http.hint_connector": "A REST connection from Data · Connections. It decides the host and the credential; a step cannot call any other address.",
    "studio_apps_step_http.hint_idempotency_key": "A value that names this one write, such as an order number. A write is only tried again when it has one.",
    "studio_apps_step_http.hint_method": "GET reads. The other methods change something on the other side.",
    "studio_apps_step_http.hint_path": "The path on the connection’s host, such as /v1/orders/{{form.orderId}}. A placeholder reads form, vars, item or params.",
    "studio_apps_step_http.hint_result_var": "The variable that gets the answer: vars.<name>.status and vars.<name>.body.",
    "studio_apps_step_http.label": "Call a web service",
};

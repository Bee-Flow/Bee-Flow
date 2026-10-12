/**
 * One awkward upstream output for the discovery round-trip tests: Microsoft
 * Graph, Gmail, Shopify, Jira, Stripe, HubSpot, an HTTP body and AI answers as
 * JSON text, every kind of key a real payload carries (`@odata.*`, hyphens,
 * spaces, quotes, `]`, `}`, unicode, empty, `constructor`), lists of lists,
 * heterogeneous rows, nulls, and nesting more than seven levels deep.
 *
 * Built from the differential end-to-end audit of the builder (its fixture),
 * plus the list shapes that audit did not have.
 */
export const DISCOVERY_FIXTURE: Record<string, unknown> = {
    "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('x')/messages",
    "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skip=10",
    "value": [{"id":"AAMk1","subject":"Q3 invoice","from":{"emailAddress":{"name":"Ada","address":"ada@example.com"}},"toRecipients":[{"emailAddress":{"name":"Bob","address":"bob@example.com"}},{"emailAddress":{"name":"Cy","address":"cy@example.com"}}],"body":{"contentType":"html","content":"<p>Hi</p>"},"categories":["Finance","Q3"],"hasAttachments":true,"internetMessageHeaders":[{"name":"X-Mailer","value":"Outlook"},{"name":"Content-Type","value":"text/html"}]},{"id":"AAMk2","subject":"Re: lunch","from":{"emailAddress":{"name":"Eve","address":"eve@example.com"}},"toRecipients":[],"categories":[],"flag":{"flagStatus":"flagged"},"body":null}],
    "gmail": {
        "id": "18c1",
        "threadId": "18c0",
        "labelIds": ["INBOX","UNREAD"],
        "payload": {"mimeType":"multipart/mixed","headers":[{"name":"From","value":"Ada <ada@example.com>"},{"name":"Subject","value":"Report"},{"name":"X-Spam-Score","value":"0.1"},{"name":"Received","value":"from a"},{"name":"received","value":"from b"}],"parts":[{"partId":"0","mimeType":"multipart/alternative","parts":[{"partId":"0.0","mimeType":"text/plain","body":{"size":5,"data":"SGVsbG8="}},{"partId":"0.1","mimeType":"text/html","body":{"size":12,"data":"PGI-SGk8L2I-"},"parts":[{"partId":"0.1.0","mimeType":"image/png","filename":"logo.png","body":{"attachmentId":"ANGjdJ","size":2048},"headers":[{"name":"Content-ID","value":"<logo>"}]}]}]},{"partId":"1","mimeType":"application/pdf","filename":"invoice.pdf","body":{"attachmentId":"ANGjdK","size":91234}}]},
    },
    "order": {
        "id": 450789469,
        "name": "#1001",
        "total_price": "409.94",
        "currency": "EUR",
        "customer": {"id":207119551,"email":"bob@example.com","default_address":{"address1":"Chestnut Street 92","city":"Louisville","country_code":"US"}},
        "line_items": [{"id":466157049,"sku":"IPOD2008GREEN","quantity":1,"price":"199.00","properties":[{"name":"Engraving","value":"Happy Birthday"},{"name":"Gift wrap","value":"yes"}],"tax_lines":[{"title":"State Tax","price":"3.98","rate":0.06}],"discount_allocations":[]},{"id":518995019,"sku":"IPOD2008RED","quantity":2,"price":"105.47","properties":[],"tax_lines":[{"title":"State Tax","price":"6.33","rate":0.06},{"title":"County Tax","price":"1.05","rate":0.01}],"variant_title":"Red / 16GB"}],
        "shipping_lines": [],
        "note_attributes": [{"name":"gift-message","value":"Enjoy"}],
        "tax_lines": [{"title":"State Tax","price":"10.31","rate":0.06}],
    },
    "jira": {
        "key": "PROJ-42",
        "fields": {"summary":"Login fails","customfield_10010":{"requestType":{"name":"IT help"}},"Story Points":5,"customfield_10020":[{"id":7,"name":"Sprint 7","state":"active"}],"status":{"name":"In Progress","statusCategory":{"key":"indeterminate","colorName":"yellow"}},"labels":["auth","p1"],"assignee":null,"issuelinks":[{"type":{"name":"Blocks"},"outwardIssue":{"key":"PROJ-7","fields":{"status":{"name":"Done"}}}}]},
    },
    "http": {
        "status": 200,
        "ok": true,
        "headers": {"content-type":"application/json; charset=utf-8","x-request-id":"abc-123"},
        "body": "{\"data\":{\"items\":[{\"id\":1,\"name\":\"A\"}]},\"next\":null}",
        "truncated": false,
    },
    "ai": {
        "text": "```json\n{\"sentiment\":\"positive\",\"topics\":[\"billing\",\"refund\"]}\n```",
        "json": {"sentiment":"positive","score":0.92,"entities":[{"type":"PERSON","text":"Ada"},{"type":"ORG","text":"Acme","meta":{"wikidata":"Q1"}}]},
        "raw": "{\"answer\": 42}",
    },
    "keys": {
        "0": "zero-key",
        "content-type": "application/json",
        "Order date": "2026-10-05",
        "a.b": "dotted",
        "Größe": "XL",
        "日本語": "ja",
        "2024 rows": 12,
        "": "empty-key",
        "say \"hi\"": "dq",
        "it's": "sq",
        "both \"q\" and 'q'": "both",
        "arr[0]": "bracket",
        "x]y": "close-bracket",
        "{{tpl}}": "braces",
        "a}b": "single-close-brace",
        "back\\slash": "bs",
        "tab\tkey": "tab",
        "new\nline": "nl",
        "null": "null-key",
        "true": "true-key",
        "length": "length-key",
        "constructor": "ctor-key",
        "$ref": "dollar",
        "_id": "underscore",
        " spaced ": "padded",
        "emoji 🎉": "party",
        "Amount [EUR]": 1500,
        "Phone [optional]": "+31 6 1234 5678",
    },
    "matrix": [[1,2],[3,4]],
    "cube": [[[1,2],[3]],[[4]]],
    "mixed": [1,"two",null,{"k":"v"},[5,6],true],
    "hetero": [{"a":1},{"b":2},{"a":3,"c":{"d":4}},null],
    "nullsInList": ["x",null,"y"],
    "deep": {
        "l1": {"l2":{"l3":{"l4":{"l5":{"l6":{"l7":{"l8":"bottom","list":[{"l9":[{"l10":"deepest"}]}]}}}}}}},
    },
    "nullable": null,
    "emptyObj": {},
    "emptyArr": [],
    "listOfLists": [{"rows":[{"cells":[{"v":1},{"v":2}]},{"cells":[{"v":3}]}]},{"rows":[{"cells":[]}]}],
    "count": 0,
    "flag": false,
    "nullFirst": [null,{"k":1},{"k":2,"extra":{"deeper":true}}],
    "primFirst": ["x",{"k":1}],
    "Tags": [{"Key":"env","Value":"prod"},{"Key":"Owner","Value":"ops"}],
    "stripe": {
        "id": "evt_1",
        "data": {"object":{"id":"in_1","lines":{"data":[{"amount":1500,"price":{"id":"price_1","recurring":null}},{"amount":99,"price":{"id":"price_2","recurring":{"interval":"month"}}}]}}},
    },
    "hubspot": {
        "results": [{"id":"51","properties":{"email":"a@b.nl"},"associations":{"contacts":{"results":[{"id":"9","type":"contact_to_company"}]}}}],
    },
    "listText": "[{\"sku\":\"A1\",\"qty\":2},{\"sku\":\"B2\",\"qty\":1,\"note\":\"gift\"}]",
    "twiceEncoded": "\"{\\\"inner\\\":{\\\"ok\\\":true}}\"",
};

/**
 * JSON text nested in JSON text, several levels deep, inside lists: an HTTP
 * body (text) holding a payload (text) holding list items whose meta is text
 * again, down to a fenced AI answer. The same value the runtime's grammar
 * test resolves (server/shared/expr/path.test.mjs): every level must be
 * offered with a plain path.
 */
const NESTED_LVL3 = '```json\n' + JSON.stringify({ verdict: { score: 0.93, 'reason code': 'R-7' } }) + '\n```';
const NESTED_LVL2 = JSON.stringify({ items: [{ sku: 'A1', meta: JSON.stringify({ tags: ['x', 'y'], ai: NESTED_LVL3 }) }, { sku: 'B2', meta: '{"tags":["z"]}' }] });
export const NESTED_TEXT_OUTPUT: Record<string, unknown> = { body: JSON.stringify({ data: { payload: NESTED_LVL2 } }) };

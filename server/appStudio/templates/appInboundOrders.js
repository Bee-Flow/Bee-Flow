// @typecheck strict
/**
 * App Studio template — Inbound orders.
 *
 * One of the four schema-3 templates (see ../templates.js). Another system (a
 * web shop, a marketplace, an ERP) sends each order to the app as a signed POST,
 * and the app files it.
 *
 *   webhook   a webhook trigger (auth "hmac"). The address and the signing secret
 *             are made when the app is published and shown to the owner in the
 *             Triggers panel; they are never part of the app or this template.
 *   code      the body is untrusted input. A code step normalises it (field
 *             names, case, numbers), checks it and matches the SKU against the
 *             product table, with no network and no database of its own. The
 *             rows are written by ordinary steps after it.
 *   rules     field validation on the tables (an SKU pattern, quantity range,
 *             e-mail format, a unique external order id) refuses a bad row even
 *             when the code step lets it through; a `try` turns such a refusal
 *             into a rejected line in the delivery log instead of a failed run.
 *   no http   the flow makes no outside call: a webhook run may not hold an
 *             http_request step, and nothing here needs one.
 *   look      a detail screen with tabs, a carousel of the product's pictures
 *             (uploaded files of the app, written asset:<id> in the product),
 *             and a shell of its own: a sidebar with a brand, links of its own
 *             and a footer line.
 *
 * Nothing is armed on install: the webhook has no address until the app is
 * published. Three sample products carry a picture: small placeholder drawings
 * shipped as the template's files (./templatePictures.js, drawn by
 * server/scripts/gen-template-pictures.mts) and named `asset:<id>` in the
 * sample rows. The install stores them in the new app like uploads and writes
 * the rows with the ids they got there, so the carousel shows them at once.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');
const { templatePictures } = require('./templatePictures');

const STATUS_OPTIONS = [
    { value: 'received', label: 'Received' },
    { value: 'picking', label: 'Picking' },
    { value: 'shipped', label: 'Shipped' },
    { value: 'cancelled', label: 'Cancelled' },
];
const STATUS_TONES = [
    { value: 'received', label: 'Received', tone: 'info' },
    { value: 'picking', label: 'Picking', tone: 'warning' },
    { value: 'shipped', label: 'Shipped', tone: 'success' },
    { value: 'cancelled', label: 'Cancelled', tone: 'neutral' },
];
const OUTCOME_OPTIONS = [
    { value: 'accepted', label: 'Accepted' },
    { value: 'rejected', label: 'Rejected' },
];
const SKU_PATTERN = '^[A-Z]{2,4}-[0-9]{3,5}$';

/**
 * The normaliser. Reads the delivery as the sender wrote it, accepts the usual
 * spellings of each field, and answers { ok, reason, order } for the steps
 * after it. It never throws on bad input: a bad delivery is a rejected line in
 * the log, not a failed run.
 */
const NORMALISE_CODE = [
    'function main(inputs, ctx) {',
    '  const body = inputs.body && typeof inputs.body === "object" && !Array.isArray(inputs.body) ? inputs.body : {};',
    '  const pick = (...keys) => { for (const k of keys) { if (body[k] !== undefined && body[k] !== null && body[k] !== "") return body[k]; } return undefined; };',
    '  const text = (v, max) => (v === undefined ? "" : String(v).trim().slice(0, max));',
    '  const customer = body.customer && typeof body.customer === "object" ? body.customer : {};',
    '  const order = {',
    '    external_id: text(pick("orderId", "order_id", "id", "reference"), 64),',
    '    customer_name: text(pick("customerName", "customer_name") ?? customer.name, 120),',
    '    customer_email: text(pick("email", "customerEmail", "customer_email") ?? customer.email, 200).toLowerCase(),',
    '    sku: text(pick("sku", "productSku", "product_sku"), 20).toUpperCase(),',
    '    quantity: Math.trunc(Number(pick("quantity", "qty", "amount") ?? 1)),',
    '    note: text(pick("note", "comment", "remarks"), 500),',
    '  };',
    '  const reject = (reason) => { ctx.log("rejected: " + reason); return { ok: false, reason, order }; };',
    '  if (!order.external_id) return reject("The delivery has no order id.");',
    '  if (!order.customer_name) return reject("The delivery has no customer name.");',
    '  if (!Number.isFinite(order.quantity) || order.quantity < 1 || order.quantity > 999) return reject("The quantity is not a number from 1 to 999.");',
    '  const products = Array.isArray(inputs.products) ? inputs.products : [];',
    '  const product = products.find((p) => String(p.sku || "").toUpperCase() === order.sku);',
    '  if (!product) return reject("No product has the SKU " + (order.sku || "(empty)") + ".");',
    '  order.product = product.id;',
    '  order.unit_price = Number(product.price) || 0;',
    '  return { ok: true, reason: "", order };',
    '}',
].join('\n');

const HELP_MARKDOWN = [
    '## Connect a shop or a marketplace',
    '',
    'Publish the app first. The **Triggers** panel then shows the address of the `order_in` webhook and its signing secret. Give both to the system that sends the orders: it signs each delivery with the secret, and an unsigned or wrongly signed delivery is refused before the app sees it.',
    '',
    '### What a delivery looks like',
    '',
    '```json',
    '{',
    '  "orderId": "WEB-10421",',
    '  "customer": { "name": "Casey Brooks", "email": "casey@example.com" },',
    '  "sku": "TL-2040",',
    '  "quantity": 2,',
    '  "note": "Leave at the side door"',
    '}',
    '```',
    '',
    '| Field | Also accepted as | Rule |',
    '| --- | --- | --- |',
    '| `orderId` | `order_id`, `id`, `reference` | Required, unique per order |',
    '| `customer.name` | `customerName`, `customer_name` | Required |',
    '| `customer.email` | `email`, `customerEmail` | An e-mail address |',
    '| `sku` | `productSku`, `product_sku` | A product of this app |',
    '| `quantity` | `qty`, `amount` | 1 to 999, 1 when left out |',
    '',
    '> The same order sent twice is filed once: the second delivery is logged as rejected.',
].join('\n');

/** The order the detail screen shows, and the product and delivery that go with it. */
/**
 * @param {string} field
 * @param {string} name
 */
const byVar = (field, name) => [{ field, op: 'eq', value: { kind: 'formula', expr: `vars.${name}` } }];
/**
 * @param {string} status
 * @param {string} message
 */
const setOrder = (status, message) => ({
    kind: 'sequence',
    steps: [
        { kind: 'update_record', tableId: 'tbl_ioord', recordId: { kind: 'formula', expr: 'vars.orderId' }, values: { status: { kind: 'static', value: status } } },
        { kind: 'toast', message, tone: 'success' },
        { kind: 'refresh', tableId: 'tbl_ioord' },
    ],
});
/**
 * @param {string} id
 * @param {number} n
 */
const photo = (id, n) => ({
    id, type: 'image',
    props: { alt: `Product picture ${n}`, fit: 'contain', srcFrom: { kind: 'formula', expr: `item.image_${n}` } },
    style: { span: 12, height: 'lg', radius: 'md' },
});
/** @param {unknown[]} filter */
const countOrders = (filter) => ({ kind: 'aggregate', tableId: 'tbl_ioord', filter, aggregates: [{ fn: 'count', as: 'n' }], pick: { row: 'first', column: 'n' } });

module.exports = {
    id: 'app-inbound-orders',
    // 2: the sample products carry pictures (the template's own files).
    version: 2,
    title: 'Inbound orders',
    description: 'Orders from your web shop or marketplace arrive through a signed webhook, are checked and tidied on the way in, and land on a pick list with the product, its pictures and the delivery log.',
    category: 'Data',
    icon: 'PackageCheck',
    tags: ['orders', 'webhook', 'integration', 'fulfilment', 'products'],
    dataModel: {
        modelVersion: 1,
        tables: [
            {
                id: 'tbl_ioprod', key: 'products', name: 'Products', icon: 'Package',
                fields: [
                    { id: 'fld_iopsku', key: 'sku', name: 'SKU', type: 'text', required: true, unique: true, validation: { pattern: SKU_PATTERN, message: 'An SKU is 2 to 4 capitals, a dash and 3 to 5 digits, like TL-2040.' } },
                    { id: 'fld_iopnam', key: 'name', name: 'Name', type: 'text', required: true, validation: { minLength: 2, maxLength: 120 } },
                    { id: 'fld_iopprc', key: 'price', name: 'Price', type: 'number', display: { currency: 'EUR', decimals: 2 }, validation: { min: 0, max: 100000 } },
                    { id: 'fld_iopstk', key: 'stock', name: 'In stock', type: 'number', validation: { min: 0, max: 100000 } },
                    { id: 'fld_iopdsc', key: 'description', name: 'Description', type: 'text', validation: { maxLength: 1000 } },
                    { id: 'fld_iopim1', key: 'image_1', name: 'Picture 1', type: 'text', validation: { maxLength: 200 } },
                    { id: 'fld_iopim2', key: 'image_2', name: 'Picture 2', type: 'text', validation: { maxLength: 200 } },
                    { id: 'fld_iopim3', key: 'image_3', name: 'Picture 3', type: 'text', validation: { maxLength: 200 } },
                ],
                access: { default: 'app' },
            },
            {
                id: 'tbl_ioord', key: 'orders', name: 'Orders', icon: 'ShoppingCart',
                fields: [
                    { id: 'fld_ioref', key: 'ref', name: 'Number', type: 'autonumber', unique: true },
                    { id: 'fld_ioext', key: 'external_id', name: 'Order id', type: 'text', required: true, unique: true, validation: { maxLength: 64 } },
                    { id: 'fld_iocnm', key: 'customer_name', name: 'Customer', type: 'text', required: true, validation: { maxLength: 120 } },
                    { id: 'fld_iocml', key: 'customer_email', name: 'E-mail', type: 'text', format: 'email' },
                    { id: 'fld_ioprd', key: 'product', name: 'Product', type: 'relation', relation: { table: 'tbl_ioprod', displayField: 'name', onDelete: 'restrict' } },
                    { id: 'fld_iopnm', key: 'product_name', name: 'Product name', type: 'lookup', lookup: { relation: 'product', field: 'name' } },
                    { id: 'fld_iosku', key: 'sku', name: 'SKU', type: 'text', validation: { pattern: SKU_PATTERN } },
                    { id: 'fld_ioqty', key: 'quantity', name: 'Quantity', type: 'number', required: true, validation: { min: 1, max: 999, message: 'Order 1 to 999 pieces.' } },
                    { id: 'fld_ioup', key: 'unit_price', name: 'Unit price', type: 'number', display: { currency: 'EUR', decimals: 2 }, validation: { min: 0 } },
                    { id: 'fld_iotot', key: 'total', name: 'Total', type: 'computed', computed: { expr: 'quantity * unit_price' } },
                    { id: 'fld_iosts', key: 'status', name: 'Status', type: 'select', options: STATUS_OPTIONS, validation: { enforceOptions: true } },
                    { id: 'fld_ionote', key: 'note', name: 'Note', type: 'text', validation: { maxLength: 500 } },
                    { id: 'fld_iodlv', key: 'delivery_id', name: 'Delivery', type: 'text' },
                    { id: 'fld_ioat', key: 'received_at', name: 'Received', type: 'datetime', dynamicDefault: 'now' },
                ],
                indexes: [{ fields: ['status'] }],
                access: { default: 'app' },
            },
            {
                id: 'tbl_iolog', key: 'deliveries', name: 'Deliveries', icon: 'History',
                fields: [
                    { id: 'fld_iolid', key: 'delivery_id', name: 'Delivery', type: 'text' },
                    { id: 'fld_iolext', key: 'external_id', name: 'Order id', type: 'text', validation: { maxLength: 64 } },
                    { id: 'fld_iolout', key: 'outcome', name: 'Outcome', type: 'select', options: OUTCOME_OPTIONS },
                    { id: 'fld_iolrsn', key: 'reason', name: 'Reason', type: 'text', validation: { maxLength: 300 } },
                    { id: 'fld_iolat', key: 'received_at', name: 'Received', type: 'datetime', dynamicDefault: 'now' },
                ],
                access: { default: 'app' },
            },
        ],
        roles: [],
        roleMapping: { default: 'app', byGroup: {} },
    },
    assets: templatePictures([
        { id: 'iopic_lamp', file: 'inbound-orders-lamp.png' },
        { id: 'iopic_chair', file: 'inbound-orders-chair.png' },
        { id: 'iopic_mug', file: 'inbound-orders-mug.png' },
    ]),
    seed: {
        tbl_ioprod: [
            { $id: 'p1', sku: 'TL-2040', name: 'Desk lamp, brushed steel', price: 49.5, stock: 38, description: 'An adjustable desk lamp with a warm LED.', image_1: 'asset:iopic_lamp' },
            { $id: 'p2', sku: 'CH-1180', name: 'Oak side chair', price: 129, stock: 12, description: 'Solid oak, oiled, stackable by two.', image_1: 'asset:iopic_chair' },
            { $id: 'p3', sku: 'MUG-310', name: 'Stoneware mug', price: 14.9, stock: 4, description: 'Glazed stoneware, 300 ml, dishwasher safe.', image_1: 'asset:iopic_mug' },
            { $id: 'p4', sku: 'RUG-9020', name: 'Wool rug, 160 x 230', price: 245, stock: 0, description: 'Hand-woven wool in natural grey.' },
        ],
        tbl_ioord: [
            { external_id: 'WEB-10401', customer_name: 'Casey Brooks', customer_email: 'casey@example.com', product: { $ref: 'p1' }, sku: 'TL-2040', quantity: 2, unit_price: 49.5, status: 'shipped', delivery_id: 'dlv-demo-01' },
            { external_id: 'WEB-10407', customer_name: 'Morgan Lee', customer_email: 'morgan@example.com', product: { $ref: 'p2' }, sku: 'CH-1180', quantity: 4, unit_price: 129, status: 'picking', delivery_id: 'dlv-demo-02', note: 'Deliver after 10:00.' },
            { external_id: 'MKT-55120', customer_name: 'Riley Novak', customer_email: 'riley@example.com', product: { $ref: 'p3' }, sku: 'MUG-310', quantity: 6, unit_price: 14.9, status: 'received', delivery_id: 'dlv-demo-03' },
            { external_id: 'WEB-10412', customer_name: 'Jordan Blake', customer_email: 'jordan@example.com', product: { $ref: 'p1' }, sku: 'TL-2040', quantity: 1, unit_price: 49.5, status: 'received', delivery_id: 'dlv-demo-04' },
        ],
        tbl_iolog: [
            { delivery_id: 'dlv-demo-01', external_id: 'WEB-10401', outcome: 'accepted' },
            { delivery_id: 'dlv-demo-02', external_id: 'WEB-10407', outcome: 'accepted' },
            { delivery_id: 'dlv-demo-03', external_id: 'MKT-55120', outcome: 'accepted' },
            { delivery_id: 'dlv-demo-04', external_id: 'WEB-10412', outcome: 'accepted' },
            { delivery_id: 'dlv-demo-05', external_id: 'WEB-10412', outcome: 'rejected', reason: 'The order was filed already.' },
            { delivery_id: 'dlv-demo-06', external_id: 'MKT-55133', outcome: 'rejected', reason: 'No product has the SKU LMP-77.' },
        ],
    },
    definition: {
        schemaVersion: 3,
        meta: { name: 'Inbound orders', description: 'Orders that arrive by webhook, checked and filed.', icon: 'PackageCheck' },
        theme: { primary: '#B45309', ...THEME_DEFAULTS },
        design: { preset: 'custom', font: 'satoshi', surface: 'hairline', motion: 'subtle', chartPalette: 'brand', accentEdge: 'none', logoUrl: null, radiusPx: 10 },
        format: { currency: 'EUR', currencyDecimals: 2, dateFormat: 'd MMM yyyy', timeZone: 'Europe/Amsterdam' },
        nav: {
            style: 'sidebar',
            brand: { name: 'Order desk', showName: true },
            items: [
                { id: 'nvi_iohelp', label: 'Connect a system', icon: 'Plug', screenId: 'scr_iohelp' },
                { id: 'nvi_iolog', label: 'Delivery log', icon: 'History', screenId: 'scr_iolog' },
            ],
            footerText: 'Orders arrive through a signed webhook. Unsigned deliveries are refused.',
        },
        homeScreenId: 'scr_ioorders',
        roles: [],
        variables: [
            { name: 'orderId', label: 'Open order', type: 'text', default: '', description: 'The order the Order screen shows' },
            { name: 'productId', label: 'Its product', type: 'text', default: '', description: 'The product of the open order' },
            { name: 'externalId', label: 'Its order id', type: 'text', default: '', description: 'The order id the sender gave, for the delivery log' },
            { name: 'normalised', label: 'Normalised delivery', type: 'any', default: null, description: 'What the code step made of a webhook delivery' },
        ],
        screens: [
            {
                id: 'scr_ioorders', name: 'Orders', icon: 'ShoppingCart', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_iohead', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_ioph', type: 'page_header', props: { title: 'Orders', subtitle: 'Everything the connected systems sent, newest first.', icon: 'PackageCheck', showDivider: false }, style: { span: 12 } },
                            { id: 'cmp_iostnew', type: 'stat', props: { label: 'To pick', icon: 'Inbox', look: 'tile', value: countOrders([{ field: 'status', op: 'eq', value: 'received' }]) }, style: { span: 4, spanSm: 12 } },
                            { id: 'cmp_iostpck', type: 'stat', props: { label: 'Being picked', icon: 'PackageOpen', look: 'tile', value: countOrders([{ field: 'status', op: 'eq', value: 'picking' }]) }, style: { span: 4, spanSm: 12 } },
                            { id: 'cmp_iostshp', type: 'stat', props: { label: 'Shipped', icon: 'Truck', look: 'tile', value: countOrders([{ field: 'status', op: 'eq', value: 'shipped' }]) }, style: { span: 4, spanSm: 12 } },
                        ],
                    },
                    {
                        id: 'sec_iogrid', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_iogrd', type: 'data_grid',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_ioord', sort: [{ field: 'received_at', dir: 'desc' }], limit: 50 },
                                    columns: [
                                        { key: 'ref', label: '#', format: 'number', width: 56 },
                                        { key: 'external_id', label: 'Order id', format: 'text' },
                                        { key: 'customer_name', label: 'Customer', format: 'text' },
                                        { key: 'product_name', label: 'Product', format: 'text' },
                                        { key: 'quantity', label: 'Qty', format: 'number', align: 'right' },
                                        { key: 'total', label: 'Total', format: 'currency', align: 'right' },
                                        { key: 'status', label: 'Status', format: 'badge', toneMap: STATUS_TONES },
                                        { key: 'received_at', label: 'Received', format: 'relative' },
                                    ],
                                    searchable: true,
                                    pagination: 'loadMore',
                                    emptyText: 'No orders yet. Publish the app and connect a system to start.',
                                },
                                style: { span: 12 },
                                onRowClick: 'act_ioopen',
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_ioorder', name: 'Order', icon: 'Receipt', showInNav: false, maxWidth: 'medium',
                sections: [
                    {
                        id: 'sec_ioorder', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_ioback', type: 'button', props: { label: 'All orders', variant: 'ghost', iconLeft: 'ArrowLeft' }, style: { span: 3, spanSm: 12 }, onClick: 'act_ioback' },
                            { id: 'cmp_iopick', type: 'button', props: { label: 'Start picking', variant: 'soft', iconLeft: 'PackageOpen' }, style: { span: 3, spanSm: 6 }, onClick: 'act_iopicking' },
                            { id: 'cmp_ioship', type: 'button', props: { label: 'Mark shipped', variant: 'primary', iconLeft: 'Truck' }, style: { span: 3, spanSm: 6 }, onClick: 'act_ioshipped' },
                            {
                                id: 'cmp_iotabs', type: 'tabs', props: { look: 'underline' }, style: { span: 12 },
                                children: [
                                    {
                                        id: 'cmp_iotabo', type: 'tab', props: { label: 'Order', icon: 'Receipt' },
                                        children: [
                                            {
                                                id: 'cmp_iostep', type: 'repeater',
                                                props: { source: { kind: 'records', tableId: 'tbl_ioord', filter: byVar('id', 'orderId'), limit: 1 }, emptyText: 'Pick an order.' },
                                                style: { span: 12 },
                                                children: [
                                                    {
                                                        id: 'cmp_iostpr', type: 'stepper',
                                                        props: {
                                                            value: { kind: 'formula', expr: 'item.status' },
                                                            steps: [
                                                                { value: 'received', label: 'Received', icon: 'Inbox' },
                                                                { value: 'picking', label: 'Picking', icon: 'PackageOpen' },
                                                                { value: 'shipped', label: 'Shipped', icon: 'Truck' },
                                                            ],
                                                        },
                                                        style: { span: 12 },
                                                    },
                                                ],
                                            },
                                            {
                                                id: 'cmp_ioodet', type: 'record_detail',
                                                props: {
                                                    source: { kind: 'record', tableId: 'tbl_ioord', filter: byVar('id', 'orderId') },
                                                    fields: [
                                                        { key: 'external_id', label: 'Order id', format: 'text' },
                                                        { key: 'status', label: 'Status', format: 'badge' },
                                                        { key: 'customer_name', label: 'Customer', format: 'text' },
                                                        { key: 'customer_email', label: 'E-mail', format: 'link' },
                                                        { key: 'product_name', label: 'Product', format: 'text' },
                                                        { key: 'sku', label: 'SKU', format: 'text' },
                                                        { key: 'quantity', label: 'Quantity', format: 'number' },
                                                        { key: 'total', label: 'Total', format: 'number' },
                                                        { key: 'note', label: 'Note', format: 'text' },
                                                        { key: 'received_at', label: 'Received', format: 'datetime' },
                                                    ],
                                                    columns: 2,
                                                },
                                                style: { span: 12 },
                                            },
                                        ],
                                    },
                                    {
                                        id: 'cmp_iotabp', type: 'tab', props: { label: 'Product', icon: 'Package' },
                                        children: [
                                            {
                                                id: 'cmp_ioprep', type: 'repeater',
                                                props: { source: { kind: 'records', tableId: 'tbl_ioprod', filter: byVar('id', 'productId'), limit: 1 }, emptyText: 'This order names no product.' },
                                                style: { span: 12 },
                                                children: [
                                                    {
                                                        id: 'cmp_iocar', type: 'carousel', props: { loop: true, showDots: true }, style: { span: 7, spanMd: 12 },
                                                        children: [photo('cmp_ioimg1', 1), photo('cmp_ioimg2', 2), photo('cmp_ioimg3', 3)],
                                                    },
                                                    {
                                                        id: 'cmp_iopinfo', type: 'container', props: { look: 'plain' }, style: { span: 5, spanMd: 12, gap: 2 },
                                                        children: [
                                                            { id: 'cmp_iopnm', type: 'heading', props: { text: 'Product', level: 2 }, style: { span: 12 }, computed: { text: { kind: 'formula', expr: 'item.name' } } },
                                                            { id: 'cmp_iopsku', type: 'text', props: { text: 'SKU', muted: true }, style: { span: 12, font: 'mono' }, computed: { text: { kind: 'formula', expr: 'item.sku' } } },
                                                            { id: 'cmp_iopdsc', type: 'text', props: { text: 'Description', muted: false }, style: { span: 12 }, computed: { text: { kind: 'formula', expr: "item.description ?? ''" } } },
                                                            {
                                                                id: 'cmp_iopstk', type: 'text', props: { text: 'Stock', muted: false }, style: { span: 12, weight: 'semibold' },
                                                                computed: { text: { kind: 'formula', expr: "item.stock > 0 ? item.stock + ' in stock' : 'Out of stock'" } },
                                                                styleWhen: [{ when: 'item.stock <= 0', style: { color: 'danger' } }, { when: 'item.stock > 0 && item.stock < 5', style: { color: 'warning' } }],
                                                            },
                                                        ],
                                                    },
                                                ],
                                            },
                                        ],
                                    },
                                    {
                                        id: 'cmp_iotabd', type: 'tab', props: { label: 'Delivery', icon: 'History' },
                                        children: [
                                            {
                                                id: 'cmp_iodlog', type: 'table',
                                                props: {
                                                    source: { kind: 'records', tableId: 'tbl_iolog', filter: byVar('external_id', 'externalId'), sort: [{ field: 'received_at', dir: 'desc' }] },
                                                    columns: [
                                                        { key: 'received_at', label: 'Received', format: 'datetime' },
                                                        { key: 'delivery_id', label: 'Delivery', format: 'text' },
                                                        { key: 'outcome', label: 'Outcome', format: 'badge', toneMap: [{ value: 'accepted', label: 'Accepted', tone: 'success' }, { value: 'rejected', label: 'Rejected', tone: 'danger' }] },
                                                        { key: 'reason', label: 'Reason', format: 'text' },
                                                    ],
                                                    emptyText: 'No deliveries for this order.',
                                                },
                                                style: { span: 12 },
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_ioprods', name: 'Products', icon: 'Package', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_ioprods', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_ioprh', type: 'page_header', props: { title: 'Products', subtitle: 'An order is filed only when its SKU is one of these.', icon: 'Package', showDivider: false }, style: { span: 12 },
                                children: [{ id: 'cmp_ioaddp', type: 'button', props: { label: 'Add a product', variant: 'primary', iconLeft: 'Plus' }, style: { span: 3 }, onClick: 'act_ioaddopen' }],
                            },
                            {
                                id: 'cmp_ioprgrd', type: 'data_grid',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_ioprod', sort: [{ field: 'sku', dir: 'asc' }] },
                                    columns: [
                                        { key: 'sku', label: 'SKU', format: 'text' },
                                        { key: 'name', label: 'Product', format: 'text' },
                                        { key: 'price', label: 'Price', format: 'currency', align: 'right' },
                                        { key: 'stock', label: 'In stock', format: 'number', align: 'right', cellStyle: [{ when: 'value <= 0', style: { color: 'danger', weight: 'bold' } }, { when: 'value > 0 && value < 5', style: { color: 'warning', weight: 'semibold' } }] },
                                    ],
                                    look: 'minimal',
                                    emptyText: 'No products yet.',
                                },
                                style: { span: 12 },
                            },
                            {
                                id: 'cmp_ioaddm', type: 'modal', props: { title: 'Add a product', size: 'md', placement: 'right' },
                                children: [
                                    {
                                        id: 'cmp_ioaddf', type: 'form', props: { name: 'product', submitLabel: 'Add the product', validateOn: 'blur' }, style: { span: 12, gap: 3, padding: 0 },
                                        onSubmit: 'act_ioaddsave',
                                        children: [
                                            { id: 'cmp_ioafsku', type: 'input_text', props: { name: 'sku', label: 'SKU', required: true, placeholder: 'TL-2040' }, style: { span: 6 } },
                                            { id: 'cmp_ioafprc', type: 'input_number', props: { name: 'price', label: 'Price (EUR)', min: 0, step: 0.5 }, style: { span: 6 } },
                                            { id: 'cmp_ioafnam', type: 'input_text', props: { name: 'name', label: 'Name', required: true }, style: { span: 12 } },
                                            { id: 'cmp_ioafstk', type: 'input_number', props: { name: 'stock', label: 'In stock', min: 0, step: 1, defaultValue: 0 }, style: { span: 6 } },
                                            { id: 'cmp_ioafdsc', type: 'input_textarea', props: { name: 'description', label: 'Description', rows: 3 }, style: { span: 12 } },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_iolog', name: 'Delivery log', icon: 'History', showInNav: false, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_iolog', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_iologh', type: 'heading', props: { text: 'Every delivery, filed or not', level: 1, accent: 'bar' }, style: { span: 12 } },
                            {
                                id: 'cmp_iologg', type: 'data_grid',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_iolog', sort: [{ field: 'received_at', dir: 'desc' }], limit: 100 },
                                    columns: [
                                        { key: 'received_at', label: 'Received', format: 'datetime' },
                                        { key: 'external_id', label: 'Order id', format: 'text' },
                                        { key: 'outcome', label: 'Outcome', format: 'badge', toneMap: [{ value: 'accepted', label: 'Accepted', tone: 'success' }, { value: 'rejected', label: 'Rejected', tone: 'danger' }] },
                                        { key: 'reason', label: 'Reason', format: 'text' },
                                        { key: 'delivery_id', label: 'Delivery', format: 'text' },
                                    ],
                                    rowTone: [{ field: 'outcome', value: 'rejected', tone: 'danger' }],
                                    emptyText: 'Nothing delivered yet.',
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_iohelp', name: 'Connect a system', icon: 'Plug', showInNav: false, maxWidth: 'medium',
                sections: [
                    {
                        id: 'sec_iohelp', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_iohelpmd', type: 'markdown', props: { content: HELP_MARKDOWN, rich: true }, style: { span: 12 } },
                        ],
                    },
                ],
            },
        ],
        actions: {
            act_ioback: { kind: 'navigate', screenId: 'scr_ioorders' },
            act_ioopen: {
                kind: 'sequence',
                steps: [
                    { kind: 'set_variable', name: 'orderId', value: { kind: 'formula', expr: 'item.id' } },
                    { kind: 'set_variable', name: 'productId', value: { kind: 'formula', expr: "item.product ?? ''" } },
                    { kind: 'set_variable', name: 'externalId', value: { kind: 'formula', expr: 'item.external_id' } },
                    { kind: 'navigate', screenId: 'scr_ioorder' },
                ],
            },
            act_iopicking: setOrder('picking', 'Picking started.'),
            act_ioshipped: setOrder('shipped', 'Order shipped.'),
            act_ioaddopen: { kind: 'open_modal', modalId: 'cmp_ioaddm' },
            act_ioaddsave: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'create_record', tableId: 'tbl_ioprod',
                        values: {
                            sku: { kind: 'formula', expr: 'upper(trim(form.sku))' },
                            name: { kind: 'formula', expr: 'form.name' },
                            price: { kind: 'formula', expr: 'form.price' },
                            stock: { kind: 'formula', expr: 'form.stock' },
                            description: { kind: 'formula', expr: 'form.description' },
                        },
                    },
                    { kind: 'close_modal', modalId: 'cmp_ioaddm' },
                    { kind: 'toast', message: 'Product added.', tone: 'success' },
                    { kind: 'refresh', tableId: 'tbl_ioprod' },
                ],
            },
            // The webhook trigger's action. The body is untrusted: the code step
            // reads it, the field rules check the row again on the write, and the
            // `try` logs a refused write instead of failing the run.
            act_ioin: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'code',
                        code: NORMALISE_CODE,
                        inputs: {
                            body: { kind: 'formula', expr: 'trigger.webhook.body' },
                            products: { kind: 'records', tableId: 'tbl_ioprod', fields: ['sku', 'price'], limit: 200 },
                        },
                        resultVar: 'normalised',
                        timeoutMs: 2000,
                    },
                    {
                        kind: 'condition',
                        expr: 'vars.normalised.ok == true',
                        then: [
                            {
                                kind: 'try',
                                steps: [
                                    {
                                        kind: 'create_record', tableId: 'tbl_ioord',
                                        values: {
                                            external_id: { kind: 'formula', expr: 'vars.normalised.order.external_id' },
                                            customer_name: { kind: 'formula', expr: 'vars.normalised.order.customer_name' },
                                            customer_email: { kind: 'formula', expr: 'vars.normalised.order.customer_email' },
                                            product: { kind: 'formula', expr: 'vars.normalised.order.product' },
                                            sku: { kind: 'formula', expr: 'vars.normalised.order.sku' },
                                            quantity: { kind: 'formula', expr: 'vars.normalised.order.quantity' },
                                            unit_price: { kind: 'formula', expr: 'vars.normalised.order.unit_price' },
                                            note: { kind: 'formula', expr: 'vars.normalised.order.note' },
                                            status: { kind: 'static', value: 'received' },
                                            delivery_id: { kind: 'formula', expr: 'trigger.webhook.deliveryId' },
                                        },
                                    },
                                    { kind: 'call_action', actionId: 'act_iolog', params: { outcome: { kind: 'static', value: 'accepted' }, reason: { kind: 'static', value: '' } } },
                                ],
                                catch: [
                                    { kind: 'call_action', actionId: 'act_iolog', params: { outcome: { kind: 'static', value: 'rejected' }, reason: { kind: 'formula', expr: "'Not filed: ' + (error.message ?? 'the order broke a rule of the table')" } } },
                                ],
                            },
                        ],
                        else: [
                            { kind: 'call_action', actionId: 'act_iolog', params: { outcome: { kind: 'static', value: 'rejected' }, reason: { kind: 'formula', expr: 'vars.normalised.reason' } } },
                        ],
                    },
                ],
            },
            act_iolog: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'create_record', tableId: 'tbl_iolog',
                        values: {
                            delivery_id: { kind: 'formula', expr: 'trigger.webhook.deliveryId' },
                            external_id: { kind: 'formula', expr: "vars.normalised.order.external_id ?? ''" },
                            outcome: { kind: 'formula', expr: 'params.outcome' },
                            reason: { kind: 'formula', expr: 'substring(params.reason ?? \'\', 0, 300)' },
                        },
                    },
                ],
            },
        },
        triggers: [
            { id: 'order_in', kind: 'webhook', actionId: 'act_ioin', auth: 'hmac' },
        ],
    },
};

// @typecheck strict
/**
 * App Studio catalog: `custom_block`, the builder's own HTML template and stylesheet.
 *
 * A block holds NO script. Its template is HTML from a closed vocabulary with formulas of the
 * app's expression language in it; the web runtime draws it inside a frame that can run
 * nothing and load nothing (server/shared/blockTemplate/, agent-hub …/runtime/components/
 * customBlock/). Everything is in one prop, `block`, cleaned by customBlock/blockShape.mts.
 */

'use strict';

const CONTRACT = [
    'Your own HTML template and stylesheet, without script, in a sealed frame.',
    'Catalogue first: use custom_block ONLY for what no catalogue component can draw (a bespoke card, a diagram, a small chart), never for data entry (inputs belong in a form with input_* components).',
    'Everything is in props.block: { template, css, inputs, events }. Write it with app_edit_block.',
    'template: HTML from a closed list of elements: div span p h1-h6 ul ol li dl dt dd table thead tbody tfoot tr th td caption strong em b i u s small sub sup mark code pre kbd blockquote q cite abbr time br hr wbr section article header footer main nav aside figure figcaption details summary button a, and svg with g path circle ellipse rect line polyline polygon text tspan.',
    'There is NO script, style, link, iframe, img, form or input element, no on* attribute, no href, src or any other address, and no id. Whatever is not on the lists is removed when you save, and the result tells you what and on which template line.',
    'Attributes: class, title, role, lang, dir, hidden, aria-*, data-state, a style without url() or quotes; colspan/rowspan on cells; on svg shapes the geometry and paint attributes (viewBox, x, y, width, height, cx, cy, r, d, points, transform, fill, stroke, stroke-width, opacity, font-size, text-anchor…).',
    'Dynamic parts are formulas in the app\'s expression language: {{ formula }} in a text is written as TEXT (never markup); data-if="formula" draws an element only when truthy; data-each="formula as row" repeats an element per list entry (the entry is `row`, or `item` without "as"; `index` counts from 0). {{ }} also works inside class, title, aria-*, data-state and the svg geometry and paint attributes.',
    'A formula sees ONLY the inputs: block.inputs is { name: <binding> }, any binding kind (records, record, aggregate, formula, static…), resolved by the app for the current viewer. It cannot read variables, currentUser or records by itself: pass each as an input.',
    'Interaction: <button data-emit="pick" data-value="row.id">…</button> raises the event "pick"; block.events is { pick: "<actionId>" } and the action reads the data-value result as `value`. In the editor and in a screenshot no action runs.',
    'Pictures: draw them as inline svg, or as a data:image/… background in css. A block cannot show an uploaded file or an address.',
    'css: a stylesheet for this block alone (same rules as the app stylesheet, url() only with data:image/…). The app\'s look is there as CSS variables: --bf-primary, --bf-primary-contrast, --bf-accent, --bf-background, --bf-surface, --bf-text, --bf-text-muted, --bf-border, --bf-radius, --bf-font; html[data-appearance="dark"] marks a dark app.',
    'Height follows the content (24..4000 px); set the `height` style knob for a fixed box that scrolls.',
    'Example: block { "template": "<ul class=\\"list\\"><li data-each=\\"rows as r\\"><strong>{{ r.name }}</strong> <button data-emit=\\"pick\\" data-value=\\"r.id\\">Open</button></li></ul>", "css": ".list{list-style:none;padding:0}li{padding:8px;border-bottom:1px solid var(--bf-border)}", "inputs": { "rows": { "kind": "records", "tableId": "tbl_…" } }, "events": { "pick": "act_…" } }.',
].join(' ');

module.exports = {
    since: 3,
    mobile: { reason: 'A custom block is drawn in a sealed browser frame; the phone has none.' },
    parts: ['root', 'frame', 'notice'],
    label: 'Custom block', category: 'Content',
    description: CONTRACT,
    props: {
        block: {
            type: 'object',
            objectShape: 'customBlock',
            since: 3,
            description: 'The block itself: { template, css, inputs, events }. '
                + 'template is the HTML template, css its stylesheet, inputs { name: binding } the values its formulas see, '
                + 'events { name: actionId } the actions its buttons run. Edit it with app_edit_block.',
        },
    },
    styleKnobs: ['span', 'height'],
    defaultStyle: { span: 12 },
};

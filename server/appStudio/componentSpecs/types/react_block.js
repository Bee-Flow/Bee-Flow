// @typecheck strict
/**
 * App Studio catalog: `react_block`, a React component (one TSX file) the builder writes, drawn
 * in a sealed frame.
 *
 * The web runtime draws it in `<iframe sandbox="allow-scripts">` (no same-origin, no popups, no
 * navigation of the page, no forms) whose document carries a policy that loads nothing and
 * connects nowhere (agent-hub …/runtime/components/reactBlock/). App data enters only as the
 * block's declared inputs, posted into the frame; only declared events come out. Everything is
 * in one prop, `block`, cleaned by customBlock/reactBlockShape.mts; app_edit_react_block writes
 * it and compiles the source (shared/cmsReact/compile.mjs).
 */

'use strict';

const CONTRACT = [
    'A React component (TSX) with its own state, in a sealed frame.',
    'Use it LAST: the catalogue first, then custom_block (HTML without script); react_block ONLY for interactivity with its own state that neither can draw (a simulator, a calculator with sliders, an interactive chart). Never for data entry: inputs belong in a form with input_* components, and a react_block cannot write a record itself.',
    'Everything is in props.block: { source, css, inputs, events }. Write it with app_edit_react_block, which compiles the source on every save and answers with compileError and diagnostics: fix them until it compiles.',
    'source: ONE file with a default export, e.g. export default function Sim({ rate, emit }) { … }. It may import only react, react/jsx-runtime, react-dom and react-dom/client. Hooks (useState, useMemo, useEffect) work as usual.',
    'Props: each input by its name, resolved by the app for the current viewer, plus emit(event, value). block.inputs is { name: <binding> }, any binding kind (records, record, aggregate, formula, static…). The component sees ONLY its inputs: pass variables, currentUser or rows as inputs. An input cannot be named emit, children, key or ref.',
    'Interaction: emit("pick", value) raises the event "pick"; block.events is { pick: "<actionId>" } and the action reads the value as `value` (plain JSON, at most 16 KB). An event that is not in block.events is ignored. In the editor and in a screenshot no action runs.',
    'The frame is sealed: no fetch, XHR, WebSocket or beacon, no external script, stylesheet, image or font (only data: images and fonts), no cookies or storage, no popups and no navigation. Draw pictures as inline svg or data: images.',
    'css: a stylesheet for this block alone (url() only with data:image/…). The app\'s look is there as CSS variables: --bf-primary, --bf-primary-contrast, --bf-accent, --bf-background, --bf-surface, --bf-text, --bf-text-muted, --bf-border, --bf-radius, --bf-font.',
    'Height follows the content; set the `height` style knob for a fixed box.',
    'Example: block { "source": "import { useState } from \'react\';\\nexport default function Sim({ start, emit }) { const [n, setN] = useState(start ?? 0); return <div className=\\"sim\\"><input type=\\"range\\" min={0} max={100} value={n} onChange={(e) => setN(Number(e.target.value))} /><p>{n}</p><button onClick={() => emit(\'pick\', n)}>Use</button></div>; }", "inputs": { "start": { "kind": "static", "value": 20 } }, "events": { "pick": "act_…" } }.',
].join(' ');

module.exports = {
    since: 3,
    mobile: { reason: 'A React block runs in a sealed browser frame; the phone has none.' },
    parts: ['root', 'notice'],
    label: 'React block', category: 'Content',
    description: CONTRACT,
    props: {
        block: {
            type: 'object',
            objectShape: 'reactBlock',
            since: 3,
            description: 'The React block itself: { source, css, inputs, events }. '
                + 'source is one TSX file with a default export, css its stylesheet, inputs { name: binding } the props it receives, '
                + 'events { name: actionId } the actions emit(name, value) runs. Edit it with app_edit_react_block.',
        },
    },
    styleKnobs: ['span', 'height'],
    defaultStyle: { span: 12 },
};

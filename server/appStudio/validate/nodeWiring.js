// @typecheck strict
/**
 * App Studio validator — two parts of the per-node walk (validateNode,
 * nodes.js): the action wiring a node carries (its events and its per-row
 * action lists, which must name real actions), and the advisories for a
 * node that validates and still does not work on screen (a pane that clips,
 * a control wired to nothing, a form whose Submit does nothing).
 */

'use strict';

const { EVENT_NAMES } = require('../componentSpecs');
const { isObject, pickClosestId } = require('./shared');

// How many children a non-scrolling pane may stack before the ones at the
// bottom are, in practice, off screen. Six is roughly a header + a control row +
// content + a footer; past that something has to scroll or fill.
const PANE_CLIP_CHILDREN = 6;

/**
 * @typedef {import('./shared').ValidationCtx} ValidationCtx
 * @typedef {import('./nodes').ComponentSpec} ComponentSpec
 * @typedef {{ id?: unknown, type?: unknown, children?: unknown, onClick?: unknown, onSubmit?: unknown,
 *   [event: string]: unknown }} NodeShape  one authored component as the walk reads it (untrusted)
 */

/**
 * Events — only on types whose spec allows them, and each must resolve to an
 * action. Per-row actions (data_grid rowActions / repeater itemActions, bulk
 * and toolbar actions) are UI wiring exactly like events: the runtime runs
 * their actionId on click, so an unknown one would validate clean and render a
 * button that silently does nothing (and feed garbage into the reached-set).
 * Empty string stays legal there: it is the inspector's deliberate "not wired
 * yet" state, guarded at runtime.
 * @param {NodeShape} node
 * @param {string} path
 * @param {Record<string, unknown>} props
 * @param {ComponentSpec} spec
 * @param {ValidationCtx} ctx
 */
function checkActionWiring(node, path, props, spec, ctx) {
    const { pushE, actionIds } = ctx;
    for (const ev of EVENT_NAMES) {
        const ref = node[ev];
        if (ref === undefined || ref === null) continue;
        if (!Array.isArray(spec.events) || !spec.events.includes(ev)) {
            pushE({ code: 'event.not_supported', severity: 'error', path: `${path}.${ev}`, message: `${node.type} does not support ${ev}.`, hint: spec.events && spec.events.length ? `${node.type} supports: ${spec.events.join(', ')}.` : `${node.type} carries no events; wire the action to a button or form instead.` });
        }
        if (typeof ref !== 'string' || !actionIds.has(ref)) {
            const suggestion = pickClosestId(String(ref), Array.from(actionIds));
            pushE({ code: 'event.action_unresolved', severity: 'error', path: `${path}.${ev}`, message: `${ev} references unknown action ${JSON.stringify(ref)}.`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Add the action to definition.actions first.' });
        }
    }

    for (const listKey of ['rowActions', 'itemActions', 'bulkActions', 'toolbarActions']) {
        const entries = props[listKey];
        if (!Array.isArray(entries)) continue;
        entries.forEach((entry, i) => {
            const ref = isObject(entry) ? entry.actionId : undefined;
            if (ref === undefined || ref === null || ref === '') return;
            if (typeof ref !== 'string' || !actionIds.has(ref)) {
                const suggestion = pickClosestId(String(ref), Array.from(actionIds));
                pushE({ code: 'event.action_unresolved', severity: 'error', path: `${path}.props.${listKey}[${i}].actionId`, message: `${listKey} references unknown action ${JSON.stringify(ref)}.`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Add the action to definition.actions first.' });
            }
        });
    }
}

/**
 * The warnings for a node that validates and still does not work on screen.
 * @param {NodeShape} node
 * @param {string} path
 * @param {Record<string, unknown>} props
 * @param {unknown} formId  the id of the form the node sits in, if any
 * @param {ValidationCtx} ctx
 */
function checkNodeAdvisories(node, path, props, formId, ctx) {
    checkPaneClips(node, path, props, ctx);
    checkInertButton(node, path, props, formId, ctx);
    checkFormSubmit(node, path, props, ctx);
}

/**
 * A pane that clips. `scroll:'none'` means "everything fits"; a stack of a
 * dozen children in a fixed-height pane does not, and the pane's own
 * overflow:hidden silently eats the bottom of it — with eleven children under
 * scroll:'none' a reply composer is simply not on screen, and nothing in the
 * definition says so.
 * @param {NodeShape} node
 * @param {string} path
 * @param {Record<string, unknown>} props
 * @param {ValidationCtx} ctx
 */
function checkPaneClips(node, path, props, ctx) {
    if (node.type !== 'pane' || !Array.isArray(node.children)) return;
    const scroll = props.scroll ?? 'none';
    const fills = node.children.filter((c) => isObject(c) && c.style && c.style.height === 'fill').length;
    if (scroll === 'none' && node.children.length > PANE_CLIP_CHILDREN && fills === 0) {
        ctx.pushW({
            code: 'component.pane_clips', severity: 'warning', path,
            message: `This pane stacks ${node.children.length} components with scroll "none" and nothing set to fill — the ones at the bottom are cut off.`,
            hint: 'Set scroll to "auto", give one child height "fill", or split the pane.',
        });
    }
}

/**
 * A control that demonstrably does nothing. A button with no onClick and no
 * submit role renders, looks primary, and is inert — the single loudest
 * signal that a screen was generated rather than designed.
 *
 * role "submit" only excuses a button that is actually INSIDE a form: the
 * runtime gives it type="submit" and no onClick, so one placed in a page
 * header (next to the form, not in it) has no form to submit and is exactly
 * as dead as the case above — and is flagged the same way.
 *
 * This is the one app-validator record that reaches the shared "needs
 * attention" list (core/findings/finding.js), so it carries the two Finding
 * fields on top of the legacy ones: `kind` drives the tinted glyph, and
 * `targetRef` is where "Show me" goes. The validator only ever sees a
 * definition — the app id is whatever the caller threaded in as
 * ctx.target ({ id, title }), else null.
 * @param {NodeShape} node
 * @param {string} path
 * @param {Record<string, unknown>} props
 * @param {unknown} formId
 * @param {ValidationCtx} ctx
 */
function checkInertButton(node, path, props, formId, ctx) {
    if (node.type !== 'button' || node.onClick || (props.role === 'submit' && formId)) return;
    ctx.pushW({
        code: 'component.control_inert', severity: 'warning', path,
        kind: 'app',
        targetRef: {
            kind: 'app',
            id: ctx.target?.id ?? null,
            ...(ctx.target?.title ? { title: ctx.target.title } : {}),
            path,
            nodeId: typeof node.id === 'string' ? node.id : null,
        },
        message: props.role === 'submit'
            ? 'This submit button sits outside a form — there is nothing for it to submit.'
            : 'This button is wired to nothing — clicking it does nothing at all.',
        hint: props.role === 'submit'
            ? 'Move it inside the form component, or set onClick to an action.'
            : 'Set onClick to an action, or give it role "submit" inside a form.',
    });
}

/**
 * A form whose built-in submit button is shown but wired to nothing. The
 * dangling case cannot ship (event.action_unresolved is an error), so this is
 * the one that reaches a viewer: they fill the fields, click Submit and
 * nothing happens, with nothing on screen to explain it.
 * @param {NodeShape} node
 * @param {string} path
 * @param {Record<string, unknown>} props
 * @param {ValidationCtx} ctx
 */
function checkFormSubmit(node, path, props, ctx) {
    if (node.type === 'form' && !node.onSubmit && props.showSubmit !== false) {
        ctx.pushW({
            code: 'form.no_submit_action', severity: 'warning', path,
            message: 'This form shows a Submit button but has no onSubmit action — clicking it does nothing.',
            hint: 'Wire onSubmit to an action, or set showSubmit to false if the fields save themselves.',
        });
    }
}

module.exports = { checkActionWiring, checkNodeAdvisories, PANE_CLIP_CHILDREN };

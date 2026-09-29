/**
 * The pre-flight check's findings, in the shape the publish modal already
 * renders.
 *
 * appDryRun answers four questions the static validator cannot: does this
 * binding actually return anything, would a member with this role see an empty
 * screen, does this sequence step write a column that exists, is a table empty.
 * It has existed since Wave 4 and only the AI builder could reach it, so a
 * person building by hand found out by publishing and clicking through the app.
 *
 * Its output is four differently-shaped arrays plus a bag of `_hints` strings.
 * The modal already knows how to draw `{ severity, message, hint, path }`
 * issues — including resolving one back to the component it points at — so this
 * translates rather than adding a second way to show a problem.
 *
 * → { errors, warnings } of issue objects. `nodeId` rides along so the modal's
 * "Show me" can jump to a component the validator never named a path for.
 */

import { resolveTarget } from '../../../../shared/resolveTarget';

/**
 * The stand-in for t() when a caller has none: `nodeLabel` is exported and the
 * shared resolveTarget test calls it two-arg. Same contract as useTranslation's
 * `t(key, english, params)` — it hands back the English and fills the
 * {placeholders} in, so an issue reads exactly as it did before this module
 * learned to translate. The sibling editor/nodeLogicSummary.js carries the same
 * stand-in, for the same reason.
 */
const EN_ONLY = (key, en, params) => (params && typeof params === 'object'
    ? Object.entries(params).reduce(
        (out, [k, v]) => out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
        String(en),
    )
    : en);

/** An issue the panel can draw. `code` is only used as a React key hint. */
function issue({ code, message, hint = null, nodeId = null, path = null, severity }) {
    return { code, message, hint, nodeId, path, severity };
}

/**
 * "Order list" rather than "cmp_9f2" when the definition still has the node.
 * The id → node walk is shared/resolveTarget.js (the same resolver "Show me"
 * uses, other direction); this only decides how the label reads in a
 * sentence — a node's own words in quotes, its type bare, the id as a last
 * resort.
 */
export function nodeLabel(definition, nodeId, t = EN_ONLY) {
    if (!nodeId) return t('app_studio.publish.issue_component', 'A component');
    const hit = resolveTarget(definition, { nodeId, kind: 'app' });
    if (!hit?.label) return nodeId;
    return hit.labelIsText ? `“${hit.label}”` : hit.label;
}

export default function dryRunIssues(result, definition = null, t = EN_ONLY) {
    const errors = [];
    const warnings = [];
    if (!result || typeof result !== 'object') return { errors, warnings };

    // 1. The static pass is already in the right shape — pass it straight
    //    through so a publish blocker reads identically here and there.
    for (const e of asList(result.static?.errors)) errors.push({ ...e, severity: 'error' });
    for (const w of asList(result.static?.warnings)) warnings.push({ ...w, severity: 'warning' });

    // 2. Bindings that were actually EXECUTED. A failure here is a screen that
    //    will not load; zero rows is only worth a warning, because a demo table
    //    nobody has seeded yet is normal and must never block a publish.
    for (const b of asList(result.bindings)) {
        const who = nodeLabel(definition, b.nodeId, t);
        if (b.ok === false) {
            errors.push(issue({
                code: 'dryrun.binding_failed',
                severity: 'error',
                nodeId: b.nodeId,
                message: t('app_studio.publish.issue_binding_failed', '{who} could not load its data.', { who }),
                hint: b.error || t('app_studio.publish.issue_binding_failed_hint', 'Open the component and check where its data comes from.'),
            }));
        } else if (b.rowCount === 0 && !b.skipped) {
            warnings.push(issue({
                code: 'dryrun.binding_empty',
                severity: 'warning',
                nodeId: b.nodeId,
                message: t('app_studio.publish.issue_binding_empty', '{who} shows nothing right now — it found no rows.', { who }),
                hint: b.kind === 'dataset'
                    ? t('app_studio.publish.issue_binding_empty_hint_view', 'The saved view is empty: add rows to the table behind it, or loosen its filters.')
                    : t('app_studio.publish.issue_binding_empty_hint', 'Add some rows to the table, or loosen the filter on this component.'),
            }));
        }
    }

    // 3. What a member with the previewed role would see. An empty screen for
    //    everyone but the owner is the classic one nobody catches before
    //    somebody else opens the app.
    for (const f of asList(result.roleFindings)) {
        if (f.rowCount !== 0) continue;
        warnings.push(issue({
            code: 'dryrun.role_empty',
            severity: 'warning',
            nodeId: f.nodeId,
            message: t(
                'app_studio.publish.issue_role_empty',
                'Someone with the “{role}” role would see nothing in {node}.',
                { role: f.role, node: nodeLabel(definition, f.nodeId, t) },
            ),
            // Two whole sentences, not one sentence plus a capital letter: the
            // note-prefixed form lowercases "check", which is English grammar
            // no translation can rebuild from a fragment.
            hint: f.note
                ? t(
                    'app_studio.publish.issue_role_empty_note',
                    "{note} — check that role's access to the table, or share the rows with everyone in the app.",
                    { note: f.note },
                )
                : t('app_studio.publish.issue_role_empty_hint', "Check that role's access to the table, or share the rows with everyone in the app."),
        }));
    }

    // 4. Mutating steps, checked against the data model without running them.
    //    A step writing a column that does not exist fails at the moment
    //    somebody clicks the button, which is the worst time to find out.
    for (const a of asList(result.actions)) {
        if (a.ok !== false) continue;
        errors.push(issue({
            code: 'dryrun.step_invalid',
            severity: 'error',
            message: t(
                'app_studio.publish.issue_step',
                'A step in this app’s logic cannot run: {step}.',
                { step: a.step || t('app_studio.publish.issue_step_fallback', 'a step') },
            ),
            // runActionPass reports STRINGS here, not issue objects.
            hint: reasons(a.errors) || t('app_studio.publish.issue_step_hint', 'Open the action and check the table and columns it writes to.'),
        }));
    }

    return { errors, warnings };
}

function asList(v) {
    return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [];
}

function reasons(v) {
    return (Array.isArray(v) ? v : []).filter((s) => typeof s === 'string' && s.trim()).join('; ');
}

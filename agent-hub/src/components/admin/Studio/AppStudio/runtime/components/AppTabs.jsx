import { tryEvaluate } from '@shared/expr/engine.mjs';
import React, { useEffect, useEffectEvent, useState } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import AppIcon from '../../../../../icons/AppIcon';
import { useFormContext } from '../formContext';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { isFill, ROLE_COLORS, roleTextColor } from '../styleResolver';

/**
 * App Studio runtime — 'tabs' (container). Spec: server/appStudio/componentSpecs.js.
 *
 * Renders a token-themed tab strip from its `tab` children and shows the active
 * tab's content. The labels come from the raw child node definitions
 * (node.children[i].props.label); the actual tab bodies are the already-rendered
 * child elements passed in `children`. Run mode switches on click; edit mode
 * uses the same active-index state so any tab can be selected and edited.
 *
 * The strip applies the SAME gates AppRenderer applies to the panel it would
 * render (visible/visibleWhen + the view-as-role gate) — otherwise a hidden or
 * role-gated tab keeps a clickable button that opens an empty panel. Gate
 * formulas evaluate against the runtime scope, so a tab group repeated per row
 * sees the base scope here and not the row's `item`.
 *
 * ── WHY EVERY PANEL IS MOUNTED, NOT JUST THE ACTIVE ONE ─────────────
 * Only the active panel used to render. Inside a form that is a data-integrity
 * bug, not a rendering choice: a required field on tab 2 never registered, so
 * submitting from tab 1 skipped it entirely and the record was created without
 * the mandatory value — silently, with no error anywhere. The mirror case was
 * just as bad: a value typed on tab 2 survived in the form's values and was
 * submitted, while its rules unregistered with the panel and stopped being
 * checked. So the panels all mount and the inactive ones are hidden.
 *
 * A field that the AUTHOR hid (visible/visibleWhen false) still unmounts in
 * AppRenderer and its rules still stay inert — that contract is unchanged. A
 * tab is not hidden, it is merely not on top.
 *
 * Data cost is nil: AppDataScope already scans the whole SCREEN and fetches
 * every binding on it, regardless of which tab is showing.
 *
 * ── height:'fill' ───────────────────────────────────────────────────
 * A tab group is where a full-height chain used to die: the strip sat in a
 * plain block, so however much room the pane handed down, the panel below it
 * was content-height and every tabbed work surface had to guess a pixel number
 * for its tallest child — leaving dead space under it on a large monitor.
 * Filling makes the root a flex COLUMN: the strip keeps its own size (shrink-0)
 * and the panels take the rest. Inactive panels are display:none, so the class
 * can go on all of them; only the visible one is ever a flex item.
 */

/** Mirror of AppRenderer's roleAllows — a tab gated away from the previewed role. */
function roleAllows(tab, previewRole) {
    if (!previewRole || previewRole === 'owner') return true;
    const gate = tab && tab.visibleToRoles;
    if (!Array.isArray(gate) || gate.length === 0) return true;
    return gate.includes(previewRole);
}

/**
 * The rendered text of a tab badge (spec: tab.badge), or null to show nothing.
 * Empty/zero counts stay silent — a "0" pill on every quiet tab is noise —
 * and objects/arrays never render (a binding that resolved to a row is a
 * config mistake, not a label).
 */
export function tabBadgeContent(raw) {
    if (raw == null || raw === false || raw === '') return null;
    if (typeof raw === 'object') return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n === 0) return null;
    return String(raw);
}

/** Mirror of AppRenderer's evalVisibility — visibleWhen wins over `visible`. */
function isHidden(tab, scope) {
    if (typeof tab.visibleWhen === 'string' && tab.visibleWhen.trim()) {
        return !tryEvaluate(tab.visibleWhen, scope).value;
    }
    const v = tab.visible;
    if (v === false) return true;
    if (v && typeof v === 'object') {
        const expr = v.expr ?? v.value;
        if (typeof expr === 'string' && expr.trim()) return !tryEvaluate(expr, scope).value;
    }
    return false;
}

export default function AppTabs({ node, children }) {
    const { t } = useTranslation();
    const { mode, selectedNodeId, previewRole, scope, actionState, dataState } = useRuntime();
    const form = useFormContext();
    const fill = isFill(node);
    const tabs = Array.isArray(node.children) ? node.children : [];
    const rendered = React.Children.toArray(children);
    const [active, setActive] = useState(0);

    // An error on a panel the viewer is not looking at is an error they cannot
    // see, so a failed submit surfaces the tab that holds the first bad field.
    const errorNames = form?.errors
        ? Object.keys(form.errors).filter((k) => form.errors[k])
        : [];
    const errorKey = errorNames.join('\u0000');
    const revealErrorTab = useEffectEvent((names) => {
        setActive((current) => {
            if (tabs[current] && containsFieldName(tabs[current], names)) return current;
            const owner = tabs.findIndex((t) => containsFieldName(t, names));
            return owner === -1 ? current : owner;
        });
    });
    useEffect(() => {
        if (!errorKey) return;
        revealErrorTab(new Set(errorKey.split('\u0000')));
    }, [errorKey]);

    if (tabs.length === 0) {
        return (
            <div className="text-sm py-2" style={{ color: 'var(--text-muted)' }}>
                {t('studio_apps_runtime.tabs.add_tab', 'Add a tab to this tab group.')}
            </div>
        );
    }

    // Indices into `tabs` (and `rendered` — the renderer emits one element per
    // definition, hidden or not) that the viewer may actually reach. Hidden tabs
    // survive in edit mode, exactly like a hidden node on the canvas.
    const shown = tabs
        .map((tab, i) => i)
        .filter((i) => roleAllows(tabs[i], previewRole) && (mode === 'edit' || !isHidden(tabs[i], scope)));
    if (shown.length === 0) return null;

    // If a node inside a particular tab is selected on the canvas, surface that
    // tab so the inspector edits what the user clicked.
    let activeIdx = shown.includes(active) ? active : shown[0];
    if (selectedNodeId) {
        const idx = shown.find((i) => tabs[i].id === selectedNodeId || containsNode(tabs[i], selectedNodeId));
        if (idx !== undefined) activeIdx = idx;
    }

    // Look pass (spec: tabs.look = underline | pills | boxed). 'underline' —
    // and any unknown value — is the identity path: the exact class strings
    // and style objects from before the look existed.
    const look = node.props?.look === 'pills' || node.props?.look === 'boxed' ? node.props.look : 'underline';
    // Motion rides the app tokens, so .app-motion--none and reduced-motion
    // zero it (see app-tokens.css) — never a fixed duration.
    const tabTransition = 'background-color var(--app-motion-fast, 0ms) var(--app-ease, ease-out), '
        + 'color var(--app-motion-fast, 0ms) var(--app-ease, ease-out)';

    // Pills wrap onto a second line; underline and boxed cannot — a folder tab
    // that wrapped would sit above the rule it is supposed to be joined to. So
    // those two scroll sideways instead, which is what a narrow screen needs
    // anyway: five tabs squeezed into 380px are five unreadable tabs, and a
    // strip that scrolls at least keeps each label whole.
    const stripCls = look === 'pills'
        ? 'flex flex-wrap items-center gap-1.5'
        : look === 'boxed'
            ? 'flex items-end gap-1 overflow-x-auto app-scroll-x'
            : 'flex items-center gap-1 border-b overflow-x-auto app-scroll-x';
    const stripStyle = look === 'pills'
        ? undefined
        : look === 'boxed'
            ? { borderBottom: '1px solid var(--border-default)' }
            : { borderColor: 'var(--border-default)' };

    const tabButton = (isActive) => {
        if (look === 'pills') {
            return {
                className: 'inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full',
                style: isActive
                    ? { background: 'var(--app-primary-soft)', color: 'var(--app-primary)', transition: tabTransition }
                    : { background: 'transparent', color: 'var(--text-secondary)', transition: tabTransition },
            };
        }
        if (look === 'boxed') {
            // Folder tabs: the active one carries the bar's border and opens
            // at the bottom (-mb-px over the strip rule) so it reads as joined
            // to the panel below it.
            const corners = {
                borderTopLeftRadius: 'var(--app-radius)',
                borderTopRightRadius: 'var(--app-radius)',
                transition: tabTransition,
            };
            return {
                className: 'inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-3 py-2 text-sm font-medium -mb-px border',
                style: isActive
                    ? {
                        ...corners,
                        background: 'var(--bg-card)',
                        color: 'var(--app-primary)',
                        borderColor: 'var(--border-default)',
                        borderBottomColor: 'transparent',
                    }
                    : { ...corners, background: 'transparent', color: 'var(--text-secondary)', borderColor: 'transparent' },
            };
        }
        // 'underline' — identity.
        return {
            className: 'inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-3 py-2 text-sm font-medium -mb-px',
            style: isActive
                ? { color: 'var(--app-primary)', borderBottom: '2px solid var(--app-primary)' }
                : { color: 'var(--text-secondary)', borderBottom: '2px solid transparent' },
        };
    };

    return (
        <div
            className={`w-full min-w-0${fill ? ' app-fill flex flex-col h-full min-h-0' : ''}`}
            data-app-tabs="true"
            data-app-tabs-look={look === 'underline' ? undefined : look}
        >
            <div
                role="tablist"
                aria-label={t('studio_apps_runtime.tabs.label', 'Tabs')}
                className={fill ? `${stripCls} shrink-0` : stripCls}
                style={stripStyle}
            >
                {shown.map((i) => {
                    const tab = tabs[i];
                    const isActive = i === activeIdx;
                    const label = tab.props?.label || t('studio_apps_runtime.tabs.tab_n', 'Tab {n}', { n: i + 1 });
                    const button = tabButton(isActive);
                    // Badge (spec: tab.badge/badgeTone). The strip reads raw
                    // child defs, so the binding resolves HERE, against the
                    // base runtime scope — same rule as the visibility gates.
                    const badge = tabBadgeContent(
                        resolveBinding(tab.props?.badge, { actionState, dataState, scope }).value,
                    );
                    const badgeTone = ROLE_COLORS[tab.props?.badgeTone] && tab.props?.badgeTone !== 'neutral'
                        ? tab.props.badgeTone
                        : 'neutral';
                    return (
                        <button
                            key={tab.id || i}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            onClick={() => setActive(i)}
                            className={button.className}
                            style={button.style}
                        >
                            {tab.props?.icon ? <AppIcon name={tab.props.icon} className="w-3.5 h-3.5" /> : null}
                            <span>{label}</span>
                            {badge === null ? null : badgeTone === 'neutral' ? (
                                <span
                                    className="text-xs font-normal"
                                    style={{ color: 'var(--text-muted)' }}
                                    data-app-tab-badge="neutral"
                                >
                                    {badge}
                                </span>
                            ) : (
                                <span
                                    className="inline-flex items-center rounded-full px-1.5 font-medium leading-none"
                                    style={{
                                        height: '17px',
                                        fontSize: '11px',
                                        background: `color-mix(in srgb, ${ROLE_COLORS[badgeTone]} 16%, transparent)`,
                                        color: roleTextColor(badgeTone),
                                    }}
                                    data-app-tab-badge={badgeTone}
                                >
                                    {badge}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
            {shown.map((i) => (
                <div
                    key={tabs[i].id || i}
                    role="tabpanel"
                    // A filled panel owns its own scrolling, the way a pane
                    // with scroll "auto" does: without it a tab whose content
                    // names a fixed height taller than the leftover space
                    // would paint straight out of the box it was given.
                    className={fill ? 'pt-3 flex flex-col flex-1 min-h-0 overflow-auto' : 'pt-3'}
                    // `hidden` (not unmounting) keeps the panel's fields
                    // registered with the enclosing form; it also takes the
                    // subtree out of the accessibility tree and the tab order,
                    // so nothing off-panel is reachable.
                    hidden={i !== activeIdx}
                    style={i === activeIdx ? undefined : { display: 'none' }}
                    data-app-tabpanel={i === activeIdx ? 'active' : 'inactive'}
                >
                    {rendered[i] ?? null}
                </div>
            ))}
        </div>
    );
}

/** Depth-first: does the container subtree hold a node with this id? */
function containsNode(node, id) {
    const kids = Array.isArray(node?.children) ? node.children : [];
    for (const child of kids) {
        if (child.id === id) return true;
        if (containsNode(child, id)) return true;
    }
    return false;
}

/** Depth-first: does the subtree hold an input registered under one of these names? */
function containsFieldName(node, names) {
    const kids = Array.isArray(node?.children) ? node.children : [];
    for (const child of kids) {
        if (child?.props?.name && names.has(child.props.name)) return true;
        if (containsFieldName(child, names)) return true;
    }
    return false;
}

import { tryEvaluate } from '@shared/expr/engine.mjs';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { ROLE_COLORS, roleFillContrast } from '../styleResolver';
import { EmptyText, ErrorText, SkeletonLines, displayValue , useStickyBinding } from '../uiBits';

/**
 * App Studio runtime — 'badge_list'. Spec: server/appStudio/componentSpecs.js.
 * A wrapping row of badges over an array of objects. colorMap assigns a
 * COLOR_ROLES role per matched value (matched against colorKey's value, or the
 * label itself when colorKey is unset), and a readable LABEL for it.
 *
 * With `countKey` and an aggregate binding this is the status-pill row: the
 * count-per-status is computed in SQL, and until now the number came back and
 * was thrown away, so the pills were decoration over a query that had the
 * answer. With onRowClick they also replace a status dropdown in a filter bar —
 * one click instead of open-scroll-pick.
 */

const ALIGN_JUSTIFY = { start: 'justify-start', center: 'justify-center', end: 'justify-end' };

export default function AppBadgeList({ node }) {
    const { actionState, dataState, scope, runAction, mode } = useRuntime();
    const {
        labelKey = 'label', colorKey = null, countKey = null, colorMap = [],
        activeWhen = null, emptyText = 'Nothing to show yet.',
    } = node.props || {};
    const { value: source, isLoading, error, errorCode } = useStickyBinding(
        resolveBinding(node.props?.source, { actionState, dataState, scope }),
    );

    if (error) return <ErrorText error={error} errorCode={errorCode} />;

    if (isLoading) return <SkeletonLines lines={1} />;

    // Tolerate an array of plain strings as well as objects.
    const items = (Array.isArray(source) ? source : []).filter((x) => x != null);
    if (items.length === 0) return <EmptyText text={emptyText} />;

    const size = node.style?.size || 'md';
    const sizeCls = size === 'sm' ? 'text-[11px] px-1.5 py-0.5' : size === 'lg' ? 'text-sm px-2.5 py-1' : 'text-xs px-2 py-0.5';
    // `align` was declared in the spec and ignored here, so a right-aligned
    // action row was unreachable and authors reached for a new component type.
    const justify = ALIGN_JUSTIFY[node.style?.align] || ALIGN_JUSTIFY.start;

    const map = Array.isArray(colorMap) ? colorMap : [];
    const mappingFor = (raw) => map.find((m) => m && String(m.value) === String(raw)) || null;

    // Look pass (spec: badge_list.look = soft | outline | solid). 'soft' — and
    // any unknown value — is the identity path: the exact 12%-wash swatches
    // from before the look existed.
    const look = node.props?.look === 'outline' || node.props?.look === 'solid' ? node.props.look : 'soft';
    // `effLook` is the row's look — `look`, unless activeWhen matches, which
    // forces that one pill solid so a pill row reads as a visible filter state.
    const swatchFor = (color, role, effLook) => {
        if (effLook === 'outline') {
            // Transparent pills: the role speaks through border + text alone.
            return color
                ? { color, borderColor: 'currentColor', background: 'transparent' }
                : { color: 'var(--text-secondary)', borderColor: 'var(--border-default)', background: 'transparent' };
        }
        if (effLook === 'solid') {
            // Filled pills with contrast text. Primary follows the theme, so
            // its contrast token answers; the fixed status hexes use the
            // platform's roleFillContrast. Neutral has no fixed fill color
            // (its role color is a theme-dependent text token), so it becomes
            // the inverted chip — readable in every host theme.
            if (color && role !== 'neutral') {
                return {
                    background: color,
                    color: role === 'primary' ? 'var(--app-primary-contrast)' : roleFillContrast(role),
                    borderColor: 'transparent',
                };
            }
            return { background: 'var(--text-primary)', color: 'var(--bg-primary)', borderColor: 'transparent' };
        }
        // 'soft' — identity.
        return color
            ? { color, borderColor: 'color-mix(in srgb, currentColor 35%, transparent)', background: 'color-mix(in srgb, currentColor 12%, transparent)' }
            : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', borderColor: 'var(--border-default)' };
    };

    const clickable = mode === 'run' && !!node.onRowClick;
    // `formValues`, matching list/timeline/data_grid/kanban — the action reads
    // the clicked row as `form.*`. A second convention here would mean every
    // action that fires from two components needed two spellings.
    const fire = (item) => {
        if (!clickable) return;
        runAction(node.onRowClick, (item && typeof item === 'object')
            ? { formValues: item, item }
            : { formValues: { value: item }, item, value: item });
    };

    return (
        <div
            className={`flex flex-wrap items-center gap-1.5 ${justify}`}
            data-app-badgelist="true"
            data-app-badgelist-look={look === 'soft' ? undefined : look}
        >
            {items.map((item, i) => {
                const rawLabel = typeof item === 'object' ? walkPath(item, labelKey) : item;
                const matchOn = (typeof item === 'object' && colorKey) ? walkPath(item, colorKey) : rawLabel;
                const mapping = mappingFor(matchOn);
                // A pill grouped by a status COLUMN reads the stored value —
                // "awaiting_user" — unless the map supplies human copy.
                const label = mapping?.label || displayValue(rawLabel);
                const count = (countKey && typeof item === 'object') ? walkPath(item, countKey) : null;
                const role = mapping?.color || null;
                const color = role ? ROLE_COLORS[role] : null;
                const active = activeWhen
                    ? !!tryEvaluate(String(activeWhen), { ...scope, item, index: i }).value
                    : false;
                const swatch = swatchFor(color, role, active ? 'solid' : look);

                // No count → the label is the badge's only text node, exactly as
                // before. Wrapping it unconditionally would break every
                // getByText() that expects to land on the badge itself.
                const hasCount = count !== null && count !== undefined && count !== '';
                const body = hasCount
                    ? <>{label}<span className="ml-1.5 tabular-nums opacity-70">{displayValue(count)}</span></>
                    : label;

                return clickable ? (
                    <button
                        key={i}
                        type="button"
                        onClick={() => fire(item)}
                        className={`inline-flex items-center rounded-full font-medium border transition-opacity hover:opacity-80 cursor-pointer ${sizeCls}`}
                        data-badge-role={role || undefined}
                        data-badge-active={active || undefined}
                        style={swatch}
                    >
                        {body}
                    </button>
                ) : (
                    <span
                        key={i}
                        className={`inline-flex items-center rounded-full font-medium border ${sizeCls}`}
                        data-badge-role={role || undefined}
                        data-badge-active={active || undefined}
                        style={swatch}
                    >
                        {body}
                    </span>
                );
            })}
        </div>
    );
}

import { tryEvaluate } from '@shared/expr/engine.mjs';
import { Loader2 } from 'lucide-react';
import AppIcon from '../../../../../icons/AppIcon';
import { useFormContext } from '../formContext';
import { useRuntime } from '../RuntimeContext';

/** App Studio runtime — 'button'. Spec: server/appStudio/componentSpecs.js. */

const VARIANT_STYLES = {
    // The call-to-action paints with the ACCENT family (themeVars.js), which
    // is the primary family unless the theme chose otherwise — so a brand
    // with green buttons and blue headings is one theme knob, not a variant.
    primary: { background: 'var(--app-accent, var(--app-primary))', color: 'var(--app-accent-contrast, var(--app-primary-contrast))' },
    secondary: {
        background: 'var(--bg-card)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-default)',
    },
    ghost: { background: 'transparent', color: 'var(--app-primary)' },
    /*
     * White on the raw --error token is under 4.5:1 for a 12-14px label in
     * several themes (#ef4444 → 3.99:1, #ff5252 in high-contrast → 3.55:1), and
     * the literal #ef4444 this used to hardcode ignored the per-theme token
     * altogether. Darkening the token by a fixed 25% keeps the theme's own red
     * and clears the bar everywhere: measured against white, the eight shipped
     * --error values land between 4.66:1 (#f87171) and 11.5:1 (#991b1b).
     */
    danger: { background: 'color-mix(in srgb, var(--error) 75%, #000)', color: '#ffffff' },
    /*
     * The look pass appended these two to the spec enum and to the inspector,
     * but never here — and the `|| VARIANT_STYLES.primary` fallback below meant
     * picking Outline or Soft rendered a PRIMARY button with no error anywhere.
     * The enum test only pinned the values, so nothing caught it. Both are
     * token-only, so they follow the app's own primary colour.
     */
    outline: {
        background: 'transparent',
        color: 'var(--app-primary)',
        border: '1px solid var(--app-primary)',
    },
    soft: { background: 'var(--app-primary-soft)', color: 'var(--app-primary)' },
};

const SIZE_CLASSES = {
    sm: 'px-2.5 py-1 text-xs',
    md: 'px-3.5 py-1.5 text-sm',
    lg: 'px-5 py-2.5 text-base',
};

export default function AppButton({ node }) {
    const { mode, runAction, actionState, scope } = useRuntime();
    const form = useFormContext();
    const { label = 'Button', variant = 'primary', iconLeft = null, role = 'button' } = node.props || {};
    // disabledWhen (spec: a formula) evaluates against the runtime scope — the
    // same scope visibility gates read, so a per-row scope reaches it too. A
    // broken formula resolves falsy: a button must not lock itself over a typo.
    const disabledWhen = node.props?.disabledWhen;
    const ruleDisabled = typeof disabledWhen === 'string' && disabledWhen.trim()
        ? !!tryEvaluate(disabledWhen, scope || {}).value
        : false;
    const size = node.style?.size || 'md';
    // role "submit" only means anything INSIDE a form. Placed in a page header
    // next to the form, it used to get type="submit" and no onClick, so there
    // was no form to submit and no handler to run — a button that did literally
    // nothing, and the publish validator exempted it from the inert-control
    // warning precisely because of its role. It now says so instead.
    const isSubmit = role === 'submit' && !!form;
    const orphanSubmit = role === 'submit' && !form && !node.onClick;

    // Per-node pending: a submit button follows its form's action, an onClick
    // button follows its own — never a global spinner.
    const pending = isSubmit
        ? !!form?.pending
        : !!(node.onClick && actionState?.[node.onClick]?.status === 'running');

    const handleClick = () => {
        if (mode !== 'run' || pending || ruleDisabled) return;
        if (node.onClick) runAction(node.onClick, {});
    };

    return (
        <button
            type={isSubmit ? 'submit' : 'button'}
            onClick={isSubmit ? undefined : handleClick}
            disabled={pending || orphanSubmit || ruleDisabled}
            aria-disabled={ruleDisabled || undefined}
            title={orphanSubmit ? 'This button is not inside a form, so it has nothing to submit.' : undefined}
            data-app-orphan-submit={orphanSubmit ? 'true' : undefined}
            className={`inline-flex items-center gap-1.5 font-medium transition-opacity disabled:opacity-60 ${SIZE_CLASSES[size] || SIZE_CLASSES.md}`}
            style={{ ...(VARIANT_STYLES[variant] || VARIANT_STYLES.primary), borderRadius: 'var(--app-radius)' }}
        >
            {pending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                : (iconLeft ? <AppIcon name={iconLeft} className="w-3.5 h-3.5" /> : null)}
            <span>{label}</span>
        </button>
    );
}

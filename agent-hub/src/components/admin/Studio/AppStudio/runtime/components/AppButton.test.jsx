import { createRequire } from 'node:module';
import { fireEvent, render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import AppButton from './AppButton';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * The variant lockstep.
 *
 * `outline` and `soft` were appended to the spec enum and offered by
 * ButtonInspector, but never added to VARIANT_STYLES — and the
 * `|| VARIANT_STYLES.primary` fallback turned that omission into a SILENT one:
 * picking Outline rendered a primary button, with no error and no warning.
 * The existing enum test (componentSpecs.test.js) only pinned the values, so
 * nothing connected the enum to what the runtime actually draws.
 *
 * This reads the enum from the server spec and asserts every value renders
 * DISTINCTLY, so the next appended variant fails here instead of shipping as a
 * primary button.
 */

const require = createRequire(import.meta.url);
const { COMPONENT_SPECS } = require('../../../../../../../../server/appStudio/componentSpecs.js');

const VARIANTS = COMPONENT_SPECS.button.props.variant.values;

function withRuntime(ui, overrides = {}) {
    const value = {
        ...DEFAULT_RUNTIME,
        scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }),
        mode: 'run',
        ...overrides,
    };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

function buttonNode(variant) {
    return {
        id: 'cmp_btn', type: 'button', visible: true,
        props: { label: 'Go', variant, iconLeft: null, role: 'button' },
        style: { span: 3 },
    };
}

/** The inline style a variant paints, as a comparable string. */
function styleOf(variant) {
    const { container } = withRuntime(<AppButton node={buttonNode(variant)} />);
    return container.querySelector('button').getAttribute('style');
}

describe('AppButton — variants', () => {
    it('the spec enum still starts at primary', () => {
        // Identity: the first value is the default, and a stored button without
        // a variant renders it.
        expect(VARIANTS[0]).toBe('primary');
        expect(styleOf(undefined)).toBe(styleOf('primary'));
    });

    it('every spec variant renders distinctly — none silently falls back', () => {
        const seen = new Map();
        for (const variant of VARIANTS) {
            const style = styleOf(variant);
            expect(style, `variant "${variant}" painted nothing`).toBeTruthy();
            const clash = seen.get(style);
            expect(
                clash,
                `variant "${variant}" renders identically to "${clash}" — it is missing from VARIANT_STYLES`,
            ).toBeUndefined();
            seen.set(style, variant);
        }
        expect(seen.size).toBe(VARIANTS.length);
    });

    it('outline is bordered and soft is filled, both on the app primary', () => {
        // Every button carries border-radius, so match the `border:` shorthand
        // specifically — `toContain('border')` would pass on the radius alone.
        const outline = styleOf('outline');
        expect(outline).toContain('var(--app-primary)');
        expect(outline).toMatch(/(^|;\s*)border:/);
        expect(outline).toContain('transparent');

        const soft = styleOf('soft');
        expect(soft).toContain('var(--app-primary-soft)');
        expect(soft).not.toMatch(/(^|;\s*)border:/);
    });

    it('an unknown variant still falls back to primary', () => {
        // The fallback is not the bug — silently swallowing a SPEC value was.
        expect(styleOf('not-a-variant')).toBe(styleOf('primary'));
    });
});

/**
 * disabledWhen (spec: a formula, default null). Truthy disables the button —
 * attribute, aria and the click path — evaluated against the same runtime
 * scope the visibility gates read, so per-row scopes reach it too.
 */
describe('AppButton — disabledWhen', () => {
    function renderButton(props = {}, overrides = {}) {
        const node = {
            id: 'cmp_btn', type: 'button', visible: true, onClick: 'act_go001',
            props: { label: 'Go', variant: 'primary', iconLeft: null, role: 'button', ...props },
            style: { span: 3 },
        };
        const runAction = vi.fn();
        const utils = withRuntime(<AppButton node={node} />, { runAction, ...overrides });
        return { ...utils, runAction, button: utils.container.querySelector('button') };
    }

    it('null / absent keeps the button enabled with no aria-disabled (identity)', () => {
        const { button, runAction } = renderButton({ disabledWhen: null });
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-disabled')).toBeNull();
        fireEvent.click(button);
        expect(runAction).toHaveBeenCalledWith('act_go001', {});
    });

    it('a truthy formula disables the button and blocks the action', () => {
        const { button, runAction } = renderButton(
            { disabledWhen: 'vars.locked' },
            { scope: buildScope({ vars: { locked: true }, now: '2020-01-01T00:00:00.000Z' }) },
        );
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(button.className).toContain('disabled:opacity-60');
        fireEvent.click(button);
        expect(runAction).not.toHaveBeenCalled();
    });

    it('a falsy formula leaves the button live', () => {
        const { button, runAction } = renderButton(
            { disabledWhen: 'vars.locked' },
            { scope: buildScope({ vars: { locked: false }, now: '2020-01-01T00:00:00.000Z' }) },
        );
        expect(button.disabled).toBe(false);
        fireEvent.click(button);
        expect(runAction).toHaveBeenCalled();
    });

    it('a broken formula never locks the button (resolves falsy)', () => {
        const { button } = renderButton({ disabledWhen: 'this is not (valid' });
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-disabled')).toBeNull();
    });
});

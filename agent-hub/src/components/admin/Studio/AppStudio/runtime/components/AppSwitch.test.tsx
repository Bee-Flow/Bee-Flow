import { describe, expect, it } from 'vitest';
import { declaredParts, renderedParts } from '@/test/appPartsRendered';
import { inputNode, renderInForm } from '@/test/appFormRender';
import AppSwitch from './AppSwitch';

const view = (props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, vars: Record<string, unknown> = {}) => {
    const node = inputNode('switch', { label: 'Notify me', ...props }, extra);
    return renderInForm(node, <AppSwitch node={node as never} />, vars);
};

describe('AppSwitch', () => {
    it('is a labelled switch that starts off', () => {
        const { getByRole } = view();
        const control = getByRole('switch', { name: 'Notify me' });
        expect(control.getAttribute('aria-checked')).toBe('false');
    });

    it('toggles with the keyboard and submits a boolean', async () => {
        const { getByRole, user, submit, lastValues } = view({ name: 'notify' });
        getByRole('switch').focus();
        await user.keyboard(' ');
        expect(getByRole('switch').getAttribute('aria-checked')).toBe('true');
        await submit();
        expect(lastValues()).toEqual({ notify: true });
        getByRole('switch').focus();
        await user.keyboard('{Enter}');
        await submit();
        expect(lastValues()).toEqual({ notify: false });
    });

    it('starts on with defaultChecked, and follows valueFrom', () => {
        const plain = view({ defaultChecked: true });
        expect(plain.getByRole('switch').getAttribute('aria-checked')).toBe('true');
        plain.unmount();
        const bound = view({ valueFrom: { kind: 'formula', expr: 'vars.row.on' } }, {}, { row: { on: true } });
        expect(bound.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    });

    it('a required switch must be on to submit', async () => {
        const { submit, runAction, getByRole, user, findByRole } = view({ name: 'terms', required: true });
        await submit();
        expect(runAction).not.toHaveBeenCalled();
        expect((await findByRole('alert')).textContent).toMatch(/required/i);
        await user.click(getByRole('switch'));
        await submit();
        expect(runAction).toHaveBeenCalledTimes(1);
    });

    it('runs onChange with the whole form and the new value', async () => {
        const { getByRole, user, lastValues } = view({ name: 'notify' }, { onChange: 'act_changed' });
        await user.click(getByRole('switch'));
        expect(lastValues('act_changed')).toEqual({ notify: true });
    });

    it('renders exactly the parts its spec declares, the error one after a failed submit', async () => {
        const { container, submit, findByRole } = view({ name: 'terms', required: true });
        await submit();
        await findByRole('alert');
        expect(renderedParts('switch', container)).toEqual(declaredParts('switch'));
    });
});

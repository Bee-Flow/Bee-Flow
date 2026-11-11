import { describe, expect, it } from 'vitest';
import { declaredParts, renderedParts } from '@/test/appPartsRendered';
import { inputNode, renderInForm } from '@/test/appFormRender';
import AppRadio from './AppRadio';

const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c' }];

const view = (props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, vars: Record<string, unknown> = {}) => {
    const node = inputNode('radio', { name: 'pick', label: 'Pick one', options: OPTIONS, ...props }, extra);
    return renderInForm(node, <AppRadio node={node as never} />, vars);
};

describe('AppRadio', () => {
    it('is a radiogroup named by its label, with one radio per option and none chosen', () => {
        const { getByRole, getAllByRole } = view();
        expect(getByRole('radiogroup', { name: 'Pick one' })).toBeTruthy();
        const radios = getAllByRole('radio') as HTMLInputElement[];
        expect(radios.map((r) => r.value)).toEqual(['a', 'b', 'c']);
        expect(radios.some((r) => r.checked)).toBe(false);
        expect(getByRole('radio', { name: 'Alpha' })).toBeTruthy();
        expect(getByRole('radio', { name: 'c' })).toBeTruthy();
    });

    it('submits the chosen option value, and the arrow keys move the choice', async () => {
        const { getByRole, user, submit, lastValues } = view();
        await user.click(getByRole('radio', { name: 'Beta' }));
        await submit();
        expect(lastValues()).toEqual({ pick: 'b' });
        getByRole('radio', { name: 'Beta' }).focus();
        await user.keyboard('{ArrowDown}');
        await submit();
        expect(lastValues()).toEqual({ pick: 'c' });
    });

    it('starts on defaultValue when it names an option, and ignores one that does not', () => {
        const chosen = view({ defaultValue: 'b' });
        expect((chosen.getByRole('radio', { name: 'Beta' }) as HTMLInputElement).checked).toBe(true);
        chosen.unmount();
        const stray = view({ defaultValue: 'zzz' });
        expect(stray.getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);
    });

    it('follows valueFrom', () => {
        const { getByRole } = view({ valueFrom: { kind: 'formula', expr: 'vars.row.status' } }, {}, { row: { status: 'c' } });
        expect((getByRole('radio', { name: 'c' }) as HTMLInputElement).checked).toBe(true);
    });

    it('a required group blocks submit until one is chosen', async () => {
        const { submit, runAction, findByRole, getByRole, user } = view({ required: true });
        await submit();
        expect(runAction).not.toHaveBeenCalled();
        expect((await findByRole('alert')).textContent).toMatch(/required/i);
        expect(getByRole('radiogroup').getAttribute('aria-required')).toBe('true');
        await user.click(getByRole('radio', { name: 'Alpha' }));
        await submit();
        expect(runAction).toHaveBeenCalledTimes(1);
    });

    it('runs onChange with the whole form and the new value', async () => {
        const { getByRole, user, lastValues } = view({}, { onChange: 'act_changed' });
        await user.click(getByRole('radio', { name: 'Alpha' }));
        expect(lastValues('act_changed')).toEqual({ pick: 'a' });
    });

    it('renders exactly the parts its spec declares, the error one after a failed submit', async () => {
        const { container, submit, findByRole } = view({ required: true });
        await submit();
        await findByRole('alert');
        expect(renderedParts('radio', container)).toEqual(declaredParts('radio'));
    });
});

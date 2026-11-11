import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { declaredParts, renderedParts } from '@/test/appPartsRendered';
import { inputNode, renderInForm } from '@/test/appFormRender';
import AppSlider from './AppSlider';

const view = (props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, vars: Record<string, unknown> = {}) => {
    const node = inputNode('slider', { name: 'level', label: 'Volume', min: 0, max: 10, step: 1, ...props }, extra);
    return renderInForm(node, <AppSlider node={node as never} />, vars);
};

describe('AppSlider', () => {
    it('is a labelled range input bounded by min and max, shown with its value', () => {
        const { getByRole, container } = view({ min: 2, max: 8, step: 2 });
        const range = getByRole('slider', { name: 'Volume' }) as HTMLInputElement;
        expect([range.min, range.max, range.step, range.value]).toEqual(['2', '8', '2', '2']);
        expect(container.querySelector('output')!.textContent).toBe('2');
    });

    it('starts on defaultValue, clamped into the range', () => {
        expect((view({ defaultValue: 7 }).getByRole('slider') as HTMLInputElement).value).toBe('7');
    });

    it('submits a number, and a keyboard step changes it', async () => {
        const { getByRole, submit, lastValues } = view({ defaultValue: 5 });
        getByRole('slider').focus();
        await submit();
        expect(lastValues()).toEqual({ level: 5 });
        fireEvent.change(getByRole('slider'), { target: { value: '9' } });
        await submit();
        expect(lastValues()).toEqual({ level: 9 });
    });

    it('follows valueFrom and keeps it inside the range', () => {
        const { getByRole } = view({ valueFrom: { kind: 'formula', expr: 'vars.row.level' } }, {}, { row: { level: 40 } });
        expect((getByRole('slider') as HTMLInputElement).value).toBe('10');
    });

    it('repairs bounds that make no range', () => {
        const { getByRole } = view({ min: 5, max: 5, step: 0 });
        const range = getByRole('slider') as HTMLInputElement;
        expect([range.min, range.max, range.step]).toEqual(['5', '105', '1']);
    });

    it('runs onChange with the whole form and the new value', () => {
        const { getByRole, lastValues } = view({}, { onChange: 'act_changed' });
        fireEvent.change(getByRole('slider'), { target: { value: '4' } });
        expect(lastValues('act_changed')).toEqual({ level: 4 });
    });

    it('renders exactly the parts its spec declares, the error one after a failed rule', async () => {
        const { container, submit, findByRole } = view({}, { validations: [{ type: 'min', value: 5 }] });
        await submit();
        await findByRole('alert');
        expect(renderedParts('slider', container)).toEqual(declaredParts('slider'));
    });
});

import { describe, expect, it } from 'vitest';
import { declaredParts, renderedParts } from '@/test/appPartsRendered';
import { inputNode, renderInForm } from '@/test/appFormRender';
import AppRating from './AppRating';

const view = (props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, vars: Record<string, unknown> = {}) => {
    const node = inputNode('rating', { name: 'score', label: 'Score', max: 5, ...props }, extra);
    return renderInForm(node, <AppRating node={node as never} />, vars);
};

const checked = (radios: HTMLElement[]) => radios.findIndex((r) => r.getAttribute('aria-checked') === 'true') + 1;

describe('AppRating', () => {
    it('is a radiogroup of max stars with none chosen and a single tab stop', () => {
        const { getByRole, getAllByRole } = view({ max: 4 });
        expect(getByRole('radiogroup', { name: 'Score' })).toBeTruthy();
        const stars = getAllByRole('radio');
        expect(stars).toHaveLength(4);
        expect(checked(stars)).toBe(0);
        expect(stars.map((s) => s.tabIndex)).toEqual([0, -1, -1, -1]);
        expect(stars[2].getAttribute('aria-label')).toBe('3 of 4');
    });

    it('submits nothing until a star is chosen, then the whole number', async () => {
        const { getAllByRole, user, submit, lastValues } = view();
        await submit();
        expect(lastValues()).toEqual({ score: null });
        await user.click(getAllByRole('radio')[3]);
        await submit();
        expect(lastValues()).toEqual({ score: 4 });
    });

    it('moves and chooses with the arrow, Home and End keys', async () => {
        const { getAllByRole, user } = view();
        getAllByRole('radio')[0].focus();
        await user.keyboard('{ArrowRight}{ArrowRight}');
        expect(checked(getAllByRole('radio'))).toBe(2);
        expect(document.activeElement).toBe(getAllByRole('radio')[1]);
        await user.keyboard('{End}');
        expect(checked(getAllByRole('radio'))).toBe(5);
        await user.keyboard('{ArrowRight}');
        expect(checked(getAllByRole('radio'))).toBe(5);
        await user.keyboard('{Home}');
        expect(checked(getAllByRole('radio'))).toBe(1);
    });

    it('starts on defaultValue and follows valueFrom, both kept within 1..max', () => {
        expect(checked(view({ defaultValue: 3 }).getAllByRole('radio'))).toBe(3);
    });

    it('takes a rounded valueFrom and caps it at max', () => {
        const { getAllByRole } = view({ valueFrom: { kind: 'formula', expr: 'vars.row.stars' } }, {}, { row: { stars: 9.4 } });
        expect(checked(getAllByRole('radio'))).toBe(5);
    });

    it('a required rating blocks submit until a star is chosen', async () => {
        const { submit, runAction, findByRole, getAllByRole, user } = view({ required: true });
        await submit();
        expect(runAction).not.toHaveBeenCalled();
        expect((await findByRole('alert')).textContent).toMatch(/required/i);
        await user.click(getAllByRole('radio')[0]);
        await submit();
        expect(runAction).toHaveBeenCalledTimes(1);
    });

    it('runs onChange with the whole form and the new value', async () => {
        const { getAllByRole, user, lastValues } = view({}, { onChange: 'act_changed' });
        await user.click(getAllByRole('radio')[1]);
        expect(lastValues('act_changed')).toEqual({ score: 2 });
    });

    it('renders exactly the parts its spec declares, the error one after a failed submit', async () => {
        const { container, submit, findByRole } = view({ required: true });
        await submit();
        await findByRole('alert');
        expect(renderedParts('rating', container)).toEqual(declaredParts('rating'));
    });
});

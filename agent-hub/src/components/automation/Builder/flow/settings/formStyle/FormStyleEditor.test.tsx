import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PublicFormRenderer from '@/components/forms/PublicFormRenderer';
import type { StyleAssist } from '@/api/formStyleAssist';
import FormStyleEditor from './FormStyleEditor';
import { THEME_PRESETS } from './stylePresets';
import type { StyleChangeSet } from './formStyleTypes';

/**
 * The grouped style controls, driven the way the builder drives them: every
 * edit merges into the form at once, and the preview next to them is the
 * renderer the visitor gets.
 */

type Form = Record<string, unknown>;

const START: Form = {
    title: 'Order a cake',
    submitLabel: 'Send',
    theme: { ...THEME_PRESETS[0].theme },
    fields: [{ name: 'name', type: 'text', label: 'Your name' }],
};

function Harness({ initial = START, assist = null, canInherit = false, isEnding = false, onForm }: {
    initial?: Form;
    assist?: StyleAssist | null;
    canInherit?: boolean;
    isEnding?: boolean;
    onForm?: (f: Form) => void;
}) {
    const [form, setForm] = useState<Form>(initial);
    const change = (c: StyleChangeSet) => setForm(f => {
        const next = { ...f, ...c };
        onForm?.(next);
        return next;
    });
    return (
        <>
            <FormStyleEditor
                theme={(form.theme as Form) || THEME_PRESETS[0].theme}
                formStyle={form.style}
                inherits={!form.theme}
                canInherit={canInherit}
                isEnding={isEnding}
                onChange={change}
                buttonText={<input aria-label="Submit label" value={String(form.submitLabel || '')} onChange={e => setForm(f => ({ ...f, submitLabel: e.target.value }))} />}
                onStyleAssist={assist}
            />
            <div data-testid="preview"><PublicFormRenderer form={form} preview /></div>
        </>
    );
}

type Edited = Form & { style?: Record<string, unknown>; theme?: Record<string, unknown> | null };
/** The form as the last edit left it. */
const lastForm = (fn: { mock: { calls: unknown[][] } }): Edited => fn.mock.calls[fn.mock.calls.length - 1][0] as Edited;
const previewRoot = () => within(screen.getByTestId('preview')).getByRole('button', { name: /Send|Order/ }).closest('form') as HTMLFormElement;
const openGroup = (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(screen.getByRole('button', { name }));

describe('FormStyleEditor', () => {
    it('opens on Look and keeps the other groups folded', () => {
        render(<Harness />);
        expect(screen.getByRole('button', { name: 'Look' }).getAttribute('aria-expanded')).toBe('true');
        for (const name of ['Layout', 'Fields', 'Button', 'Brand', 'Advanced']) {
            expect(screen.getByRole('button', { name }).getAttribute('aria-expanded')).toBe('false');
        }
    });

    it('a layout choice reaches the preview at once, and Default takes it away again', async () => {
        const user = userEvent.setup();
        const onForm = vi.fn();
        render(<Harness onForm={onForm} />);
        await openGroup(user, 'Layout');
        const width = screen.getByRole('group', { name: 'Width' });
        await user.click(within(width).getByRole('button', { name: 'Wide' }));
        expect(previewRoot().style.getPropertyValue('--bf-form-width')).toBe('860px');
        await user.click(within(screen.getByRole('group', { name: 'Font' })).getByRole('button', { name: 'Serif' }));
        expect(lastForm(onForm).style).toEqual({ width: 'wide', font: 'serif' });
        await user.click(within(width).getByRole('button', { name: 'Default' }));
        await user.click(within(screen.getByRole('group', { name: 'Font' })).getByRole('button', { name: 'Default' }));
        // Nothing set is no style at all, not an empty object.
        expect(lastForm(onForm).style).toBeUndefined();
        expect(previewRoot().style.getPropertyValue('--bf-form-width')).toBe('');
    });

    it('theme knobs still write the theme, and a preset sets all five', async () => {
        const user = userEvent.setup();
        const onForm = vi.fn();
        render(<Harness onForm={onForm} />);
        await user.click(screen.getByRole('button', { name: /Night/ }));
        expect(lastForm(onForm).theme).toEqual(THEME_PRESETS[3].theme);
        await openGroup(user, 'Layout');
        await user.click(within(screen.getByRole('group', { name: 'Corners' })).getByRole('button', { name: 'Square' }));
        expect(lastForm(onForm).theme?.radius).toBe('none');
        expect(previewRoot().style.getPropertyValue('--app-radius')).toBe('0px');
    });

    it('a colour can be reset to "not set"', async () => {
        const user = userEvent.setup();
        const onForm = vi.fn();
        render(<Harness initial={{ ...START, style: { cardColor: '#fef3c7' } }} onForm={onForm} />);
        expect(previewRoot().style.getPropertyValue('--bf-card-bg')).toBe('#fef3c7');
        await user.click(screen.getByRole('button', { name: 'Reset Card colour' }));
        expect(lastForm(onForm).style).toBeUndefined();
        expect(previewRoot().style.getPropertyValue('--bf-card-bg')).toBe('');
    });

    it('fields and button: label inside, a pill button, and the button text moved here', async () => {
        const user = userEvent.setup();
        const onForm = vi.fn();
        render(<Harness onForm={onForm} />);
        await openGroup(user, 'Fields');
        await user.click(within(screen.getByRole('group', { name: 'Labels' })).getByRole('button', { name: 'Inside the field' }));
        await openGroup(user, 'Button');
        await user.click(within(screen.getByRole('group', { name: 'Shape' })).getByRole('button', { name: 'Pill' }));
        expect(lastForm(onForm).style).toEqual({ labelStyle: 'inside', button: { shape: 'pill' } });
        expect(previewRoot().className).toContain('bf-form--labels-inside');
        const label = screen.getByLabelText('Submit label');
        await user.clear(label);
        await user.type(label, 'Order');
        expect(within(screen.getByTestId('preview')).getByRole('button', { name: 'Order' })).toBeTruthy();
    });

    it('brand: a logo from another site is refused and not saved; a same-origin one shows in the preview', async () => {
        const user = userEvent.setup();
        const onForm = vi.fn();
        render(<Harness onForm={onForm} />);
        await openGroup(user, 'Brand');
        const logo = screen.getByLabelText('Logo');
        await user.type(logo, 'https://cdn.example/logo.png');
        expect(screen.getByRole('alert').textContent).toMatch(/single \//);
        expect(within(screen.getByTestId('preview')).queryByTestId('form-logo')).toBeNull();
        expect(onForm.mock.calls.some(c => c[0].style?.logoUrl)).toBe(false);
        await user.clear(logo);
        await user.type(logo, '/logo.png');
        expect(within(screen.getByTestId('preview')).getByTestId('form-logo').getAttribute('src')).toBe('/logo.png');
        await user.type(screen.getByLabelText('Footer text'), 'Bakery Ltd');
        expect(within(screen.getByTestId('preview')).getByText('Bakery Ltd')).toBeTruthy();
    });

    it('custom CSS: live in the preview, counted, with a warning for what is left out, and a cheat sheet', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await openGroup(user, 'Advanced');
        const box = screen.getByLabelText('Custom CSS');
        await user.click(box);
        await user.paste('.bf-form__title { color: #7c2d12; } .bf-form__card { background: url(https://x.example/a.png); }');
        const sheet = within(screen.getByTestId('preview')).getByTestId('form-custom-css').textContent || '';
        expect(sheet).toContain('.bf-form__title { color: #7c2d12; }');
        expect(sheet).not.toContain('x.example');
        expect(screen.getByTestId('form-style-css-removed').textContent).toContain('an address on another site');
        expect(screen.getByTestId('form-style-css-count').textContent).toMatch(/^\d[\d,.]* \/ 20[,.]?000$/);
        await user.click(screen.getByRole('button', { name: 'Class names you can style' }));
        expect(within(screen.getByTestId('form-style-cheat-sheet')).getByText('.bf-form__submit')).toBeTruthy();
    });

    it('Ask AI puts the answer in the CSS field and the preview, and Undo brings the old CSS back', async () => {
        const user = userEvent.setup();
        const assist = vi.fn<StyleAssist>(async () => ({ css: '.bf-form__card { border-radius: 24px; }', notes: ['Softer card'], removed: ['url(https://x.example/a.png)'] }));
        render(<Harness initial={{ ...START, style: { font: 'serif', customCss: '.bf-form__title { color: red; }' } }} assist={assist} />);
        await openGroup(user, 'Advanced');
        await user.type(screen.getByLabelText('Describe the look'), 'a warm bakery');
        await user.click(screen.getByRole('button', { name: 'Ask AI' }));
        expect(assist).toHaveBeenCalledWith({ prompt: 'a warm bakery', theme: START.theme, style: { font: 'serif' }, customCss: '.bf-form__title { color: red; }' });
        expect((screen.getByLabelText('Custom CSS') as HTMLTextAreaElement).value).toBe('.bf-form__card { border-radius: 24px; }');
        expect(within(screen.getByTestId('preview')).getByTestId('form-custom-css').textContent).toContain('border-radius: 24px');
        expect(screen.getByText('Softer card')).toBeTruthy();
        expect(screen.getByTestId('form-style-ai-removed').textContent).toContain('url(https://x.example/a.png)');

        await user.click(screen.getByRole('button', { name: 'Undo' }));
        expect((screen.getByLabelText('Custom CSS') as HTMLTextAreaElement).value).toBe('.bf-form__title { color: red; }');
        expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    });

    it('a failed Ask AI says so and changes nothing', async () => {
        const user = userEvent.setup();
        const assist = vi.fn<StyleAssist>(async () => { throw new Error('The model is busy.'); });
        render(<Harness assist={assist} />);
        await openGroup(user, 'Advanced');
        await user.type(screen.getByLabelText('Describe the look'), 'dark glass');
        await user.click(screen.getByRole('button', { name: 'Ask AI' }));
        expect(screen.getByRole('alert').textContent).toBe('The model is busy.');
        expect((screen.getByLabelText('Custom CSS') as HTMLTextAreaElement).value).toBe('');
    });

    it('without a saved automation, Ask AI is off and says why', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await openGroup(user, 'Advanced');
        await user.type(screen.getByLabelText('Describe the look'), 'dark glass');
        expect((screen.getByRole('button', { name: 'Ask AI' }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText(/Save the automation first/)).toBeTruthy();
    });

    it('a later page that matches the first page hides the look but keeps the button text', async () => {
        const user = userEvent.setup();
        const onForm = vi.fn();
        render(<Harness initial={{ ...START, theme: null }} canInherit onForm={onForm} />);
        expect(screen.queryByRole('button', { name: 'Look' })).toBeNull();
        expect(screen.getByLabelText('Submit label')).toBeTruthy();
        await user.click(screen.getByLabelText('Match the first page'));
        expect(screen.getByRole('button', { name: 'Look' })).toBeTruthy();
        await user.click(screen.getByLabelText('Match the first page'));
        expect(lastForm(onForm)).toMatchObject({ theme: null, style: undefined });
    });

    it('a closing page has no Fields and no Button group', () => {
        render(<Harness isEnding />);
        expect(screen.queryByRole('button', { name: 'Fields' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Button' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Brand' })).toBeTruthy();
    });
});

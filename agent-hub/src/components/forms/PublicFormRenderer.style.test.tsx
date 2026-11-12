import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PublicFormRenderer, { FormEndingView, FormWaitingView } from './PublicFormRenderer';
import type { FormDef } from './PublicFormRenderer.types';

/**
 * `form.style`: the look beyond the theme. The variables ride next to the
 * theme's on the root, the stable bf-form classes are there for custom CSS,
 * and the custom CSS itself is sanitised again and scoped to this one form.
 */

const base = (style?: Record<string, unknown> | null): FormDef => ({
    title: 'Order a cake',
    description: 'Tell us what you would like.',
    submitLabel: 'Send',
    successMessage: 'Thanks',
    theme: { primary: '#0F766E', appearance: 'light' },
    style,
    fields: [
        { name: 'name', type: 'text', label: 'Your name', required: true },
        { name: 'size', type: 'radio', label: 'Size', options: [{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }] },
        { name: 'note', type: 'textarea', label: 'Anything else' },
    ],
});

const rootOf = (container: HTMLElement) => container.querySelector('form') as HTMLFormElement;

describe('form.style on the renderer', () => {
    it('puts the style variables next to the theme variables on the root, with the class modifiers', () => {
        const { container } = render(<PublicFormRenderer form={base({ font: 'serif', width: 'wide', inputStyle: 'filled', button: { shape: 'pill' } })} preview />);
        const root = rootOf(container);
        expect(root.style.getPropertyValue('--app-primary')).toBe('#0F766E');
        expect(root.style.getPropertyValue('--bf-font')).toMatch(/serif/);
        expect(root.style.getPropertyValue('--bf-form-width')).toBe('860px');
        expect(root.style.getPropertyValue('--bf-button-radius')).toBe('999px');
        expect(root.className).toContain('bf-form bf-form-scope');
        expect(root.className).toContain('bf-form--inputs-filled');
        expect(root.className).toContain('bf-form--font-serif');
    });

    it('exposes the stable class names and data-field on every question', () => {
        const { container } = render(<PublicFormRenderer form={base(null)} preview />);
        for (const cls of ['bf-form__card', 'bf-form__title', 'bf-form__intro', 'bf-form__label', 'bf-form__input', 'bf-form__choice', 'bf-form__choice-option', 'bf-form__actions', 'bf-form__submit']) {
            expect(container.querySelector(`.${cls}`), cls).toBeTruthy();
        }
        const fields = [...container.querySelectorAll('.bf-form__field')].map(el => el.getAttribute('data-field'));
        expect(fields).toEqual(['name', 'size', 'note']);
        expect(screen.getByRole('button', { name: 'Send' }).className).toContain('bf-form__submit');
    });

    it('shows the errors with bf-form__error', async () => {
        const user = userEvent.setup();
        const { container } = render(<PublicFormRenderer form={base(null)} onSubmit={vi.fn(async () => {})} />);
        await user.click(screen.getByRole('button', { name: 'Send' }));
        expect(container.querySelector('.bf-form__error')?.textContent).toBe('Your name is required.');
    });

    it('renders a same-origin logo and the footer text, and no logo from another site', () => {
        const { container, rerender } = render(<PublicFormRenderer form={base({ logoUrl: '/brand/logo.png', footerText: 'Bakery Ltd · privacy first' })} preview />);
        const logo = screen.getByTestId('form-logo') as HTMLImageElement;
        expect(logo.getAttribute('src')).toBe('/brand/logo.png');
        expect(logo.className).toContain('bf-form__logo');
        expect(container.querySelector('.bf-form__footer')?.textContent).toBe('Bakery Ltd · privacy first');

        rerender(<PublicFormRenderer form={base({ logoUrl: 'https://cdn.example/logo.png' })} preview />);
        expect(screen.queryByTestId('form-logo')).toBeNull();
        rerender(<PublicFormRenderer form={base({ logoUrl: '//cdn.example/logo.png' })} preview />);
        expect(screen.queryByTestId('form-logo')).toBeNull();
    });

    it('scopes the custom CSS to this form, sanitised again on the client', () => {
        const css = '.bf-form__title { color: #7c2d12; }\n@import "/x.css";\n.bf-form__card { background: url(https://tracker.example/p.gif); }';
        const { container } = render(<PublicFormRenderer form={base({ customCss: css })} preview />);
        const root = rootOf(container);
        const sheet = screen.getByTestId('form-custom-css').textContent || '';
        expect(sheet.startsWith(`@scope (.bf-form-scope[data-bf-scope="${root.getAttribute('data-bf-scope')}"]) {`)).toBe(true);
        expect(sheet).toContain('.bf-form__title { color: #7c2d12; }');
        expect(sheet).not.toMatch(/@import|tracker/);
        // The style element lives inside the form root it scopes.
        expect(root.contains(screen.getByTestId('form-custom-css'))).toBe(true);
    });

    it('adds nothing for a form without a style', () => {
        const { container } = render(<PublicFormRenderer form={base(undefined)} preview />);
        expect(screen.queryByTestId('form-custom-css')).toBeNull();
        expect(screen.queryByTestId('form-logo')).toBeNull();
        expect(container.querySelector('.bf-form__footer')).toBeNull();
        expect(rootOf(container).style.getPropertyValue('--bf-font')).toBe('');
    });

    it('puts the label inside the box when asked, still tied to its input', async () => {
        const user = userEvent.setup();
        const onSubmit = vi.fn(async (_v: Record<string, unknown>) => {});
        render(<PublicFormRenderer form={base({ labelStyle: 'inside' })} onSubmit={onSubmit} />);
        const input = screen.getByLabelText(/Your name/);
        const label = document.querySelector('label[for="ff_name"]') as HTMLLabelElement;
        // Inside: the label follows the control in one positioned box.
        expect(label.className).toContain('absolute');
        expect(input.nextElementSibling).toBe(label);
        expect(input.className).toContain('pt-5');
        // A choice question keeps its legend above the options.
        expect(screen.getByRole('radiogroup', { name: /Size/ })).toBeTruthy();
        await user.type(input, 'Ada');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'Ada' });
    });
});

describe('form.style on the waiting and closing screens', () => {
    it('the closing page wears the same look, logo and footer', () => {
        render(<FormEndingView form={{ title: 'All done', description: 'See you', theme: {}, style: { cardColor: '#101010', logoUrl: '/logo.png', footerText: 'Bakery Ltd', customCss: '.bf-form__ending { padding: 40px; }' } }} />);
        const root = screen.getByTestId('form-ending');
        expect(root.style.getPropertyValue('--bf-card-bg')).toBe('#101010');
        expect(root.querySelector('.bf-form__ending')).toBeTruthy();
        expect(screen.getByTestId('form-logo')).toBeTruthy();
        expect(screen.getByText('Bakery Ltd').className).toContain('bf-form__footer');
        expect(screen.getByTestId('form-custom-css').textContent).toContain('.bf-form__ending { padding: 40px; }');
    });

    it('the waiting screen takes the form\'s style and marks its progress bar', () => {
        render(<FormWaitingView theme={{}} formStyle={{ font: 'rounded', footerText: 'Bakery Ltd' }} progress={['Baking']} />);
        const root = screen.getByTestId('form-waiting');
        expect(root.style.getPropertyValue('--bf-font')).toMatch(/rounded/);
        expect(root.querySelector('.bf-form__waiting')).toBeTruthy();
        expect(root.querySelector('.bf-form__progress')).toBeTruthy();
        expect(screen.getByText('Bakery Ltd')).toBeTruthy();
    });
});

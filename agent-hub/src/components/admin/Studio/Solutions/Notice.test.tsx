import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import Notice from './Notice';

describe('Notice', () => {
    it('is a status line by default and carries its tone', () => {
        render(<Notice testId="n">Hello</Notice>);
        const el = screen.getByTestId('n');
        expect(el.getAttribute('role')).toBe('status');
        expect(el.getAttribute('data-tone')).toBe('info');
        expect(el.textContent).toBe('Hello');
    });

    it('announces an error and renders the action', () => {
        render(<Notice tone="error" action={<button type="button">Retry</button>}>Broke</Notice>);
        expect(screen.getByRole('alert').textContent).toContain('Broke');
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    });
});

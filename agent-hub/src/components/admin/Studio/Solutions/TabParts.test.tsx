import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import { TabCard, TabNote, TabSpinner } from './TabParts';

describe('TabParts', () => {
    it('renders a titled card with its content', () => {
        render(<TabCard title="Health"><span>body</span></TabCard>);
        expect(screen.getByRole('heading', { name: 'Health' })).toBeTruthy();
        expect(screen.getByText('body')).toBeTruthy();
    });

    it('renders a note and a busy spinner', () => {
        render(<><TabNote>nothing</TabNote><TabSpinner /></>);
        expect(screen.getByText('nothing')).toBeTruthy();
        expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    });
});

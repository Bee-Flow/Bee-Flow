import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StudioShell from './StudioShell';

describe('StudioShell', () => {
    it('renders sidebar title, actions, sidebar body, and main content', () => {
        render(
            <StudioShell
                sidebarTitle="Skills"
                sidebarActions={<button>New</button>}
                sidebar={<div data-testid="list">items</div>}
            >
                <div data-testid="detail">detail</div>
            </StudioShell>,
        );
        expect(screen.getByText('Skills')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
        expect(screen.getByTestId('list')).toBeInTheDocument();
        expect(screen.getByTestId('detail')).toBeInTheDocument();
    });

    it('omits the header bar when neither title nor actions are given', () => {
        const { container } = render(
            <StudioShell sidebar={<div>items</div>}>
                <div>detail</div>
            </StudioShell>,
        );
        // The sidebar header is the only <header> the shell renders.
        expect(container.querySelector('aside > header')).toBeNull();
    });

    it('stacks the sidebar above the content below md when responsive, and hides its title bar there', () => {
        const { container } = render(
            <StudioShell responsive sidebarTitle="Security" sidebar={<div>items</div>}>
                <div>detail</div>
            </StudioShell>,
        );
        const root = container.firstElementChild as HTMLElement;
        expect(root.className).toContain('flex-col');
        expect(root.className).toContain('md:flex-row');
        expect(container.querySelector('aside')?.className).toContain('md:w-64');
        expect(container.querySelector('aside > header')?.className).toContain('hidden md:flex');
    });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BehaviorSection } from './BehaviorSection';
import type { DesignerSectionProps } from './sectionProps';

function props(): DesignerSectionProps {
    return { allowCopy: true, setAllowCopy: vi.fn() } as Partial<DesignerSectionProps> as DesignerSectionProps;
}

describe('BehaviorSection', () => {
    it('holds the chat behaviour: Allow copying, and nothing about integrations or embedding', async () => {
        const p = props();
        render(<BehaviorSection {...p} />);
        expect(screen.getByRole('heading', { level: 2, name: 'Behavior Settings' })).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: 'Allow Copying' })).toBeChecked();
        await userEvent.click(screen.getByRole('switch', { name: 'Allow Copying' }));
        expect(p.setAllowCopy).toHaveBeenCalledWith(false);
        expect(screen.queryByRole('switch', { name: 'Disable Integrations & Web Search' })).toBeNull();
        expect(screen.queryByRole('switch', { name: 'Web Embed' })).toBeNull();
    });
});

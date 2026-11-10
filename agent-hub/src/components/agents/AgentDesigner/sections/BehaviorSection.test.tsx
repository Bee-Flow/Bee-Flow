import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BehaviorSection } from './BehaviorSection';
import type { DesignerSectionProps } from './sectionProps';

function props(over: Partial<DesignerSectionProps> = {}): DesignerSectionProps {
    const base: Partial<DesignerSectionProps> = {
        selectedAgent: { id: 'agent-1', name: 'Alpha' } as DesignerSectionProps['selectedAgent'],
        allowCopy: true, setAllowCopy: vi.fn(),
        disableExternalTools: false, setDisableExternalTools: vi.fn(),
        embedEnabled: false, setEmbedEnabled: vi.fn(),
        bubbleColor: '#123456', setBubbleColor: vi.fn(), bubblePosition: 'right', setBubblePosition: vi.fn(),
        bubbleSize: 60, setBubbleSize: vi.fn(), bubbleIcon: '🐝', setBubbleIcon: vi.fn(),
        windowWidth: 400, setWindowWidth: vi.fn(), windowHeight: 600, setWindowHeight: vi.fn(),
        chatFont: 'System Default', setChatFont: vi.fn(), chatFontSize: 14, setChatFontSize: vi.fn(),
        chatLineHeight: 1.5, setChatLineHeight: vi.fn(), userBubbleColor: '', setUserBubbleColor: vi.fn(),
        assistantBubbleColor: '', setAssistantBubbleColor: vi.fn(), warningText: '', setWarningText: vi.fn(),
    };
    return { ...base, ...over } as DesignerSectionProps;
}

describe('BehaviorSection', () => {
    it('has one switch per behaviour, and a switch calls its setter', async () => {
        const p = props();
        render(<BehaviorSection {...p} />);
        expect(screen.getByRole('heading', { level: 2, name: 'Behavior Settings' })).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'Allow Copying' })).toBeChecked();
        await userEvent.click(screen.getByRole('checkbox', { name: 'Disable Integrations & Web Search' }));
        expect(p.setDisableExternalTools).toHaveBeenCalledWith(true);
        await userEvent.click(screen.getByRole('checkbox', { name: 'Web Embed' }));
        expect(p.setEmbedEnabled).toHaveBeenCalledWith(true);
        expect(screen.queryByText('Embed Settings')).toBeNull();
    });

    it('with the embed on, shows the public URL and copies it, and sets the bubble position', async () => {
        const user = userEvent.setup();
        const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        const p = props({ embedEnabled: true });
        render(<BehaviorSection {...p} />);
        const url = screen.getByRole('textbox', { name: 'Public URL' });
        expect(url).toHaveValue(`${window.location.origin}/chat/agent-1`);
        await user.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
        expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/chat/agent-1`);
        expect(screen.getByRole('button', { name: 'Right ▶' })).toHaveAttribute('aria-pressed', 'true');
        await user.click(screen.getByRole('button', { name: '◀ Left' }));
        expect(p.setBubblePosition).toHaveBeenCalledWith('left');
        expect((screen.getByRole('textbox', { name: 'Generated Code' }) as HTMLTextAreaElement).value).toContain('<!-- Bee Flow Chat Widget -->');
    });

    it('shows no embed settings for an agent that is not saved yet', () => {
        render(<BehaviorSection {...props({ embedEnabled: true, selectedAgent: null })} />);
        expect(screen.queryByText('Embed Settings')).toBeNull();
    });
});

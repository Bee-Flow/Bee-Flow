import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SkillAccessOptions from './SkillAccessOptions';
import type { TranslateFn } from '@/hooks/useTranslation';

const t = ((_key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : '')) as TranslateFn;

function setup(over: Partial<Parameters<typeof SkillAccessOptions>[0]> = {}) {
    const onChange = vi.fn();
    render(
        <SkillAccessOptions t={t} agentOnly={false} category="" categorySuggestions={['Finance', 'Sales']} readOnly={false} onChange={onChange} {...over} />,
    );
    return onChange;
}

describe('SkillAccessOptions', () => {
    it('switches "only through agents" on', async () => {
        const onChange = setup();
        await userEvent.click(screen.getByTestId('skill-agent-only'));
        expect(onChange).toHaveBeenCalledWith({ agentOnly: true });
    });

    it('offers the existing categories and writes a typed one on Enter, not per keystroke', async () => {
        const onChange = setup();
        const options = [...document.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'));
        expect(options).toEqual(['Finance', 'Sales']);
        await userEvent.type(screen.getByTestId('skill-category'), ' Legal ');
        expect(onChange).not.toHaveBeenCalled();
        await userEvent.keyboard('{Enter}');
        expect(onChange).toHaveBeenCalledWith({ category: 'Legal' });
    });

    it('writes nothing for a read-only skill', () => {
        setup({ readOnly: true });
        expect((screen.getByTestId('skill-agent-only') as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByTestId('skill-category') as HTMLInputElement).disabled).toBe(true);
    });
});

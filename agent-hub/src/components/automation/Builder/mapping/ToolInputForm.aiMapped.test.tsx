/**
 * An input the Auto-map wand's AI fallback filled says so ("auto · AI"), so
 * the author knows which picks deserve a second look; a deterministic match
 * keeps its plain "auto".
 */
import { cleanup, render, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ToolInputFormJs from './ToolInputForm';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';

type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const ToolInputForm = ToolInputFormJs as unknown as Loose;
const VariablePickerProvider = ProviderJs as unknown as Loose;

afterEach(() => cleanup());

const SCHEMA = {
    type: 'object',
    required: ['to', 'subject'],
    properties: { to: { type: 'string', title: 'To' }, subject: { type: 'string', title: 'Subject' } },
};

describe('ToolInputForm — the AI auto-map marker', () => {
    it('marks the AI-filled input "auto · AI" and the matched one "auto"', () => {
        render(
            <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()} stepTypeById={null}>
                <ToolInputForm
                    inputs={{ to: { kind: 'ref', path: 'trigger.output.from' }, subject: { kind: 'ref', path: 'trigger.output.subject' } }}
                    onChange={vi.fn()}
                    inputSchema={SCHEMA}
                    autoMappedKeys={['subject']}
                    aiMappedKeys={['to']}
                />
            </VariablePickerProvider>,
        );
        const ai = screen.getByTestId('auto-mapped-ai');
        expect(ai.textContent).toBe('auto · AI');
        expect(ai.getAttribute('title')).toBe('Mapped by AI from an upstream step — check it, edit to override');
        expect(screen.getAllByText('auto')).toHaveLength(1);
    });
});

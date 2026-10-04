import { cleanup, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import NotificationNodeJs from './NotificationNode';
import { NodeRuntimeContext } from '../NodeRuntimeContext';
import { humanizeTemplate } from '../displayHelpers';

const NotificationNode = NotificationNodeJs as unknown as ComponentType<Record<string, unknown>>;

/**
 * A templated field on a canvas card reads the way the panel's chips do
 * ("Code ▸ Text"), not as `{{‹Code›.result.text}}{{‹Code›.re…`.
 */
const LABELS = new Map([['code_1', 'Code']]);
const BODY = '{{steps.code_1.output.result.text}}{{steps.code_1.output.result.number}}{{steps.code_1.output.result.flag}}';

describe('humanizeTemplate', () => {
    it('names each reference like a chip and separates glued ones', () => {
        expect(humanizeTemplate(BODY, LABELS)).toBe('Code ▸ Text · Code ▸ Number · Code ▸ Flag');
    });

    it('keeps the surrounding words and a lone reference intact', () => {
        expect(humanizeTemplate('Hello {{steps.code_1.output.result.text}}!', LABELS)).toBe('Hello Code ▸ Text!');
        expect(humanizeTemplate('{{trigger.output.from}} {{trigger.output.subject}}', null)).toBe('Trigger ▸ From · Trigger ▸ Subject');
    });

    it('leaves plain text alone, including words that look like paths', () => {
        expect(humanizeTemplate('The trigger fired', LABELS)).toBe('The trigger fired');
        expect(humanizeTemplate('', LABELS)).toBe('');
        expect(humanizeTemplate(undefined as unknown as string, LABELS)).toBe('');
    });
});

describe('NotificationNode subtitle', () => {
    afterEach(cleanup);

    it('shows chip-style names instead of the raw template', () => {
        render(
            <ReactFlowProvider>
                <NodeRuntimeContext.Provider value={{
                    pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
                    typeGroupById: new Map(), stepTypeById: new Map(), stepNumberById: new Map(),
                } as never}>
                    <NotificationNode id="n1" data={{ step: { id: 'n1', type: 'notification', title: 'Hi', body: BODY }, stepLabelById: LABELS, issues: [] }} />
                </NodeRuntimeContext.Provider>
            </ReactFlowProvider>,
        );
        expect(screen.getByText('Code ▸ Text · Code ▸ Number · Code ▸ Flag')).toBeTruthy();
        expect(screen.queryByText(/\{\{/)).toBeNull();
    });
});

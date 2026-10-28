import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect } from 'vitest';

import MessageItem from './index';
import { normalizeLoadedMessages } from '@/utils/messageShape';
import type { ComponentProps } from 'react';
import { stub } from '@/test/mocks';

// A reloaded direct-chat assistant message: the server sends no `id`.
const persisted = {
    role: 'assistant', content: 'Hello.', timestamp: '2026-10-12T09:00:00Z',
    modelId: 'm', modelTier: 'fast', toolHistory: [],
    memoryUsed: [{ id: 'mem-1', type: 'fact', why: 'relevant' }],
};

describe.each(['direct', 'agent'])('Used N memories (%s chat)', (chatSource) => {
    it('shows for a reloaded message without an id', () => {
        const [msg] = normalizeLoadedMessages([persisted]);
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg)} chatSource={chatSource} selectedAgent={{ name: 'AI' }} allMessages={stub<ComponentProps<typeof MessageItem>['allMessages']>([msg])} />);
        expect(screen.getByTestId('memory-used-toggle').textContent).toMatch(/Used 1 memory/);
    });
});

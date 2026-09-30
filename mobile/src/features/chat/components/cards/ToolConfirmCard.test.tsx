/** A held action: a notice where no decision can travel, buttons where one can, and the state it is in. */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderScreen } from '@/shared/testing/renderWithProviders';

import { ToolConfirmCard } from './ToolConfirmCard';

const CALL = { callId: 'c1', argsKey: 'k1', toolName: 'gmail_send', effect: 'sends', preview: { to: 'a@x.nl' }, status: 'pending' };

it('is a notice without a decision handler, as on the web', async () => {
    await renderScreen(<ToolConfirmCard calls={[CALL]} />);
    expect(screen.getByText('WANTED TO DO THIS — IT HAS NOT RUN')).toBeTruthy();
    expect(screen.getByText('leaves this workspace')).toBeTruthy();
    expect(screen.getByText('a@x.nl')).toBeTruthy();
    expect(screen.getByText('Nothing was done — this agent asks a person before actions like this.')).toBeTruthy();
    expect(screen.queryByText('Approve and run')).toBeNull();
});

it('decides through the handler, and shows this session’s decision', async () => {
    const onDecide = jest.fn();
    await renderScreen(<ToolConfirmCard calls={[CALL]} onDecide={onDecide} />);
    await fireEvent.press(screen.getByText('Approve and run'));
    expect(onDecide).toHaveBeenCalledWith(CALL, 'approve');

    await renderScreen(<ToolConfirmCard calls={[CALL]} onDecide={onDecide} decided={{ c1: 'approve' }} />);
    expect(screen.getByText('YOU APPROVED THIS — IT RUNS ON YOUR NEXT MESSAGE')).toBeTruthy();
});

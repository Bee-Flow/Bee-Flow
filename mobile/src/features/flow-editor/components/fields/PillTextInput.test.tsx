import { fireEvent, screen } from '@testing-library/react-native';
import React, { useState } from 'react';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { PillTextInput } from './PillTextInput';
import { shownText } from './testing';

jest.setTimeout(30_000);

const LABELS = new Map([['act_1', 'gmail search']]);
const TYPES = new Map([['act_1', 'ai_step']]);

function Harness({ initial, onRaw, expression = false }: { initial: string; onRaw: (raw: string) => void; expression?: boolean }) {
    const [text, setText] = useState(initial);
    return (
        <PillTextInput
            text={text}
            expression={expression}
            labels={LABELS}
            types={TYPES}
            onChangeText={(raw) => {
                setText(raw);
                onRaw(raw);
            }}
            testID="field"
        />
    );
}

const input = () => screen.getByTestId('field');
const select = (at: number) => fireEvent(input(), 'selectionChange', { nativeEvent: { selection: { start: at, end: at } } });
const pills = () => screen.queryAllByTestId('binding-pill');

describe('PillTextInput', () => {
    it('draws every reference as a pill inside the text', async () => {
        await renderWithProviders(<Harness initial="Hi {{trigger.output.name}}, {{steps.act_1.output.total}}" onRaw={jest.fn()} />);
        expect(shownText(input())).toBe('Hi  Trigger ▸ Name ,  gmail search ▸ Total ');
        expect(pills()).toHaveLength(2);
    });

    it('paints a pill in the colour of the step it points at', async () => {
        await renderWithProviders(<Harness initial="{{trigger.output.name}}{{steps.act_1.output.total}}{{steps.gone.output.x}}" onRaw={jest.fn()} />);
        const [trigger, step, gone] = pills().map((p) => StyleSheet.flatten(p.props.style));
        expect(trigger?.color).not.toBe(step?.color);
        expect(gone?.color).not.toBe(step?.color);
    });

    it('keeps a hand-typed reference as text while it is typed, and pills it when the caret leaves', async () => {
        const onRaw = jest.fn();
        await renderWithProviders(<Harness initial="Hi " onRaw={onRaw} />);
        await select(3);
        await fireEvent.changeText(input(), 'Hi {{trigger.output.name}}');
        expect(onRaw).toHaveBeenLastCalledWith('Hi {{trigger.output.name}}');
        // Still text: turning it into a pill now would move the caret mid-word.
        expect(pills()).toHaveLength(0);
        expect(shownText(input())).toBe('Hi {{trigger.output.name}}');
        await select(0);
        expect(pills()).toHaveLength(1);
        expect(shownText(input())).toBe('Hi  Trigger ▸ Name ');
        expect(onRaw).toHaveBeenLastCalledWith('Hi {{trigger.output.name}}');
    });

    it('pills what was being typed when the field loses focus', async () => {
        await renderWithProviders(<Harness initial="" onRaw={jest.fn()} />);
        await select(0);
        await fireEvent.changeText(input(), '{{trigger.output.name}}');
        expect(pills()).toHaveLength(0);
        await fireEvent(input(), 'blur', { nativeEvent: {} });
        expect(pills()).toHaveLength(1);
    });

    it('keeps typing after a pill as text around it', async () => {
        const onRaw = jest.fn();
        await renderWithProviders(<Harness initial="{{trigger.output.name}}" onRaw={onRaw} />);
        const end = shownText(input()).length;
        await select(end);
        await fireEvent.changeText(input(), `${shownText(input()).replace(/ /g, ' ')}!`);
        expect(onRaw).toHaveBeenLastCalledWith('{{trigger.output.name}}!');
        expect(pills()).toHaveLength(1);
    });

    it('pills the bare paths of a formula', async () => {
        await renderWithProviders(<Harness initial="steps.act_1.output.total > 100" onRaw={jest.fn()} expression />);
        expect(shownText(input())).toBe(' gmail search ▸ Total  > 100');
    });

    it('shows the placeholder when empty', async () => {
        await renderWithProviders(<PillTextInput text="" expression={false} labels={LABELS} onChangeText={jest.fn()} placeholder="Type here" testID="field" />);
        expect(input().props.placeholder).toBe('Type here');
        expect(shownText(input())).toBe('');
    });
});

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { runtimeValue } from '@/test/appRuntime';
import { appDesignProps } from '../appDesign';
import { RuntimeProvider } from '../RuntimeContext';
import AppModal, { openAppModal } from './AppModal';
import type { ComponentProps } from 'react';

/**
 * design.motion 'expressive' (since 3): the class the roots carry, and the one the portaled
 * dialog carries. 'full' stays what it always was, a class no rule reads.
 */

describe('motion classes on the roots', () => {
    it('expressive stamps its own class, full keeps its hook, subtle and none are unchanged', () => {
        expect(appDesignProps({ design: { motion: 'expressive' } }).className).toBe('app-motion--expressive');
        expect(appDesignProps({ design: { motion: 'full' } }).className).toBe('app-motion--full');
        expect(appDesignProps({ design: { motion: 'subtle' } }).className).toBe('');
        expect(appDesignProps({ design: { motion: 'none' } }).className).toBe('app-motion--none');
        expect(appDesignProps({ design: { motion: 'wild' } }).className).toBe('');
        expect(appDesignProps({}).className).toBe('');
    });
});

type ModalNode = ComponentProps<typeof AppModal>['node'];

function dialog(motion: string | null, placement = 'center') {
    const node = { id: 'cmp_modal001', type: 'modal', props: { title: 'Hello', placement }, style: {}, children: [] } as unknown as ModalNode;
    const value = runtimeValue({ mode: 'run', appDesign: motion ? { motion } : null });
    const { unmount } = render(<RuntimeProvider value={value}><AppModal node={node}>{null}</AppModal></RuntimeProvider>);
    act(() => openAppModal('cmp_modal001'));
    const className = screen.getByRole('dialog').className;
    unmount();
    return className;
}

describe('the dialog panel', () => {
    it('eases in under expressive motion when it is centred', () => {
        expect(dialog('expressive')).toContain('app-modal--expressive');
    });

    it('is untouched under every other motion setting and without a design', () => {
        for (const motion of ['full', 'subtle', 'none', null]) {
            expect(dialog(motion)).not.toContain('app-modal--expressive');
        }
    });

    it('keeps its own slide when it sits against an edge', () => {
        expect(dialog('expressive', 'right')).not.toContain('app-modal--expressive');
    });
});

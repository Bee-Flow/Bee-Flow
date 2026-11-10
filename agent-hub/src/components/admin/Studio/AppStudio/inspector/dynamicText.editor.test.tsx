import { fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import ThemePanel from './ThemePanel';
import SequenceEffects from './SequenceEffects';
import { isBareHost, parseLinkHosts, updateAllowedLinkHosts } from '../state/linkHostOps';
import { malformed, stub } from '@/test/mocks';

/**
 * The human side of the dynamic-text additions: the owner's list of hosts a formula link may open
 * (App settings), the effects of a sequence (On success / On error), and the helpers behind them.
 */

const DEF = {
    schemaVersion: 2,
    meta: { name: 'T', description: '', icon: null },
    theme: {},
    homeScreenId: 'scr_1',
    screens: [{ id: 'scr_1', name: 'One', maxWidth: 'medium', refreshInterval: 0, showInNav: true, icon: null, sections: [] }],
    actions: {},
};

describe('link host helpers', () => {
    it('accepts bare host names only', () => {
        expect(['example.com', 'a.b-c.org', 'localhost'].every(isBareHost)).toBe(true);
        expect(['', 'https://x.com', 'x.com/path', 'x.com:8080', '*.x.com', 'bad host', '-a.com', 'a..b'].some(isBareHost)).toBe(false);
    });

    it('splits lines and commas, lowercases, drops repeats and reports what it refused', () => {
        expect(parseLinkHosts('Example.com\n\n docs.example.com , example.com\nhttps://x.com')).toEqual({
            hosts: ['example.com', 'docs.example.com'],
            refused: ['https://x.com'],
        });
    });

    it('writes the key only when there is a list, and removes it when the list is emptied', () => {
        const base = malformed<Parameters<typeof updateAllowedLinkHosts>[0]>(DEF);
        const withHosts = updateAllowedLinkHosts(base, ['example.com']);
        expect(withHosts.allowedLinkHosts).toEqual(['example.com']);
        expect(updateAllowedLinkHosts(withHosts, ['example.com'])).toBe(withHosts);
        const emptied = updateAllowedLinkHosts(withHosts, []);
        expect('allowedLinkHosts' in emptied).toBe(false);
        expect(updateAllowedLinkHosts(base, [])).toBe(base);
    });
});

describe('ThemePanel: links from formulas', () => {
    function renderPanel(definition: Record<string, unknown> = DEF) {
        const onCommit = vi.fn();
        const utils = render(<ThemePanel definition={stub<ComponentProps<typeof ThemePanel>['definition']>(definition)} onCommit={onCommit} screenId="scr_1" />);
        return { onCommit, ...utils };
    }

    it('shows an empty list on an app that never set one, and says only the owner can change it', () => {
        const { getByLabelText, getByText } = renderPanel();
        expect((getByLabelText('Hosts a link may open') as HTMLTextAreaElement).value).toBe('');
        expect(getByText(/Only you can change this list; the AI has no way to edit it/i)).toBeTruthy();
    });

    it('commits the parsed list on blur', async () => {
        const user = userEvent.setup();
        const { onCommit, getByLabelText } = renderPanel();
        const box = getByLabelText('Hosts a link may open');
        await user.type(box, 'Example.com\ndocs.example.com');
        fireEvent.blur(box);
        expect(onCommit.mock.calls.at(-1)![0].allowedLinkHosts).toEqual(['example.com', 'docs.example.com']);
    });

    it('leaves out a host that is not a bare name, and says so', async () => {
        const user = userEvent.setup();
        const { onCommit, getByLabelText, findByText } = renderPanel();
        const box = getByLabelText('Hosts a link may open');
        await user.type(box, 'https://example.com');
        fireEvent.blur(box);
        expect(await findByText(/Left out: https:\/\/example.com/)).toBeTruthy();
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('commits nothing for an app that stays empty', () => {
        const { onCommit, getByLabelText } = renderPanel();
        fireEvent.blur(getByLabelText('Hosts a link may open'));
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('shows the existing hosts, one per line', () => {
        const { getByLabelText } = renderPanel({ ...DEF, allowedLinkHosts: ['example.com', 'docs.example.com'] });
        expect((getByLabelText('Hosts a link may open') as HTMLTextAreaElement).value).toBe('example.com\ndocs.example.com');
    });
});

describe('SequenceEffects', () => {
    const action = { kind: 'sequence', steps: [] };

    function renderEffects(a: Record<string, unknown> = action) {
        const commitAction = vi.fn();
        const utils = render(<SequenceEffects action={stub<ComponentProps<typeof SequenceEffects>['action']>(a)} commitAction={commitAction} definition={stub<ComponentProps<typeof SequenceEffects>['definition']>(DEF)} />);
        return { commitAction, ...utils };
    }

    it('writes an onSuccess toast and leaves onError out', async () => {
        const user = userEvent.setup();
        const { commitAction, getByRole, getByLabelText } = renderEffects();
        await user.click(getByRole('button', { name: /When it ends/i }));
        await user.type(getByLabelText('On success toast message'), 'x');
        const next = commitAction.mock.calls.at(-1)![0];
        expect(next.onSuccess).toEqual({ toast: { message: 'x', tone: 'info' } });
        expect('onError' in next).toBe(false);
    });

    it('removes the slot again when the effect is emptied, so a sequence without effects stays as it was', async () => {
        const user = userEvent.setup();
        const { commitAction, getByRole, getByLabelText } = renderEffects({ ...action, onSuccess: { toast: { message: 'x', tone: 'info' } } });
        await user.click(getByRole('button', { name: /When it ends/i }));
        await user.clear(getByLabelText('On success toast message'));
        const next = commitAction.mock.calls.at(-1)![0];
        expect('onSuccess' in next).toBe(false);
        expect(next).toEqual({ kind: 'sequence', steps: [] });
    });
});

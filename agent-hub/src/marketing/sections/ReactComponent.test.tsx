import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { EXTRA_SECTIONS } from './extraSections';
import ReactComponent, { DEFAULT_MIN_HEIGHT, frameMinHeight } from './ReactComponent';

const COMPILED = 'module.exports.default = function () { return null; };';

function asPreview(on: boolean) {
    window.history.replaceState({}, '', on ? '/?preview=1' : '/');
}

afterEach(() => asPreview(false));

describe('ReactComponent section', () => {
    it('is registered for the react-component block type', () => {
        expect(EXTRA_SECTIONS['react-component']).toBeTypeOf('function');
    });

    it('renders nothing on the public site without compiled code', () => {
        const { container } = render(<ReactComponent data={{ compiled: '', compileError: 'component.tsx:1:1: boom' }} />);
        expect(container.innerHTML).toBe('');
    });

    it('shows the compile error in the editor preview instead of a frame', () => {
        asPreview(true);
        render(<ReactComponent data={{ compiled: '', compileError: 'component.tsx:3:7: Expected ";"' }} />);
        expect(screen.getByRole('status')).toHaveTextContent('does not compile yet');
        expect(screen.getByText('component.tsx:3:7: Expected ";"')).toBeInTheDocument();
        expect(document.querySelector('iframe')).toBeNull();
    });

    it('renders the sandboxed frame with the self-hosted runtime, the theme and resolved props', async () => {
        const { container } = render(
            <ReactComponent
                data={{
                    compiled: COMPILED,
                    css: '.card{gap:4px}',
                    fields: [{ name: 'photo', type: 'image' }],
                    props: { photo: 'cms/a.png', title: 'Hi' },
                    width: 'full',
                    minHeight: 320,
                }}
            />,
        );
        const frame = container.querySelector('iframe[data-cms-frame="react"]') as HTMLIFrameElement;
        expect(frame).not.toBeNull();
        expect(frame.getAttribute('height')).toBe('320');
        expect(container.querySelector('.react-component-block__full')).not.toBeNull();
        await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('__bfReactMount=')); // the runtime arrived
        const html = frame.getAttribute('srcdoc') || '';
        expect(html).toContain('--bf-primary:');
        expect(html).toContain('.card{gap:4px}');
        expect(html).toContain(`"photo":"${window.location.origin}/api/cms/asset/cms/a.png"`);
        expect(html).toContain('{"mode":"public"}');
    });

    it('uses the content width by default and mounts in editor mode inside the preview', async () => {
        asPreview(true);
        const { container } = render(<ReactComponent data={{ compiled: COMPILED }} />);
        expect(container.querySelector('.container iframe')).not.toBeNull();
        const frame = container.querySelector('iframe') as HTMLIFrameElement;
        await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('{"mode":"editor"}'));
    });

    it('a disabled block renders nothing', () => {
        const { container } = render(<ReactComponent data={{ enabled: false, compiled: COMPILED }} />);
        expect(container.innerHTML).toBe('');
    });
});

describe('frameMinHeight', () => {
    it('defaults, rounds and clamps', () => {
        expect(frameMinHeight(undefined)).toBe(DEFAULT_MIN_HEIGHT);
        expect(frameMinHeight('abc')).toBe(DEFAULT_MIN_HEIGHT);
        expect(frameMinHeight(99.6)).toBe(100);
        expect(frameMinHeight(-5)).toBe(0);
        expect(frameMinHeight(10 ** 6)).toBe(4000);
    });
});

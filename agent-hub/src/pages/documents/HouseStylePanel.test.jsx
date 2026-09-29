import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The house style is an ORG setting edited by one person and worn by everyone
 * else's documents. So the two things worth proving here are that a reader
 * cannot be led into a Save that will 403, and that the master switch really is
 * a switch rather than a decoration.
 */

const { api } = vi.hoisted(() => ({
    api: {
        getHouseStyle: vi.fn(),
        saveHouseStyle: vi.fn(),
        fileToDataUrl: vi.fn(),
        previewDeckTheme: vi.fn(),
        uploadDeckTemplate: vi.fn(),
    },
}));
vi.mock('./documentsApi', () => api);
vi.mock('../../hooks/useTranslation', () => {
    const useTranslation = () => ({ t: (k, fb) => fb || k, locale: 'en' });
    return { default: useTranslation, useTranslation };
});

const HouseStylePanel = (await import('./HouseStylePanel')).default;

const STYLE = {
    enabled: true,
    accent: '#123a5e', ink: '#1a1d21', muted: '#6b7280',
    font: 'sans', logoDataUrl: '', logoWidthMm: 24,
    companyName: 'Van Dijk Groep', companyTagline: '', companyAddress: '',
    companyEmail: '', companyPhone: '', companyWebsite: '',
    companyVat: '', companyChamber: '', companyIban: '', footerText: '',
};

const body = (over = {}) => ({
    style: { ...STYLE, ...(over.style || {}) },
    hasOrg: over.hasOrg ?? true,
    editable: over.editable ?? true,
    fonts: ['sans', 'serif', 'mono'],
    maxLogoBytes: 262144,
});

const THEME = {
    preset: 'band', accent: '#123A5E', background: '#FFFFFF', text: '#1A1D21', muted: '#6B7280', onAccent: '#FFFFFF', accentOnSlide: '#123A5E',
    titleStyle: 'band', bandColor: '#123A5E', titleColor: '#FFFFFF', fontStack: 'Calibri, sans-serif', titleFontStack: 'Calibri, sans-serif',
    coverStyle: 'accent', tableStyle: 'banded', tableHeaderFill: '#123A5E', tableHeaderText: '#FFFFFF', tableBand: '#F0F3F7', tableLine: '#D5D8DC',
    logoDataUrl: '', logoPlacement: 'none', slideNumbers: true, brandOnSlides: true, brandName: 'Van Dijk Groep', footerText: '',
};

beforeEach(() => {
    api.getHouseStyle.mockReset().mockResolvedValue(body());
    api.saveHouseStyle.mockReset().mockImplementation(async (s) => s);
    api.fileToDataUrl.mockReset().mockResolvedValue('data:image/png;base64,AAA');
    api.previewDeckTheme.mockReset().mockResolvedValue(THEME);
});
afterEach(cleanup);

async function renderPanel(over) {
    if (over) api.getHouseStyle.mockResolvedValue(body(over));
    const out = render(<HouseStylePanel onBack={() => {}} />);
    await screen.findByTestId('house-style-enabled');
    return out;
}

describe('HouseStylePanel — who may change it', () => {
    it('an admin gets editable fields and a Save', async () => {
        await renderPanel();
        expect(screen.getByTestId('house-style-enabled')).not.toBeDisabled();
        expect(screen.getByTestId('house-style-save')).toBeTruthy();
    });

    it('a non-admin sees the values but no Save at all', async () => {
        // Not a disabled Save — no Save. Offering a button that will 403 is
        // worse than not offering one.
        await renderPanel({ editable: false });
        expect(screen.getByTestId('house-style-enabled')).toBeDisabled();
        expect(screen.queryByTestId('house-style-save')).toBeNull();
        expect(screen.getByText(/Only an organisation administrator/i)).toBeTruthy();
    });

    it('says plainly when the account is in no organisation', async () => {
        await renderPanel({ hasOrg: false, editable: false });
        expect(screen.getByText(/belongs to an organisation/i)).toBeTruthy();
    });
});

describe('HouseStylePanel — the master switch', () => {
    it('saves the flipped value', async () => {
        await renderPanel();
        fireEvent.click(screen.getByTestId('house-style-enabled'));
        fireEvent.click(screen.getByTestId('house-style-save'));
        await waitFor(() => expect(api.saveHouseStyle).toHaveBeenCalled());
        expect(api.saveHouseStyle.mock.calls[0][0].enabled).toBe(false);
    });

    it('confirms the save rather than leaving the user guessing', async () => {
        await renderPanel();
        fireEvent.click(screen.getByTestId('house-style-save'));
        expect(await screen.findByText(/Saved\. New documents will use it\./i)).toBeTruthy();
    });

    it('surfaces a failed save and keeps the edits on screen', async () => {
        await renderPanel();
        api.saveHouseStyle.mockRejectedValue(new Error('Only an org admin may do that.'));
        fireEvent.click(screen.getByTestId('house-style-save'));
        expect(await screen.findByText('Only an org admin may do that.')).toBeTruthy();
    });
});

describe('HouseStylePanel — the logo', () => {
    it('reads a chosen file into a data URL rather than a path', async () => {
        // The logo must travel as BYTES: the composer strips every remote url()
        // because the PDF renders in a Chromium on the server.
        await renderPanel();
        const file = new File(['x'], 'logo.png', { type: 'image/png' });
        Object.defineProperty(file, 'size', { value: 1024 });
        fireEvent.change(screen.getByTestId('house-style-logo-input'), { target: { files: [file] } });
        await waitFor(() => expect(api.fileToDataUrl).toHaveBeenCalledWith(file));
        await waitFor(() => expect(screen.getByTestId('house-style-logo')).toBeTruthy());
    });

    it('refuses an oversized file before reading it, with the sizes named', async () => {
        await renderPanel();
        const file = new File(['x'], 'huge.png', { type: 'image/png' });
        Object.defineProperty(file, 'size', { value: 900 * 1024 });
        fireEvent.change(screen.getByTestId('house-style-logo-input'), { target: { files: [file] } });
        expect(await screen.findByText(/900 KB; the limit is 256 KB/)).toBeTruthy();
        expect(api.fileToDataUrl).not.toHaveBeenCalled();
    });

    it('can take the logo back off', async () => {
        await renderPanel({ style: { logoDataUrl: 'data:image/png;base64,AAA' } });
        expect(screen.getByTestId('house-style-logo')).toBeTruthy();
        fireEvent.click(screen.getByText('Remove'));
        expect(screen.queryByTestId('house-style-logo')).toBeNull();
    });
});

describe('HouseStylePanel — the fields', () => {
    it('shows the CSS variable beside each colour, because that is what the AI writes', async () => {
        await renderPanel();
        expect(screen.getByText('--doc-accent')).toBeTruthy();
        expect(screen.getByText('--doc-font')).toBeTruthy();
    });

    it('edits a company detail into the payload', async () => {
        await renderPanel();
        fireEvent.change(screen.getByDisplayValue('Van Dijk Groep'), { target: { value: 'Van Dijk Staal BV' } });
        fireEvent.click(screen.getByTestId('house-style-save'));
        await waitFor(() => expect(api.saveHouseStyle).toHaveBeenCalled());
        expect(api.saveHouseStyle.mock.calls[0][0].companyName).toBe('Van Dijk Staal BV');
    });
});

describe('HouseStylePanel — presentations', () => {
    it('draws the preview from the SERVER-resolved theme and re-asks after an edit', async () => {
        await renderPanel();
        await waitFor(() => expect(screen.getByTestId('deck-preview')).toBeInTheDocument());
        expect(api.previewDeckTheme).toHaveBeenCalled();
        const before = api.previewDeckTheme.mock.calls.length;
        fireEvent.click(screen.getByTestId('house-style-deck-preset-dark'));
        await waitFor(() => expect(api.previewDeckTheme.mock.calls.length).toBeGreaterThan(before));
        const sent = api.previewDeckTheme.mock.calls.at(-1)[0];
        expect(sent.deck.preset).toBe('dark');
    });

    it('saves the deck choices with the letterhead, blanks meaning "same as documents"', async () => {
        await renderPanel();
        fireEvent.click(screen.getByTestId('house-style-deck-preset-clean'));
        fireEvent.change(screen.getByTestId('house-style-deck-tableStyle'), { target: { value: 'lines' } });
        fireEvent.change(screen.getByTestId('house-style-deck-footer'), { target: { value: 'Vertrouwelijk' } });
        fireEvent.click(screen.getByTestId('house-style-deck-numbers'));
        fireEvent.click(screen.getByTestId('house-style-save'));
        await waitFor(() => expect(api.saveHouseStyle).toHaveBeenCalled());
        const saved = api.saveHouseStyle.mock.calls[0][0];
        expect(saved.deck).toMatchObject({ preset: 'clean', tableStyle: 'lines', footerText: 'Vertrouwelijk', slideNumbers: false, accent: '' });
    });

    it('a reader sees the presentation controls disabled like the rest', async () => {
        await renderPanel({ editable: false });
        expect(screen.getByTestId('house-style-deck-preset-bold')).toBeDisabled();
        expect(screen.getByTestId('house-style-deck-tableStyle')).toBeDisabled();
    });
});

describe('HouseStylePanel — the template deck', () => {
    it('uploads a .pptx, shows its name and previews on its backdrop; Remove takes it off', async () => {
        const template = { name: 'Conf 2026', aspect: 1.78, cover: { image: 'data:image/jpeg;base64,AAA', overlays: [] }, content: { image: 'data:image/jpeg;base64,AAA', overlays: [{ image: 'data:image/png;base64,BBB', x: 0.03, y: 0.04, w: 0.1, h: 0.18 }] }, background: '#0F96E0', text: '#FFFFFF', fonts: { title: '', body: '' } };
        api.uploadDeckTemplate.mockResolvedValue(template);
        api.previewDeckTheme.mockResolvedValue({ ...THEME, template, text: '#FFFFFF', titleStyle: 'plain', background: '#0F96E0' });
        await renderPanel();
        const file = new File(['x'], 'Conf 2026.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
        fireEvent.change(screen.getByTestId('house-style-deck-template-file'), { target: { files: [file] } });
        await waitFor(() => expect(api.uploadDeckTemplate).toHaveBeenCalledWith('data:image/png;base64,AAA', 'Conf 2026.pptx'));
        expect(await screen.findByText('Conf 2026')).toBeTruthy();
        await waitFor(() => expect(document.querySelector('[data-template="yes"]')).toBeTruthy());
        fireEvent.click(screen.getByTestId('house-style-deck-template-remove'));
        expect(screen.queryByTestId('house-style-deck-template')).toBeNull();
        expect(screen.getByTestId('house-style-deck-template-file')).toBeTruthy();
    });

    it('suggests the template\'s brand colour and typefaces for the house style, applied in one click', async () => {
        const template = { name: 'Conf', aspect: 1.78, cover: { image: 'data:image/jpeg;base64,AAA', overlays: [] }, content: { image: 'data:image/jpeg;base64,AAA', overlays: [] }, background: '#0F96E0', accent: '#0489D2', text: '#FFFFFF', fonts: { title: 'Georgia', body: 'Georgia' } };
        api.uploadDeckTemplate.mockResolvedValue(template);
        await renderPanel();
        fireEvent.change(screen.getByTestId('house-style-deck-template-file'), { target: { files: [new File(['x'], 'Conf.pptx')] } });
        const box = await screen.findByTestId('house-style-template-suggestions');
        expect(box.textContent).toMatch(/#0489D2/);
        expect(box.textContent).toMatch(/Georgia/);
        fireEvent.click(screen.getByTestId('house-style-template-apply'));
        await waitFor(() => expect(screen.getByDisplayValue('#0489D2')).toBeTruthy());
        expect(screen.getByTestId('house-style-deck-titleFont').value).toBe('Georgia');
        expect(screen.queryByTestId('house-style-template-suggestions')).toBeNull();
    });

    it('says why a deck could not be used', async () => {
        api.uploadDeckTemplate.mockRejectedValue(new Error('No background pictures were found in the first slides of that deck'));
        await renderPanel();
        fireEvent.change(screen.getByTestId('house-style-deck-template-file'), { target: { files: [new File(['x'], 'plain.pptx')] } });
        expect(await screen.findByTestId('house-style-deck-template-error')).toBeTruthy();
    });
});

/**
 * Presentation — the web's PresentationFields
 * (actionEditors/presentationFields.jsx): slides in (ONE source, or a list of
 * Slide step references — the toggle only changes how `slides` is edited),
 * a PowerPoint or PDF deck out, and the deck's look, where blank always means
 * "the house style decides".
 */

import type { FormDraft } from '@/features/flow-editor/formState';

import { msg, type EditorSpec, type OptionSpec } from '../spec';
import { KEEP_DECK_FOR } from './common';

/** The web's DECK_FONT_OPTIONS — typeface names, not words. */
export const DECK_FONTS = [
    'Calibri', 'Arial', 'Helvetica', 'Verdana', 'Segoe UI', 'Trebuchet MS', 'Century Gothic', 'Georgia', 'Cambria',
    'Times New Roman', 'Garamond', 'Consolas',
] as const;

const HOUSE = msg('mobile.flow.deck.house_style', 'House style');
const fonts = (first: OptionSpec): OptionSpec[] => [first, ...DECK_FONTS.map((f) => ({ value: f, label: f }))];
const lookSet = (draft: FormDraft) =>
    ['preset', 'accent', 'background', 'font', 'titleFont', 'coverStyle', 'tableStyle', 'logo', 'logoPlacement', 'footerText', 'slideNumbers', 'template']
        .some((k) => !!draft[k]) || draft.houseStyle === false;

export const PRESENTATION: EditorSpec = {
    type: 'presentation',
    sections: [
        {
            key: 'slides',
            title: msg('mobile.flow.deck.slides', 'Slides'),
            defaultOpen: true,
            fields: [
                {
                    kind: 'segmented',
                    key: 'slidesMode',
                    options: [
                        { value: 'source', label: msg('mobile.flow.deck.one_source', 'One source') },
                        { value: 'list', label: msg('mobile.flow.deck.pick_slides', 'Pick slides') },
                    ],
                },
                {
                    kind: 'template',
                    key: 'slides',
                    multiline: true,
                    required: true,
                    visibleWhen: (draft) => draft.slidesMode !== 'list',
                    example: '{{steps.ai_1.output.text}}',
                    label: msg('mobile.flow.deck.slides_from', 'Slides from'),
                    hint: msg(
                        'mobile.flow.deck.slides_from_hint',
                        'The outline an AI step wrote ("# " title, "## " per slide, "- " bullets), or the results of a Slide step that runs once per item.',
                    ),
                },
                {
                    kind: 'list',
                    key: 'slideRows',
                    required: true,
                    visibleWhen: (draft) => draft.slidesMode === 'list',
                    example: '{{steps.slide_1.output.slide}}',
                    label: msg('mobile.flow.deck.slides', 'Slides'),
                    hint: msg('mobile.flow.deck.rows_hint', 'One Slide step per row, in order. Each row is a whole reference to that step’s slide.'),
                },
            ],
        },
        {
            key: 'output',
            title: msg('mobile.flow.section.the_file', 'The file'),
            defaultOpen: true,
            fields: [
                {
                    kind: 'select',
                    key: 'format',
                    required: true,
                    label: msg('mobile.flow.doc.format', 'Format'),
                    options: [
                        { value: 'pptx', label: msg('mobile.flow.doc.pptx', 'PowerPoint (.pptx)') },
                        { value: 'pdf', label: msg('mobile.flow.doc.pdf_deck', 'PDF deck') },
                    ],
                },
                {
                    kind: 'template',
                    key: 'title',
                    example: 'Kwartaalcijfers {{trigger.output.kwartaal}}',
                    label: msg('mobile.flow.doc.title', 'Title'),
                    hint: msg('mobile.flow.deck.title_hint', 'The cover title, and the filename when you leave that blank. Falls back to the outline’s own title.'),
                },
                { kind: 'template', key: 'subtitle', label: msg('mobile.flow.deck.subtitle', 'Subtitle'), hint: msg('mobile.flow.deck.subtitle_hint', 'On the cover: audience, date, author.') },
                {
                    kind: 'template',
                    key: 'fileName',
                    example: 'kwartaalcijfers-{{trigger.output.kwartaal}}',
                    label: msg('mobile.flow.doc.file_name', 'Filename'),
                    hint: msg('mobile.flow.doc.file_name_hint', 'Without the extension — that follows from the format.'),
                },
            ],
        },
        {
            key: 'options',
            title: msg('mobile.flow.deck.look', 'Look'),
            hasContent: lookSet,
            fields: [
                {
                    kind: 'toggle',
                    key: 'houseStyle',
                    label: msg('mobile.flow.deck.use_house_style', 'Use the house style'),
                    description: msg(
                        'mobile.flow.deck.house_style_hint',
                        'Your organisation’s colours, font, logo and footer — set under Studio → Documents → House style. Switch off only for a deck in someone else’s branding.',
                    ),
                },
                {
                    kind: 'select',
                    key: 'preset',
                    label: msg('mobile.flow.deck.style', 'Style'),
                    hint: msg('mobile.flow.deck.style_hint', 'Leave on “house style” to follow the organisation’s choice; pick one to override it for this deck.'),
                    options: [
                        { value: '', label: HOUSE },
                        { value: 'band', label: msg('mobile.flow.deck.band', 'Title band — white slides, coloured title band') },
                        { value: 'clean', label: msg('mobile.flow.deck.clean', 'Clean — white slides, accent titles') },
                        { value: 'bold', label: msg('mobile.flow.deck.bold', 'Bold — accent-coloured slides') },
                        { value: 'dark', label: msg('mobile.flow.deck.dark', 'Dark — charcoal slides') },
                    ],
                },
                {
                    kind: 'template',
                    key: 'accent',
                    example: '#1A73E8',
                    label: msg('mobile.flow.deck.accent', 'Accent colour'),
                    hint: msg('mobile.flow.deck.accent_hint', '#RRGGBB, or a value from an earlier step. Blank = the house style’s accent.'),
                },
                { kind: 'select', key: 'font', label: msg('mobile.flow.deck.font', 'Typeface'), options: fonts({ value: '', label: HOUSE }) },
                {
                    kind: 'template',
                    key: 'logo',
                    example: '{{steps.image_1.output.imageUrl}}',
                    label: msg('mobile.flow.deck.logo', 'Logo'),
                    hint: msg(
                        'mobile.flow.deck.logo_hint',
                        'The image URL a Generate image step produced, a data: URL, or "none" to leave the house-style logo off. Blank = the house-style logo.',
                    ),
                },
                {
                    kind: 'select',
                    key: 'logoPlacement',
                    label: msg('mobile.flow.deck.logo_placement', 'Logo placement'),
                    options: [
                        { value: '', label: HOUSE },
                        { value: 'footer', label: msg('mobile.flow.deck.footer', 'Footer') },
                        { value: 'corner', label: msg('mobile.flow.deck.corner', 'Top corner') },
                        { value: 'cover', label: msg('mobile.flow.deck.cover_only', 'Cover only') },
                        { value: 'none', label: msg('mobile.flow.deck.nowhere', 'Nowhere') },
                    ],
                },
                {
                    kind: 'select',
                    key: 'coverStyle',
                    label: msg('mobile.flow.deck.cover', 'Cover'),
                    options: [
                        { value: '', label: HOUSE },
                        { value: 'accent', label: msg('mobile.flow.deck.accent_block', 'Accent block') },
                        { value: 'light', label: msg('mobile.flow.deck.light', 'Light') },
                        { value: 'split', label: msg('mobile.flow.deck.split', 'Split panel') },
                    ],
                },
                {
                    kind: 'select',
                    key: 'tableStyle',
                    label: msg('mobile.flow.deck.tables', 'Tables'),
                    options: [
                        { value: '', label: HOUSE },
                        { value: 'banded', label: msg('mobile.flow.deck.banded', 'Banded rows') },
                        { value: 'lines', label: msg('mobile.flow.deck.lines', 'Lines') },
                        { value: 'minimal', label: msg('mobile.flow.deck.minimal', 'Minimal') },
                    ],
                },
                {
                    kind: 'template',
                    key: 'background',
                    example: '#FFFFFF',
                    label: msg('mobile.flow.deck.background', 'Background'),
                    hint: msg('mobile.flow.deck.background_hint', '#RRGGBB or a value from an earlier step; text colours adapt so they stay readable.'),
                },
                {
                    kind: 'select',
                    key: 'titleFont',
                    label: msg('mobile.flow.deck.title_font', 'Title typeface'),
                    options: fonts({ value: '', label: msg('mobile.flow.deck.same_as_body', 'Same as the body') }),
                },
                {
                    kind: 'template',
                    key: 'footerText',
                    example: 'Vertrouwelijk · {{trigger.output.date}}',
                    label: msg('mobile.flow.deck.footer_line', 'Footer line'),
                    hint: msg('mobile.flow.deck.footer_line_hint', 'Shown small on every slide, e.g. “Vertrouwelijk · Q3 2026”. Blank = the house-style footer.'),
                },
                {
                    kind: 'select',
                    key: 'slideNumbers',
                    label: msg('mobile.flow.deck.slide_numbers', 'Slide numbers'),
                    options: [
                        { value: '', label: HOUSE },
                        { value: 'true', label: msg('mobile.flow.deck.shown', 'Shown') },
                        { value: 'false', label: msg('mobile.flow.deck.hidden', 'Hidden') },
                    ],
                },
                {
                    kind: 'select',
                    key: 'template',
                    label: msg('mobile.flow.deck.template', 'Template deck'),
                    hint: msg(
                        'mobile.flow.deck.template_hint',
                        'The .pptx uploaded under House style → Presentations paints its backgrounds and logo under every slide. Choose plain slides to build without it.',
                    ),
                    options: [
                        { value: '', label: msg('mobile.flow.deck.template_house', 'House style (template when uploaded)') },
                        { value: 'none', label: msg('mobile.flow.deck.template_none', 'Plain slides — no template') },
                    ],
                },
                {
                    kind: 'toggle',
                    key: 'saveCopy',
                    label: msg('mobile.flow.doc.keep_copy', 'Also keep it in Documents'),
                    description: msg(
                        'mobile.flow.deck.keep_copy_hint',
                        'Keeps the deck in Studio → Documents as a presentation you can open in Bee Flow, edit and rebuild. Leave it off for an automation that runs often — it makes a document every run.',
                    ),
                },
                {
                    kind: 'template',
                    key: 'copyName',
                    example: 'Kwartaalcijfers {{trigger.date}}',
                    visibleWhen: (draft) => draft.saveCopy === true,
                    label: msg('mobile.flow.doc.copy_name', 'Name of the copy'),
                    hint: msg('mobile.flow.deck.copy_name_hint', 'Defaults to the title plus today’s date.'),
                },
                KEEP_DECK_FOR,
            ],
        },
    ],
};

/**
 * How much of the Studio component catalog the phone draws, stated as lists.
 *
 * The catalog lives in server/appStudio/componentSpecs.js (52 types, enforced
 * on save and publish). catalogLockstep.test.ts partitions it into what the
 * phone handles, what is deliberately left to the browser, and what is simply
 * not built yet — and fails when a new component belongs to none of the three.
 */

/** The input types this client knows how to draw, from FORM_SPECS. */
export const SUPPORTED_INPUTS = [
    'input_text',
    'input_textarea',
    'input_number',
    'input_select',
    'input_checkbox',
    'input_date',
] as const;

export type SupportedInput = (typeof SUPPORTED_INPUTS)[number];

/**
 * Every catalog type this client HANDLES — draws as a block, or walks through.
 *
 * Must match BLOCK_BUILDERS in appDefinition.ts. It is a second list rather
 * than the table itself because the alternative this codebase had was no list,
 * and a coverage gap that widened silently every time the server catalog grew.
 * Adding a component on the server fails a mobile test until someone decides
 * what the phone should do with it.
 */
export const HANDLED_TYPES = [
    'page_header',
    'spacer',
    'heading',
    'text',
    'callout',
    'stat',
    'divider',
    'form',
    'button',
    'card',
    'container',
    ...SUPPORTED_INPUTS,
] as const;

/**
 * Types deliberately left to the browser, with the reason. These are not a
 * to-do list: a fake kanban on a 390px screen is worse than an honest
 * "open this on a desktop".
 */
export const BROWSER_ONLY_TYPES: Readonly<Record<string, string>> = {
    kanban: 'Cross-column drag needs a canvas; the phone answer is a status picker on the record.',
    pivot: 'A cross-tab needs two axes and one of them does not fit.',
    browser_view: 'A desktop viewport streamed as JPEG and scaled to phone width is unreadable.',
    file_preview: 'Renders through a same-origin blob: URL in an iframe — neither exists in React Native.',
};

export function isSupportedInput(type: string): type is SupportedInput {
    return (SUPPORTED_INPUTS as readonly string[]).includes(type);
}

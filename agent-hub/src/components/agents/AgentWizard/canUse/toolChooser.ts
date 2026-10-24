/**
 * The TYPED call of the tool picker (Agents artboard 1f).
 *
 * The picker itself is built in A2 step 4. What is here is the seam between them: the sections it knows,
 * and a builder that makes a request or returns `null`. That way the section name lives in one place,
 * instead of as a loose string on every "+ Link" button, and a typo does not silently open the wrong section
 * but yields `null`, which the caller is forced to handle.
 *
 * Why now, while nothing opens yet: the buttons do exist, and a button that today opens an old popover
 * directly will not be findable three stages later. This module is the place where step 4 replaces one line.
 */

/** De secties van de kiezer, in artboardvolgorde (apps eerst, dan "Uit Studio"). */
export const CHOOSER_SECTION = Object.freeze({
    APPS: 'apps',
    AUTOMATIONS: 'studio.automations',
    DATATABLES: 'studio.datatables',
    KNOWLEDGE_BASES: 'studio.knowledge_bases',
    SKILLS: 'studio.skills',
});

const SECTIONS: readonly string[] = Object.freeze(Object.values(CHOOSER_SECTION));

/**
 * Een aanvraag om de kiezer op een sectie te openen.
 *
 * @param section  één van CHOOSER_SECTION
 * @param opts.appId de app waarvan de acties meteen openstaan
 */
export function chooserRequest(section: string, opts: { appId?: string | null } = {}): { section: string; appId: string | null } | null {
    if (!SECTIONS.includes(section)) return null;
    const appId = typeof opts.appId === 'string' && opts.appId ? opts.appId : null;
    return { section, appId };
}

/** Kent de kiezer deze sectie? */
export function isChooserSection(section: string): boolean {
    return SECTIONS.includes(section);
}

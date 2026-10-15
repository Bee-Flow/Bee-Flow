/**
 * De GETYPEERDE aanroep van de tool-kiezer (Agents-artboard 1f).
 *
 * De kiezer zelf bouwt A2 stap 4. Wat hier staat is de naad ertussen: de
 * secties die hij kent, en een bouwer die een aanvraag maakt of `null`
 * teruggeeft. Zo staat de sectienaam op één plek in plaats van als losse
 * string bij elke "+ Koppelen"-knop — en een typfout opent straks niet stil
 * de verkeerde sectie maar levert `null`, wat de aanroeper afdwingt.
 *
 * Waarom nu al, terwijl er nog niets opengaat: de knoppen bestaan wél, en een
 * knop die vandaag rechtstreeks een oude popover opent is over drie stages
 * niet meer terug te vinden. Deze module is de plek waar stap 4 één regel
 * vervangt.
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
export function chooserRequest(section: string, opts: { appId?: string } = {}): { section: string; appId: string | null } | null {
    if (!SECTIONS.includes(section)) return null;
    const appId = typeof opts.appId === 'string' && opts.appId ? opts.appId : null;
    return { section, appId };
}

/** Kent de kiezer deze sectie? */
export function isChooserSection(section: string): boolean {
    return SECTIONS.includes(section);
}

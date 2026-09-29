import { createContext, useContext, useMemo, useRef } from 'react';
import { mergeFormValues } from '../runtime/formValues';

/**
 * De LIVE waarden die op het scherm staan, leesbaar buiten de canvas.
 *
 * ── Waarom dit bestaat ─────────────────────────────────────────────────────
 *
 * "Testen met scherm-invoer" zit in de INSPECTOR (inspector/ActionsSection),
 * en de waarden staan in de CANVAS (editor/Canvas → AppForm publiceert ze via
 * runtime.registerFormValue). Dat zijn twee zusters onder dezelfde shell, dus
 * er is geen prop die van de een naar de ander loopt. Zonder een gedeelde plek
 * kon de testknop alleen de STATISCHE waarden uit de mapping meesturen — de
 * helft van de invoer, zonder dat iemand dat zag.
 *
 * ── Waarom een ref en geen state ───────────────────────────────────────────
 *
 * Een gedeelde state-waarde hierboven zou bij ELKE toetsaanslag in een
 * formulier de hele editor opnieuw laten renderen — inspector, ribbon, chat en
 * al. De inspector heeft die waarden ook niet nodig om te TEKENEN; hij heeft ze
 * nodig op het moment dat er op Test wordt gedrukt. Dus: een ref met een
 * stabiel `{ publish, read, readForm }` eromheen, dat nooit van identiteit
 * verandert. Nul extra renders.
 *
 * De canvas houdt daarnaast zijn EIGEN `forms`-state, want die voedt de scope
 * waar bindings tegenaan resolven; hier wordt dezelfde waarde in dezelfde
 * callback bijgeschreven, zodat de twee niet uit elkaar kunnen lopen.
 *
 * ── Wat het NIET is ────────────────────────────────────────────────────────
 *
 * Geen autorisatie en geen opslag. Alleen "wat staat er nu in dit formulier",
 * per formuliernaam, precies zoals `forms.<naam>` in de expressie-scope. Wie
 * de waarden gebruikt (de testknop) moet zelf blijven bepalen wat er wél en
 * niet mee mag — bestandsvelden gaan bijvoorbeeld nooit mee, zie
 * inspector/testPayload.js.
 */

export const ScreenValuesContext = createContext(null);

/**
 * De store zelf. Eén per editor-shell; de waarde is stabiel over de hele
 * levensduur, zodat consumenten hem gerust als dependency mogen gebruiken.
 */
export function useScreenValuesStore() {
    const ref = useRef({});
    return useMemo(() => ({
        /** Zelfde vouw als de canvas-scope (mergeFormValues) — één bron, één vorm. */
        publish(formName, values) {
            ref.current = mergeFormValues(ref.current, formName, values);
        },
        /** Alle formulieren, `{ [formName]: { [field]: value } }`. */
        read() {
            return ref.current;
        },
        /**
         * Eén formulier, of NULL als dat formulier niets gepubliceerd heeft.
         * Null en {} zijn verschillende antwoorden en moeten dat blijven: null
         * is "dit formulier staat niet op het scherm", {} is "het staat er en
         * is leeg". De testknop meldt die twee ook anders.
         */
        readForm(formName) {
            if (!formName) return null;
            const all = ref.current || {};
            return Object.prototype.hasOwnProperty.call(all, formName) ? all[formName] : null;
        },
    }), []);
}

/** De store, of null buiten de editor (de run-pagina heeft geen inspector). */
export function useScreenValues() {
    return useContext(ScreenValuesContext);
}

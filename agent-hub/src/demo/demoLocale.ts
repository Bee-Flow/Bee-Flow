// Language-specific demo fixtures.
//
// The sample data of the public feature demos is written in Dutch (a fictional
// Dutch insurance intermediary). A demo framed by an English page (?lang=en)
// would show Dutch agent names inside the English product. The fixtures stay
// the single source; this table maps their Dutch sample names to English, and
// the transport applies it to the string values of every answer. Dutch (the
// language of the fixtures) and a missing language are answered as written.
// Product vocabulary is not in here: the UI comes from the translation catalogue.

/** Dutch sample term -> English. Longest terms first so a name is never cut by a shorter one. */
export const DUTCH_SAMPLE_TERMS: Record<string, string> = {
    'Van Dael Assurantiën': 'Van Dael Insurance Brokers',
    Schadebeoordeling: 'Claims assessment',
    Polisintake: 'Policy intake',
    Klachtdossier: 'Complaint file',
};

const ORDERED_TERMS = Object.entries(DUTCH_SAMPLE_TERMS).sort((a, b) => b[0].length - a[0].length);

/** The text localiser for a demo language, or undefined when the fixtures already speak it. */
export function demoTextLocaliser(lang: string | null | undefined): ((text: string) => string) | undefined {
    if (!lang || lang === 'nl') return undefined;
    return (text: string) => ORDERED_TERMS.reduce((out, [from, to]) => out.split(from).join(to), text);
}

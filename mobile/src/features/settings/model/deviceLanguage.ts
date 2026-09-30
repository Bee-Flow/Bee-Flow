/** The phone's own language tag, as a person reads it: "nl-NL", "en". */

import { getLocales } from 'expo-localization';

export function deviceLanguageName(): string {
    const device = getLocales()[0];
    if (!device) return 'Unknown';
    return `${device.languageCode ?? '—'}${device.regionCode ? `-${device.regionCode}` : ''}`;
}

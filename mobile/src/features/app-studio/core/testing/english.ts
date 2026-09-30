/**
 * Test-only: render every Msg inside a value to its English, so a port that
 * returns Msg data can be compared with a web module that returned strings.
 *
 * Never imported by app code.
 */

import { say, type Msg } from '../msg';

function isMsg(v: unknown): v is Msg {
    return !!v && typeof v === 'object' && typeof (v as Msg).i18nKey === 'string' && typeof (v as Msg).en === 'string';
}

export function english(value: unknown): unknown {
    if (isMsg(value)) return say(value);
    if (Array.isArray(value)) return value.map(english);
    if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, english(v)]));
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, english(v)]));
    }
    return value;
}

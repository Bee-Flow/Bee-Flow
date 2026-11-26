interface Colleague { id: string; name: string }

const words = (text: string) => ' ' + (text.toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).join(' ') + ' ';

/** Prefer full names. A first name after “with” or “aan” is useful only if it identifies one colleague. */
export function namedColleague(list: Colleague[], request: string) {
    const sentence = words(request);
    const named = list.filter(c => c.name.trim() && sentence.includes(words(c.name)));
    if (named.length) return named.length === 1 ? named[0].id : '';
    const given = /\b(?:with|to|from|met|aan|van) ([\p{L}\p{M}]+)(?= )/u.exec(sentence)?.[1];
    const matches = given ? list.filter(c => words(c.name).trim().split(' ')[0] === given) : [];
    return matches.length === 1 ? matches[0].id : '';
}

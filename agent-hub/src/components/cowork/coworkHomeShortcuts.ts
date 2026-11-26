import type { HomeAction } from '@/api/coworkHomeIntent';

// Exact shortcuts keep common turns instant. Bee interprets everything else.
const shortcuts: Array<[RegExp, HomeAction | 'greeting']> = [
    [/^(?:hi|hello|hey(?: there)?|hiya|hoi|hallo|goedemorgen|goedemiddag|goedenavond|good (?:morning|afternoon|evening))(?:[,\s]+bee)?[\s!?.👋🏻🏼🏽🏾🏿]*$/iu, 'greeting'],
    [/^(?:(?:toon|bekijk|open|show|list|view)\s+)?(?:(?:al|alle|all|mijn|my|de|the|bestaande|existing)\s+)*(?:taken|tasks|werk)\s*[?.!]?$/i, 'tasks'],
    [/^(?:every (?:day|week|morning)|elke (?:dag|week|ochtend))\b[^?!.]{0,40},\s*(?:summari[sz]e|send|collect|prepare|draft|check|vat|verzamel|controleer|stuur)\b/i, 'create'],
    [/^(?:wat heeft mijn aandacht nodig|what needs my attention|open approvals|toon goedkeuringen)[?!. ]*$/i, 'attention'],
    [/^(?:(?:show|open|toon|bekijk)\s+)?(?:(?:my|mijn|de)\s+)?(?:desks?|teams?|teamwork|teamwerk)[?.! ]*$/i, 'teamwork'],
    [/^(?:shared with me|gedeeld met mij)[?!. ]*$/i, 'shared'],
];

export function homeShortcut(message: string) {
    return shortcuts.find(([pattern]) => pattern.test(message))?.[1];
}

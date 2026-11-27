import type { CoworkSheetPanel } from './coworkSheetPanels';

export interface TeamworkTurn {
    mode: 'browse' | 'setup' | 'join' | 'leave' | 'remove' | 'create' | 'roles' | 'task-role';
    message: string;
    itemId?: string;
}

const desk = /\b(?:teamwork|desks?|teamdesks?|bureaus?|teamwerk|samenwerking|taakoverdracht)\b/i;
const directTeam = /\b(?:show|open|manage|create|join|leave|delete|remove|toon|bekijk|maak|beheer|verlaat|verwijder)\s+(?:(?:mijn|het|een|nieuw|nieuwe|dit|ons|onze|my|our|this|the|new|a)\s+)*teams?\b/i;
const bare = /^(?:mijn |my )?(?:teams?|samenwerken)[?.!]?$/i;
const setup = /\b(?:create|make|set up|setup|start|build|invite|change|adjust|link|connect|assign|maak|maken|opzetten|richt|inrichten|koppel|verbind|wijzig|stel|nodig|uitnodigen|instellen)\b/i;

// Shortcuts are for explicit Cowork destinations. Ordinary briefs mentioning someone's team remain briefs.
export function teamworkRequest(message: string, itemId?: string, routed = false): Extract<CoworkSheetPanel, {kind: 'teamwork'}> | null {
    const text = message.trim();
    if (!routed && !desk.test(text) && !directTeam.test(text) && !bare.test(text)) return null;
    const mode = deskIntent(text);
    return {kind: 'teamwork', request: {mode, message: text, itemId}};
}

function deskIntent(text: string): TeamworkTurn['mode'] {
    if (/\b(?:do not|don't|never|niet|geen|hoe werkt|hoe kan ik|mag ik|how do I|what happens|wat gebeurt|wie mag|who can)\b/i.test(text)) return 'browse';
    if (/\b(?:rol|role|beslist|beslissen|decides|decisions)\b/i.test(text) && /\b(?:task|taak|cowork)\b/i.test(text)
        && /\b(?:set|change|assign|choose|wijzig|verander|kies|stel|laat|pas|wijs)\b/i.test(text)) return 'task-role';
    if (/\b(?:roles?|rollen?|rol|stand-in|vervanger|afwezig)\b/i.test(text) && /\b(?:edit|change|set|wijzig|verander|pas|bewerk|voeg|add|remove|delete|verwijder|beheer)\b/i.test(text)) return 'roles';
    if (/^(?:(?:can you|please|kun je|wil je)\s+)*(?:create|make|maak)\s+(?:(?:a|new|empty|een|nieuwe|nieuw|lege|leeg)\s+)*(?:desk|teamdesk|team)(?:\s+aan)?(?:\s+(?:named|called|genaamd|met de naam)\s+.{1,80})?[?!. ]*$/i.test(text)) return 'create';
    if (/\b(?:decline|leave|verlaat|afwijzen|weiger|verwijder.+\buit|(?:remove|delete).+\bfrom)\b/i.test(text)) return 'leave';
    if (/\b(?:tasks?|taak|taken|steps?|stap|stappen|lid|member)\b/i.test(text) && /\b(?:delete|remove|verwijder|verwijderen)\b/i.test(text)) return 'browse';
    if (/\b(?:delete|remove|verwijder|opheffen|verwijderen)\b/i.test(text) && /\b(?:team|desk|teamdesk|bureau)\b/i.test(text)) return 'remove';
    if (/\b(?:join|accept|accepteer|aanvaard|toevoegen|voeg.+\btoe)\b/i.test(text)) return 'join';
    return setup.test(text) ? 'setup' : 'browse';
}

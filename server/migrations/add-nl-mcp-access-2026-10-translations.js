#!/usr/bin/env node
/**
 * Dutch for the MCP access screens (2026-10): Settings → Security → MCP tokens
 * and Settings → Organisation → MCP access (namespace "mcp_access").
 *
 * Idempotent: only fills missing keys, so a workspace's own wording is kept.
 * Auto-runs from server boot (boot/bootMigrations.js).
 */

const NL_TRANSLATIONS = Object.freeze({
    'mcp_access.create.cancel': 'Annuleren',
    'mcp_access.create.expiry': 'Verloopt',
    'mcp_access.create.expiry_30': 'Over 30 dagen',
    'mcp_access.create.expiry_365': 'Over een jaar',
    'mcp_access.create.expiry_90': 'Over 90 dagen',
    'mcp_access.create.expiry_date': 'Op een datum',
    'mcp_access.create.expiry_date_label': 'Verloopdatum',
    'mcp_access.create.expiry_none': 'Nooit',
    'mcp_access.create.expiry_past': 'Kies een datum in de toekomst.',
    'mcp_access.create.ips': 'Toegestane IP-adressen (optioneel)',
    'mcp_access.create.ips_hint': 'Eén adres of bereik (CIDR) per regel. Leeg betekent elk adres dat je organisatie toestaat.',
    'mcp_access.create.level_read': 'Alleen lezen',
    'mcp_access.create.level_write': 'Lezen en schrijven',
    'mcp_access.create.name': 'Naam',
    'mcp_access.create.name_placeholder': 'Claude Code op mijn laptop',
    'mcp_access.create.name_required': 'Geef de token een naam.',
    'mcp_access.create.no_server': 'Zet minstens één server aan.',
    'mcp_access.create.no_access': 'Je hebt zelf geen toegang tot dit onderdeel, dus een token ook niet.',
    'mcp_access.create.publish': 'Mag de website publiceren',
    'mcp_access.create.publish_warn': 'Publiceren zet wijzigingen op de live website. Laat dit uit, tenzij de client zonder jou live moet kunnen gaan. Vereist lezen en schrijven.',
    'mcp_access.create.servers_hint': 'Een server die je uit laat, is met deze token niet te bereiken.',
    'mcp_access.create.submit': 'Token maken',
    'mcp_access.create.title': 'MCP-token maken',
    'mcp_access.create.tools': 'Alleen deze tools voor {server} (optioneel)',
    'mcp_access.create.tools_hint': 'Scheid namen met komma\'s of nieuwe regels. Leeg betekent elke tool die het toegangsniveau toestaat.',
    'mcp_access.ips_invalid': 'Geen geldig adres of bereik: {list}',
    'mcp_access.level.read': 'alleen lezen',
    'mcp_access.level.write': 'lezen en schrijven',
    'mcp_access.nav': 'MCP-toegang',
    'mcp_access.org.add_mine': 'Mijn adres toevoegen',
    'mcp_access.org.caller': 'Je huidige adres is {ip}.',
    'mcp_access.org.enabled': 'MCP-toegang toestaan',
    'mcp_access.org.enabled_desc': 'Als dit uit staat, wordt elke MCP-token in deze organisatie geweigerd.',
    'mcp_access.org.intro': 'Bepaal hoe externe MCP-clients zoals Claude Code bij deze organisatie komen. Deze regels gelden alleen voor MCP, niet voor de webapp.',
    'mcp_access.org.ips': 'Toegestane netwerken',
    'mcp_access.org.ips_desc': 'Alleen deze adressen en bereiken (CIDR) kunnen MCP gebruiken. Eén per regel. Laat leeg om elk adres toe te staan.',
    'mcp_access.org.loading': 'Het MCP-toegangsbeleid laden…',
    'mcp_access.org.lockout': 'Je huidige adres ({ip}) staat niet in deze lijst. Als je opslaat, sluit je jezelf vanaf dit netwerk buiten voor MCP. De webapp blijft werken.',
    'mcp_access.org.members': 'Leden',
    'mcp_access.org.members_loading': 'Leden laden…',
    'mcp_access.org.members_none': 'Geen leden gevonden.',
    'mcp_access.org.members_search': 'Leden zoeken',
    'mcp_access.org.nobody': 'Er is niemand geselecteerd, dus niemand kan MCP gebruiken.',
    'mcp_access.org.reject_legacy': 'Oude tokens weigeren',
    'mcp_access.org.reject_legacy_desc': 'Oude tokens kunnen niet tot servers of tools worden beperkt. Zet dit aan zodra iedereen op benoemde tokens zit.',
    'mcp_access.org.roles': 'Rollen',
    'mcp_access.org.save': 'Opslaan',
    'mcp_access.org.saved': 'MCP-toegang opgeslagen',
    'mcp_access.org.saving': 'Opslaan…',
    'mcp_access.org.title': 'MCP-toegang',
    'mcp_access.org.users': 'Wie MCP mag gebruiken',
    'mcp_access.org.users_all': 'Iedereen in de organisatie',
    'mcp_access.org.users_roles': 'Specifieke rollen',
    'mcp_access.org.users_users': 'Specifieke leden',
    'mcp_access.reveal.commands': 'Claude Code verbinden',
    'mcp_access.reveal.copied': 'Gekopieerd',
    'mcp_access.reveal.copy': 'Kopiëren',
    'mcp_access.reveal.copy_command': 'Commando voor {server} kopiëren',
    'mcp_access.reveal.copy_failed': 'Kopiëren is mislukt. Selecteer de tekst en kopieer hem zelf.',
    'mcp_access.reveal.done': 'Klaar',
    'mcp_access.reveal.once': 'Kopieer deze token nu. Je ziet hem maar één keer en hij is later niet meer op te vragen.',
    'mcp_access.reveal.title': 'Je nieuwe token',
    'mcp_access.server.automations': 'Automatiseringen',
    'mcp_access.server.integrations': 'Integraties',
    'mcp_access.tokens.any_ip': 'Elk adres dat je organisatie toestaat',
    'mcp_access.tokens.create': 'Token maken',
    'mcp_access.tokens.created': 'Gemaakt op {date}',
    'mcp_access.tokens.disabled': 'Uitgeschakeld',
    'mcp_access.tokens.empty': 'Je hebt nog geen MCP-tokens.',
    'mcp_access.tokens.expired': 'Verlopen',
    'mcp_access.tokens.expires': 'Verloopt op {date}',
    'mcp_access.tokens.intro': 'Geef Claude Code, Cursor of een andere MCP-client een eigen token, beperkt tot de servers en tools die jij kiest. Elke token kun je los intrekken.',
    'mcp_access.tokens.ips': 'Toegestaan vanaf {list}',
    'mcp_access.tokens.last_used': 'Laatst gebruikt op {date}',
    'mcp_access.tokens.legacy_body': 'Je hebt ook een oude MCP-token, bijvoorbeeld van de mobiele app. Hij bereikt elke MCP-server en kan niet worden beperkt. Je organisatie kan ervoor kiezen oude tokens te weigeren.',
    'mcp_access.tokens.legacy_title': 'Oude token',
    'mcp_access.tokens.loading': 'Je MCP-tokens laden…',
    'mcp_access.tokens.may_publish': 'mag publiceren',
    'mcp_access.tokens.lost_access': 'Je hebt geen toegang meer tot {server}, dus deze token kan het niet gebruiken.',
    'mcp_access.tokens.never_used': 'Nooit gebruikt',
    'mcp_access.tokens.no_expiry': 'Verloopt niet',
    'mcp_access.tokens.no_servers': 'Geen servers',
    'mcp_access.tokens.policy_blocked': 'Je organisatie staat niet toe dat je MCP gebruikt, dus je kunt geen tokens maken.',
    'mcp_access.tokens.retry': 'Opnieuw proberen',
    'mcp_access.tokens.revoke': 'Intrekken',
    'mcp_access.tokens.revoke_confirm': 'Token intrekken',
    'mcp_access.tokens.revoke_desc': 'Elke client die deze token gebruikt, verliest direct de toegang. Dit kan niet ongedaan worden gemaakt.',
    'mcp_access.tokens.revoke_named': '{name} intrekken',
    'mcp_access.tokens.revoke_title': '"{name}" intrekken?',
    'mcp_access.tokens.revoked': 'Ingetrokken',
    'mcp_access.tokens.revoked_toast': 'Token ingetrokken',
    'mcp_access.tokens.switch_named': 'Token {name} aan of uit',
    'mcp_access.tokens.title': 'MCP-tokens',
    'mcp_access.tokens.tools_only': '{server}: alleen {tools}',
});

/** Keys whose Dutch is the English text itself; deliberately not seeded. */
const SAME_AS_ENGLISH = Object.freeze([
    'mcp_access.create.ips_placeholder', // an address range
    'mcp_access.create.servers', // Dutch uses the same word
    'mcp_access.reveal.token_label', // Dutch uses the same word
    'mcp_access.create.tools_placeholder', // tool names
    'mcp_access.server.studio', // a product name
    'mcp_access.server.cms', // Dutch uses the same words
]);

/** The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once. */
function applyNl(merged) {
    let added = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    return { merged, added };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    await languageStore.mutateGUITranslations('nl', (current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-mcp-access-2026-10-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, SAME_AS_ENGLISH };

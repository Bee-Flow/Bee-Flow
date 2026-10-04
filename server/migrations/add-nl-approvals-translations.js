#!/usr/bin/env node
/**
 * One-time migration: Dutch for the Approvals surfaces (2026-08).
 *
 * The Approvals section (Studio), the decision controls it shares with the
 * builder's inline bar and the in-app approval_list, the withdraw flow, the
 * audit trail, and — since the sequential-stages release — the chain's
 * timeline and the builder's stage editor. Terminology follows the existing
 * NL catalogue: routines
 * are "routines", an organisation is "organisatie", and the decided states
 * mirror the status chips (Wacht / Goedgekeurd / Afgewezen / Verlopen /
 * Gesloten).
 *
 * Idempotent: only fills keys that are missing, so a workspace that already
 * curated its own wording keeps it. Auto-runs from server boot
 * (server/index.js). Manual usage:
 *   node server/migrations/add-nl-approvals-translations.js
 */

const NL_TRANSLATIONS = {
    'sidebar.approvals': 'Goedkeuringen',
    'studio.tab.approvals': 'Goedkeuringen',
    'studio.tab.approvals_desc': 'Verzoeken die op iemand wachten, en elke eerdere beslissing',
    'approvals.title': 'Goedkeuringen',
    'approvals.scope_mine': 'Mijn goedkeuringen',
    'approvals.scope_org': 'Organisatie',
    'approvals.refresh': 'Vernieuwen',
    'approvals.search': 'Zoek op vraag of automatisering…',
    'approvals.empty_waiting': 'Er wacht niets op een beslissing.',
    'approvals.empty': 'Nog niets hier.',
    'approvals.loading': 'Laden…',
    'approvals.show_more': 'Meer tonen',
    'approvals.back_home': '← Bee Flow',
    'approvals.untitled': 'Goedkeuring gevraagd',
    'approvals.automation': 'Automatisering',
    'approvals.decide_before': 'beslis vóór',
    'approvals.by': 'door',
    'approvals.you': 'Jij',
    'approvals.status_pending': 'Wacht',
    'approvals.status_approved': 'Goedgekeurd',
    'approvals.status_rejected': 'Afgewezen',
    'approvals.status_expired': 'Verlopen',
    'approvals.status_cancelled': 'Gesloten',
    'approvals.toast_approved': 'Goedgekeurd — de automatisering gaat verder.',
    'approvals.toast_rejected': 'Afgewezen — de automatisering is gestopt.',
    'approvals.toast_expired': 'De deadline van deze goedkeuring is verstreken en de automatisering is gesloten.',
    'approvals.toast_race': 'Iemand anders heeft deze goedkeuring al beslist.',
    'approvals.toast_withdrawn': 'Verzoek ingetrokken.',
    'approvals.toast_already': 'Deze goedkeuring was al beslist.',
    'approvals.withdraw_confirm': 'Dit goedkeuringsverzoek intrekken? Wie gevraagd was hoort het, en een gepauzeerde automatisering wordt gesloten.',
    'approvals.withdraw': 'Dit verzoek intrekken',
    'approvals.assigned_group': 'Toegewezen aan een groep',
    'approvals.assigned': 'Toegewezen',
    'approvals.owner_decides': 'Eigenaar beslist',
    'approvals.decide_before_cap': 'Beslis vóór',
    'approvals.no_deadline': 'Geen deadline',
    'approvals.requested': 'Gevraagd',
    'approvals.open_run': 'Open de uitvoering',
    'approvals.documents': 'Documenten',
    'approvals.waiting_group': 'Wacht tot de toegewezen groep beslist.',
    'approvals.waiting_assignee': 'Wacht tot de toegewezen beoordelaar beslist.',
    'approvals.history': 'Geschiedenis',
    'approvals.all': 'Alle goedkeuringen',
    'approvals.verb_approved': 'Goedgekeurd',
    'approvals.verb_rejected': 'Afgewezen',
    'approvals.verb_expired': 'Verlopen',
    'approvals.verb_cancelled': 'Gesloten',
    'approvals.audit_recorded': 'Goedkeuring vastgelegd',
    'approvals.audit_requested': 'Goedkeuring gevraagd',
    'approvals.audit_expired': 'Verlopen — niemand besliste vóór de deadline',
    'approvals.audit_escalated': 'Geëscaleerd — de vervangende beoordelaar mag nu ook beslissen',
    'approvals.audit_hook_ran': 'App bijgewerkt',
    'approvals.audit_hook_failed': 'App bijwerken mislukt',
    'approvals.audit_withdrawn': 'Ingetrokken',
    'approvals.audit_closed': 'Gesloten — de automatisering wachtte niet meer',
    'approvals.toast_vote': 'Je stem is binnen — wachten op de andere beoordelaars.',
    'approvals.toast_panel_final': 'Het panel keurde goed — wachten op de eindakkoord.',
    'approvals.waiting_panel': 'Wachten tot de andere beoordelaars stemmen.',
    'approvals.waiting_final': 'Wachten op het eindakkoord.',
    'approvals.panel': 'Goedkeuringspanel',
    'approvals.panel_of': 'Panel van {n}',
    'approvals.rule_all': 'Iedereen moet goedkeuren',
    'approvals.rule_first': 'De eerste reactie beslist',
    'approvals.rule_quorum': 'Minstens {n} van {m} moeten goedkeuren',
    'approvals.stage_final': 'Panel akkoord — eindakkoord in afwachting',
    'approvals.approved_so_far': 'goedgekeurd',
    'approvals.final_badge': 'eind',
    'approvals.final_after': 'Na goedkeuring door het panel volgt nog een eindakkoord.',
    'approvals.field_required': '{field} is verplicht.',
    'approvals.reason_placeholder': 'Waarom? Verplicht bij afwijzen.',
    'approvals.reason_label': 'Reden voor je beslissing',
    'approvals.approve': 'Goedkeuren',
    'approvals.reject': 'Afwijzen',
    'approvals.reason_needed': 'Geef een reden om af te wijzen.',

    // Opeenvolgende goedkeuringsfasen (2026-08): een geordende keten van
    // maximaal vijf benoemde stappen. De tijdlijn in het goedkeuringsdetail,
    // de "welke fase wacht"-regel in de in-app goedkeuringslijst, en de
    // fase-editor in de routinebouwer.
    'approvals.stages_title': 'Goedkeuringsketen',
    'approvals.stage_of': 'Fase {n} van {m}',
    'approvals.chain_of': 'Keten van {n} fasen',
    'approvals.stage_unnamed': 'deze fase',
    'approvals.stage_state_done': 'Beslist',
    'approvals.stage_state_current': 'Wacht op deze fase',
    'approvals.stage_state_waiting': 'Nog niet begonnen',
    'approvals.stage_state_skipped': 'Overgeslagen — de voorwaarde werd niet gehaald, de keten ging er direct langs',
    'approvals.stage_state_never_reached': 'Nooit bereikt — de keten stopte vóór deze fase',
    'approvals.stage_tally': '{n} van {m} goedgekeurd',
    'approvals.stage_declined_here': 'hier afgewezen',
    'approvals.waiting_stage': 'Wacht op {name} — fase {n} van {m}.',
    'approvals.waiting_chain': 'Wacht op een eerdere fase van deze goedkeuring.',
    'approvals.toast_stage_passed': 'Deze fase is klaar — het gaat verder naar {name} (fase {n} van {m}).',
    'approvals.audit_stage_passed': 'Fase doorlopen',

    'automations.builder.approval_stages_intro': 'Meer dan twee rondes nodig? Vraag meerdere groepen na elkaar — elke fase heeft eigen beoordelaars, een eigen regel en een eigen naam.',
    'automations.builder.approval_use_stages': 'Goedkeuringsfasen gebruiken',
    'automations.builder.approval_use_simple': 'Terug naar één goedkeuringsronde',
    'automations.builder.approval_stages_label': 'Goedkeuringsfasen',
    'automations.builder.approval_stages_hint': 'Maximaal 5 benoemde stappen, na elkaar gevraagd. Alleen de mensen van de huidige fase worden gevraagd, en pas als zij aan de beurt zijn — niemand verderop in de keten ziet het verzoek eerder.',
    'automations.builder.approval_stage_add': 'Fase toevoegen',
    'automations.builder.approval_stage_position': 'Fase {n} van {m}',
    'automations.builder.approval_stage_name_ph': 'Geef deze fase een naam — Teamleider, Financiën…',
    'automations.builder.approval_stage_name_aria': 'Naam van fase {n}',
    'automations.builder.approval_stage_desc_ph': 'Waar letten deze beoordelaars op? (optioneel)',
    'automations.builder.approval_stage_desc_aria': 'Omschrijving van fase {n}',
    'automations.builder.approval_stage_up': 'Fase {n} eerder plaatsen',
    'automations.builder.approval_stage_down': 'Fase {n} later plaatsen',
    'automations.builder.approval_stage_remove': 'Fase {n} verwijderen',
    'automations.builder.approval_pick_seat': '— kies een persoon of groep —',
    'automations.builder.approval_stage_seat_aria': 'Fase {n}, beoordelaar {s}',
    'automations.builder.approval_stage_seat_add': 'Beoordelaar toevoegen',
    'automations.builder.approval_stage_seat_remove': 'Beoordelaar {s} uit fase {n} verwijderen',
    'automations.builder.approval_stage_empty': 'Kies minstens één beoordelaar — een fase zonder mensen wordt niet opgeslagen.',
    'automations.builder.approval_stage_rule_aria': 'Beslisregel voor fase {n}',
    'automations.builder.approval_rule_all': 'Iedereen moet goedkeuren',
    'automations.builder.approval_rule_first': 'De eerste reactie beslist',
    'automations.builder.approval_rule_quorum': 'Minstens N goedkeuringen',
    'automations.builder.approval_stage_quorum_aria': 'Benodigde goedkeuringen in fase {n}',
    'automations.builder.approval_quorum_option': '{n} van {m}',
    'automations.builder.approval_stage_when_add': 'Vraag deze fase alleen als…',
    'automations.builder.approval_stage_when_label': 'Vraag deze fase alleen als',
    'automations.builder.approval_stage_when_clear': 'Altijd vragen',
    'automations.builder.approval_stage_when_hint': 'Eén keer gecontroleerd, op het moment dat de goedkeuring wordt aangemaakt. Een fase waarvan de voorwaarde niet klopt wordt overgeslagen — de keten gaat direct verder, en de overslag blijft zichtbaar in de geschiedenis.',
    'automations.builder.approval_stage_budget': '{used} van {max} beoordelaars gebruikt in de hele keten',
    'automations.builder.approval_stage_budget_full': 'De keten zit vol bij {max} beoordelaars — verwijder er één voordat je een nieuwe toevoegt.',
    'automations.builder.approval_final_stage_name': 'Eindakkoord',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-approvals-translations: added ${added} NL keys`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(({ added }) => {
        console.log(`Done (${added} added).`);
        process.exit(0);
    }).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}

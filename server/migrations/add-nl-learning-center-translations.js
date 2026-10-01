#!/usr/bin/env node
/**
 * Dutch for the redesigned Learning Center (handoff "Learning Center.dc.html",
 * 2026-09-14): the 300-px rail, the curriculum map, the course screen with its
 * lessons table, the Achievements tab, the certificate drawer and the lesson
 * player's new chrome (docked action step, minimized pill, end screen).
 *
 * Keys the later "calmer overview" round removed from the UI were pruned from
 * this file: a Dutch value for a key the English catalogue no longer defines is
 * dead weight the migration test rejects.
 *
 * Extended for round 3 (one status per course, lucide icons instead of emoji,
 * rewards moved to Achievements) and for required training — the organisation
 * rule that a course must be finished before a feature can be built.
 *
 * The artboards were drawn in Dutch, so these are the artboard's own words
 * wherever a key maps onto a drawn string; the rest follows their register.
 * The English lives in i18n/defaults/en.js (the normal split).
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated its
 * own wording keeps it. ADD, NEVER RENAME — a renamed key is a screen that
 * silently falls back to English. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-learning-center-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Stapsoorten ─────────────────────────────────────────────────────────
    'learn.kind.quiz': 'quiz',
    'learn.kind.quiz_plural': 'quizzen',
    'learn.kind.exercise': 'oefening met AI-coach',
    'learn.kind.exercise_plural': 'oefeningen',
    'learn.kind.sim': 'simulatie',
    'learn.kind.sim_plural': 'simulaties',
    'learn.kind.tour': 'tour',
    'learn.kind.tour_plural': 'tours',
    'learn.kind.action': 'actie',
    'learn.kind.action_plural': 'acties',
    'learn.kind.slide': 'kaart',
    'learn.kind.slide_plural': 'kaarten',
    'learn.plays.docked': 'naast de app',
    'learn.plays.modal': 'in venster',

    // ── De rail ─────────────────────────────────────────────────────────────
    'learn.rail.subtitle': 'Bee Flow Academy · {courses} cursussen · {lessons} lessen',
    'learn.rail.search': 'Zoek les, cursus of badge…',
    'learn.rail.filter': 'Cursussen filteren',
    'learn.rail.filter_all': 'Alles',
    'learn.rail.filter_available': 'Beschikbaar',
    'learn.rail.overview': 'Overzicht',
    'learn.rail.review': 'Herhalen',
    'learn.rail.achievements': 'Behaald',
    'learn.rail.other_courses': 'Jouw organisatie',
    'learn.rail.capstone': 'Capstone',
    'learn.rail.capstone_progress': '{a}/{b} cursussen',
    'learn.path.chip': 'Pad: {path}',
    // De drie leerlijnen — sinds BFSF-473 de grote tegels van de curriculumkaart.
    'learn.path.everyday': 'Alledaags werk',
    'learn.path.everyday_desc': 'Goed chatten, delegeren aan Cowork, en Bee Flow voor je laten onthouden.',
    'learn.path.builder': 'Agents & automatiseringen bouwen',
    'learn.path.builder_desc': 'Maak agents, knoop automatiseringen aan elkaar op het canvas, en bewijs het in de capstone.',
    'learn.path.admin': 'De werkruimte draaien',
    'learn.path.admin_desc': 'Toegangsbeheer, gebruiksmonitoring, integraties en gezonde uitrol.',
    'learn.tabs.curriculum': 'Curriculum',
    'learn.tour_button': 'Rondleiding',
    'learn.more': 'Meer',

    // ── De hero ─────────────────────────────────────────────────────────────
    'learn.hero.all_done': 'Alles wat je kunt zien is afgerond',
    'learn.hero.review_none': 'Nog niets te herhalen',
    'learn.hero.review_none_sub': 'Fouten en lessen ouder dan twee weken komen hier terecht — een korte sessie houdt ze vast.',
    'learn.hero.review_start': 'Herhaling starten',
    'learn.minutes': '{n} min',
    'learn.play': 'Afspelen',
    'learn.beside_app': 'Naast de app',

    // ── De curriculumkaart ──────────────────────────────────────────────────
    'learn.curriculum.title': 'Curriculum',
    'learn.curriculum.level_filter': 'Filteren op niveau',
    'learn.curriculum.all_levels': 'Alle niveaus',
    'learn.curriculum.no_courses_at_level': 'Geen cursussen op dit niveau in deze leerlijn.',
    'learn.legend': 'Legenda',
    'learn.legend.mastered': 'beheerst',
    'learn.legend.complete': 'afgerond',
    'learn.legend.locked': 'vergrendeld',
    'learn.state.complete': 'afgerond',
    'learn.capstone.title': '{course} — capstone',
    'learn.capstone.courses_done': 'Cursussen afgerond',

    // ── Het cursusscherm ────────────────────────────────────────────────────
    'learn.course.back': 'Terug naar het overzicht',
    'learn.course.progress_chip': '{a} van {b} lessen · {min} min',
    'learn.course.tab_lessons': 'Lessen',
    'learn.course.tab_about': 'Over deze cursus',
    'learn.course.practice_ai': 'Oefenen met AI',
    'learn.course.continue_with': 'Verder met les {n}',
    'learn.course.about': 'Waar het over gaat',
    'learn.course.steps_n': '{n} stappen:',
    'learn.course.progress': 'Voortgang',
    'learn.course.lessons_of': '{a} van {b} lessen',
    'learn.course.mastered_n': '{n} beheerst',
    'learn.course.xp_earned': '{n} XP verdiend',
    'learn.course.badge_earned_line': 'Behaald:',
    'learn.course.on_completion': 'Bij afronden:',
    'learn.course.per_mastered': 'per beheerste les',
    'learn.course.counts_toward': 'Telt mee voor',
    'learn.course.cert_line': 'Certificaat {name} · {a} van {b} cursussen',
    'learn.course.unlocks': 'Ontgrendelt {courses}',
    'learn.course.visible_hidden': 'Jij ziet {a} van {b} lessen — {n} vereisen een recht of planfunctie die je niet hebt',
    'learn.course.visible_all': 'Jij ziet alle {n} lessen',
    'learn.course.requires': 'Vereist: {courses}',
    'learn.table.lesson': 'Les',
    'learn.table.steps': 'Stappen',
    'learn.table.duration': 'Duur',
    'learn.table.plays': 'Speelt',
    'learn.table.plays_note': 'lessen met actie- of tourstappen openen standaard naast de app (420 px, de app blijft bruikbaar); lees- en quizlessen in een venster. Wisselen kan altijd; je voorkeur wordt onthouden. Op mobiel altijd venster.',
    'learn.table.next': 'Volgende',
    'learn.table.mastered_on': 'Beheerst op {date}, in één keer',
    'learn.table.completed_on': 'Afgerond op {date}',
    'learn.table.replay': 'Opnieuw',
    'learn.table.details': 'Lesdetails',
    'learn.table.steps_in_lesson': 'Stappen in deze les',
    'learn.table.what_counts': 'Wat telt als beheerst',
    'learn.table.what_counts_body': 'Elke quiz en simulatie in één keer goed, niets onthuld. Fouten komen in je herhaling terecht — een goed antwoord dáár wist ze hier weer.',
    'learn.table.help': 'Hulp onderweg',
    'learn.table.help_tutor': 'De AI-tutor geeft eerst een hint, dan pas het antwoord',
    'learn.table.help_hint': 'Hintladder bij de oefening: drie treden',
    'learn.table.help_skip': 'Vastlopen is geen muur: na een paar pogingen mag je een oefening overslaan',
    'learn.table.hint_multi': 'meerdere antwoorden',
    'learn.table.hint_single': 'één antwoord',
    'learn.table.hint_exercise': 'AI-coach scoort 0–100',
    'learn.table.hint_sim': 'zelf bouwen',
    'learn.table.hint_action': 'echt, in de app',
    'learn.table.hint_tour': 'spotlight in de app',
    'learn.table.hint_slide': 'lezen',

    // ── Behaald ─────────────────────────────────────────────────────────────
    'learn.achievements.level': 'Niveau',
    'learn.achievements.xp_note': 'XP wordt afgeleid uit wat je deed — nooit opgeslagen. Geen ranglijst, geen streaks.',
    'learn.achievements.badges': 'badges',
    'learn.achievements.badges_title': 'Badges',
    'learn.achievements.badges_sub': 'één per cursus · {a} van {b}',
    'learn.achievements.col_badge': 'Badge',
    'learn.achievements.col_course': 'Cursus',
    'learn.achievements.col_status': 'Status',
    'learn.achievements.capstone_sub': 'Capstone · bewezen in je werkruimte',
    'learn.achievements.checks_n': '{a}/{b} checks',
    'learn.achievements.certs_sub': '{a} van {b} · geschiktheid wordt op de server herberekend',
    'learn.achievements.certs_loading': 'Je certificaten worden geladen…',
    'learn.achievements.how_title': 'Zo werkt een behaald certificaat',
    'learn.achievements.how_1': 'Download als PNG of PDF — de afbeelding wordt op de server gerenderd.',
    'learn.achievements.how_2': 'Optioneel: openbaar maken. Pas dán ontstaat een verificatielink en een LinkedIn-knop.',
    'learn.achievements.how_3': 'Derden zien op {path} alleen naam, certificaat en datum — nooit serienummers, nooit je voortgang.',
    'learn.achievements.level_line': 'Voortgang door de niveaus',
    'learn.achievements.you': 'jij: {xp}',
    'learn.achievements.earned_on': 'Behaald {date}',
    'learn.achievements.remaining': 'Nog {n} lessen',
    'learn.achievements.not_started': 'Nog niet gestart · {min} min',
    'learn.achievements.cert_any': 'elke {n} cursussen · {a} van {b}',
    'learn.achievements.cert_progress': '{a} van {b} cursussen',
    'learn.achievements.cert_missing': 'nog: {courses}',
    'learn.achievements.cert_continue': 'Verder',
    'learn.achievements.cert_every_course': 'elke cursus telt',

    // ── Herhalen ────────────────────────────────────────────────────────────
    'learn.review.page_title': '{m} fouten te herstellen · {s} lessen verouderd',
    'learn.review.page_sub': 'Een sessie mengt eerst je fouten, dan lessen ouder dan {days} dagen, dan verse AI-vragen — zo\'n {n} items. Een goed antwoord hier wist de fout in de les zelf; een schone herbewijzing maakt de les goud.',
    'learn.review.mistakes_title': 'Fouten te herstellen',
    'learn.review.mistakes_none': 'Geen open fouten — elke quiz en simulatie die je beantwoordde is gewist.',
    'learn.review.stale_title': 'Verouderend',
    'learn.review.stale_sub': 'afgerond, niet beheerst, ouder dan {days} dagen',
    'learn.review.stale_none': 'Niets veroudert — beheerste lessen nooit.',

    // ── De certificaatlade ──────────────────────────────────────────────────
    'learn.cert.drawer_label': 'Certificaat',
    'learn.cert.brand': 'Bee Flow AI Certified',
    'learn.cert.preview_loading': 'Voorbeeld wordt gerenderd…',
    'learn.cert.download_png_full': 'Download PNG',
    'learn.cert.download_pdf_full': 'Download PDF',
    'learn.cert.public_explainer': 'Maakt een verificatielink aan. Zonder deze schakelaar bestaat de link niet; intrekken kan altijd.',

    // ── De speler ───────────────────────────────────────────────────────────
    'learn.player.pill_passed': 'Stap geslaagd',
    'learn.player.pill_passed_sub': 'alle controles geslaagd · {time}',
    'learn.player.pill_checking': 'controle loopt',
    'learn.player.pill_paused': 'gepauzeerd',
    'learn.player.pill_continue': 'Verder',
    'learn.player.restore': 'De les weer openen',
    'learn.player.do_it_for_real': 'doe het echt',
    'learn.player.lesson_pos': 'les {n} van {total} · {min} min',
    'learn.player.next_unlocks_checks': '"Volgende" ontgrendelt zodra alle controles slagen.',
    'learn.player.steps_done': '{a} van {b} stappen',
    'learn.player.to_next_level': 'nog {n} tot {level}',
    'learn.player.next_docked': 'Volgende les naast de app: {title}',
    'learn.player.next_lesson': 'Volgende les: {title}',
    'learn.player.back_to_course': 'Terug naar de cursus',
    'learn.player.back_to_center': 'Terug naar het Learning Center',
    'learn.player.badge_note': 'Bij de laatste les van een cursus verschijnt hier ook het paneel "Badge behaald".',
    'learn.mastery.clean_run_body': 'Elke quiz en simulatie in één keer goed, de oefening zonder hint. Niets onthuld.',
    'learn.action.tip': 'Tip',
    'learn.action.waiting': 'wacht…',
    'learn.action.check_error_short': 'De controle kon de app nu niet bereiken.',
    'learn.action.running': 'Controle loopt',
    'learn.action.last': 'laatst {time}',
    'learn.action.honor_link': 'Kan de controle niet draaien? Ik heb dit gedaan',
    'learn.tutor.name': 'AI-tutor',
    'learn.tutor.ladder': 'geeft eerst een hint, dan pas het antwoord',
    'learn.tutor.placeholder_step': 'Stel een vraag over deze stap…',

    // ── Rustiger overzicht (2026-09-14, tweede ronde) ───────────────────────
    'learn.hero.continue_short': 'Verder · les {n} van {total}',
    'learn.hero.review_short': 'zo\'n {n} items · ±{min} min',
    'learn.hero.review_none_short': 'Fouten en oudere lessen komen hier terecht.',
    'learn.curriculum.cert_short': 'Certificaat {a}/{b}',
    'learn.capstone.short': 'Geen lessen — bewijs het in je eigen werkruimte.',
    'learn.capstone.checks': 'Werkruimtechecks',

    // ── Ronde 3: één status per cursus, iconen in plaats van emoji ──
    'learn.course.n_of_m': '{a} van {b}',
    'learn.curriculum.n_of_m_done': '{a} van {b} afgerond',
    'learn.curriculum.no_courses': 'Nog geen cursussen op deze leerlijn.',
    'learn.hero.lesson_n_of': 'les {n} van {total}',
    'learn.hero.all_done_sub': 'Houd het vers met een herhaling, of open een cursus opnieuw.',
    'learn.hero.review_n': '{n} te herhalen',
    'learn.capstone.checks_n': '{a} van {b} checks geslaagd',
    'learn.table.ai_coach': 'AI-coach',
    'learn.table.what_counts_short': 'Beheerst als elke quiz in één keer goed is en de oefening zonder hint lukt.',

    // ── Verplichte training ──
    'org.academy.tab_required': 'Verplichte training',
    'org.training.title': 'Eerst de cursus afronden',
    'org.training.intro': 'Kies waar mensen eerst in getraind moeten zijn voordat ze het bouwen. Lezen en uitvoeren worden nooit geblokkeerd — wie de agents-cursus niet af heeft, praat gewoon met agents en draait wat collega’s bouwden; alleen zelf maken of wijzigen kan nog niet. Anders dan een permissie kunnen ze dit zélf opheffen, in een middag.',
    'org.training.open_to_all': 'Open voor iedereen wiens rol het toestaat',
    'org.training.after': 'na',
    'org.training.pick_course': 'Cursus die {area} vrijgeeft',
    'org.training.own_course': 'eigen cursus',
    'org.training.none_on': 'Nog niets vereist training.',
    'org.training.n_on': '{n} onderdeel/onderdelen vereisen een cursus.',
    'org.training.save_failed': 'Opslaan is niet gelukt. Probeer het opnieuw.',
    'org.training.exempt_note': 'Organisatiebeheerders worden nooit door deze regels geblokkeerd, en wie het Learning Center niet meer in zijn abonnement heeft evenmin — een regel die niemand kan halen legt de werkruimte stil in plaats van iemand iets te leren.',
    'training.locked': 'Rond eerst “{course}” af',
    'training.locked_progress': 'Rond eerst “{course}” af — {a} van {b} lessen gedaan',
    'studio.locked_training': 'Rond eerst de vereiste cursus af',

    // ── De onderdelen die een organisatie kan vergrendelen ──
    'learn.training_area.agents': 'Agents maken en wijzigen',
    'learn.training_area.knowledge': 'Kennisbanken maken en wijzigen',
    'learn.training_area.skills': 'Skills maken en wijzigen',
    'learn.training_area.automations': 'Routines maken en wijzigen',
    'learn.training_area.datatables': 'Datatables maken en wijzigen',
    'learn.training_area.apps': 'Apps bouwen in App Studio',
    'learn.training_area.webpages': 'Webpagina’s publiceren',
    'learn.training_area.playbooks': 'Playbooks draaien en oplossingen bundelen',
    'learn.training_area.meeting_notes': 'Vergaderingen opnemen en uploaden',
    'learn.training_area.cowork': 'Werk delegeren in Cowork',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-learning-center-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-learning-center-translations failed:', e.message);
        process.exit(1);
    });
}

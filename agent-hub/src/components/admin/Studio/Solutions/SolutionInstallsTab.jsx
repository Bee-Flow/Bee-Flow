import { AlertTriangle, HelpCircle, Info, Loader2 } from 'lucide-react';
import React, { useMemo } from 'react';
import { readInstalls } from './releaseModel';
import { Strip } from './solutionNotices';
import { useTranslation } from '../../../../hooks/useTranslation';
import { nOf } from '../KnowledgeStudio/plural';

/**
 * Installaties — hoe vaak deze Oplossing is geïnstalleerd, en waarom dat getal
 * geen totaal is.
 *
 * ── Wat hier NIET staat, en dat is het ontwerp ─────────────────────────────
 *
 * Blueprints zijn strikt org-gescoopt. Dit scherm toont daarom uitsluitend
 * GETALLEN: hoeveel installaties in deze organisatie, en hoeveel elders op deze
 * instantie. Geen projectnaam, geen eigenaar, geen organisatienaam, geen
 * tijdstip — en met opzet ook geen uitsplitsing per organisatie, want bij één
 * installatie is een aggregaat over één organisatie geen aggregaat meer.
 *
 * Dat is niet alleen een afspraak met de server: `readInstalls` bouwt het
 * antwoord uit een expliciete allow-list van twee velden, dus een kolom die
 * volgend jaar aan het antwoord wordt toegevoegd komt hier niet vanzelf op het
 * scherm terecht.
 *
 * ── Het getal is een ONDERGRENS, en dat staat er ──────────────────────────
 *
 * Geteld worden projecten OP DEZE INSTANTIE waarvan
 * `projects.installed_from_blueprint_id` naar een Blueprint van deze Oplossing
 * wijst. Dat is een installatie uit de galerij, of een installatie uit een
 * BESTAND waarvan de server heeft nagelopen dat het bestand werkelijk bij die
 * Blueprint hoort (install.verifyClaimedBlueprint). Wat er per definitie buiten
 * valt: een bestand dat iemand op zijn eigen self-host installeert, en een
 * installatie waarvan de herkomst niet vast te stellen was. "3 installaties"
 * zou dus een bewering zijn die niemand kan waarmaken; "minstens 3 op deze
 * instantie" is wat er te weten valt. Die zin staat er altijd bij als er een
 * getal staat — er is geen `complete: true` die hem kan weghalen.
 *
 * ── Nul is een antwoord, onbekend is een ander antwoord ───────────────────
 *
 * Beide helften kunnen los onbekend zijn. Een onbekende helft wordt NOOIT nul —
 * dat is het verschil tussen "niemand gebruikt dit" en "we konden het niet
 * tellen", en op precies dat verschil besluit iemand of hij een Oplossing
 * weggooit.
 */

/**
 * De telling van deze tab voor het tabblad-badge.
 *
 * GEEN BADGE BIJ NUL, en dat is geen kosmetiek. Op een tabstrook past de zin
 * niet die het getal kwalificeert ("minstens zoveel, alleen op deze instantie").
 * Een getal groter dan nul overleeft dat: het is een ONDERGRENS, en een te lage
 * ondergrens blijft waar. Een "0" niet — die leest als "niemand gebruikt dit",
 * terwijl de teller een installatie op een andere instantie per definitie niet
 * ziet. Dus komt nul, net als onbekend, de tabstrook niet op; de tab zelf zegt
 * wél welke van de twee het is. Dezelfde vorm als `controlBadge` hiernaast, dat een lege
 * bevindingenlijst ook geen "0" geeft.
 */
export function installsBadge(remote) {
    const { state, here, elsewhere } = readInstalls(remote);
    if (state !== 'ok') return { count: undefined };
    // Eén onbekende helft maakt het TOTAAL onbekend: optellen alsof de andere
    // nul was zou een verzonnen som op het tabblad zetten.
    if (here === null || elsewhere === null) return { count: undefined };
    const total = here + elsewhere;
    return { count: total > 0 ? total : undefined };
}

/** Eén helft van de telling: een getal, of de mededeling dat het er niet is. */
function Half({ known, phrase, unknownPhrase, testId }) {
    return (
        <li className="px-3 py-2 rounded-lg text-sm" data-testid={testId}
            style={{ background: 'var(--bg-secondary)', color: known ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
            {known ? phrase : unknownPhrase}
        </li>
    );
}

export default function SolutionInstallsTab({ remote }) {
    const { t } = useTranslation();
    const { state, here, elsewhere } = useMemo(() => readInstalls(remote), [remote]);

    if (state === 'loading') {
        return (
            <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
        );
    }

    // Geen antwoord is geen nul. Zonder deze regel leest een mislukte telling
    // als "niemand heeft dit geïnstalleerd".
    if (state === 'unreadable') {
        return (
            <Strip tone="var(--error)" icon={AlertTriangle} testId="installs-unreadable">
                {t('solutions.installs_unknown',
                    'How often this Solution has been installed could not be read, so this is not "never".')}
            </Strip>
        );
    }

    return (
        <div className="space-y-4">
            <ul className="space-y-1.5">
                <Half
                    known={here !== null} testId="installs-here"
                    phrase={nOf(t, 'solutions.installs_here', here || 0,
                        '{count} Solution in your organisation came from this Blueprint',
                        '{count} Solutions in your organisation came from this Blueprint')}
                    unknownPhrase={t('solutions.installs_here_unknown',
                        'How many were installed in your organisation could not be read.')}
                />
                <Half
                    known={elsewhere !== null} testId="installs-elsewhere"
                    phrase={nOf(t, 'solutions.installs_elsewhere', elsewhere || 0,
                        '{count} other Solution elsewhere on this instance came from it',
                        '{count} other Solutions elsewhere on this instance came from it')}
                    unknownPhrase={t('solutions.installs_elsewhere_unknown',
                        'How many were installed elsewhere on this instance could not be read.')}
                />
            </ul>

            {/* Staat er altijd bij zodra er een getal staat: er bestaat geen
                toestand waarin deze telling compleet is. */}
            <Strip tone="var(--text-tertiary)" icon={Info} testId="installs-incomplete">
                {t('solutions.installs_incomplete',
                    'These are at least this many — only installations on this instance are counted, and only where the install could be tied back to this Blueprint. A copy installed on another instance is invisible here.')}
            </Strip>

            {here === 0 && elsewhere === 0 && (
                <Strip tone="var(--text-tertiary)" icon={HelpCircle} testId="installs-none-yet">
                    {t('solutions.installs_none',
                        'No installation on this instance could be tied back to this Blueprint yet.')}
                </Strip>
            )}
        </div>
    );
}

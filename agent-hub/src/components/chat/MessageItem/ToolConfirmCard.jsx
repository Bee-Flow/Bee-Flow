/**
 * De kaart bij een call die de agent NIET heeft uitgevoerd.
 *
 * De server houdt een call vast zodra er een mens ja moet zeggen
 * (`toolRoundExecutor` gate 2) en stuurt dan `tool_confirm`. Tot A4 was er
 * geen enkele client voor dat event: het werd wél opgeslagen op het bericht
 * (`assistantMsg.pendingToolCalls`) maar door niemand gelezen, dus het model
 * vertelde in proza dat het ergens op wachtte en er was niets om op te
 * klikken. Dit is die kaart.
 *
 * ── DRIE DINGEN DIE DEZE KAART NIET DOET ────────────────────────────
 *  1. Hij zegt nooit dat er iets gebeurd is. De kop is "wilde", niet "deed":
 *     de call is tegengehouden vóór dispatch, en dat is het enige wat vaststaat.
 *  2. Hij toont geen knoppen die niets doen. Zonder `onDecide` — een gewone
 *     chat, waar nog geen goedkeuringspad bestaat — is dit een MEDEDELING.
 *     Een grijze "Goedkeuren" die stilletjes niets doet is precies het soort
 *     vals-groen dat een testchat hoort te vinden, niet te maken.
 *  3. Hij verzint geen argumenten. `preview` is de door de server begrensde,
 *     platte weergave (previewToolArgs: 20 sleutels, 500 tekens, geneste
 *     waarden als typelabel). Wat daar niet in staat, staat hier niet.
 *
 * ── DEZE KAART LANDT OOK IN EEN GEWONE CHAT ─────────────────────────
 * `pendingToolCalls` wordt gepersisteerd (finalizeTurn) en overleeft een
 * herlaadbeurt, dus deze kaart verschijnt óók in een gesprek van vorige maand
 * bij iemand die de agent alleen mag gebruiken. Dat is goed: "de agent wilde
 * dit en heeft het niet gedaan" is dáár even waar. Wat er NIET mag staan is de
 * uitweg die die lezer niet heeft — de tekst wees eerst naar de testchat van
 * de agent, een scherm waarvoor hij geen bewerkrecht heeft (`gateTestChatRequest`
 * weigert met 403) en dat sowieso in een ándere, efemere conceptconversatie
 * draait. De mededeling zegt nu alleen wat er gebeurd is.
 *
 * ── WAAR EEN BESLISSING OVER GAAT ───────────────────────────────────
 * Over ÉÉN actie, niet over een tool. De sleutel is `argsKey` — de server
 * hashte er naam-plus-argumenten in — dus "ja" op deze mail is geen "ja" op
 * de volgende mail met een ander adres. Vandaar dat de knoppen die sleutel
 * teruggeven en niet de toolnaam.
 */

import React from 'react';
import { AlertTriangle, Check, HelpCircle, ShieldQuestion, X } from 'lucide-react';

import { confirmDecisionOf } from './toolConfirmStatus';

/** Eén regel uit de argumentpreview. Waarden zijn al begrensd door de server. */
function PreviewRow({ name, value }) {
    return (
        <div className="flex gap-2 text-xs leading-relaxed">
            <span className="text-[var(--text-tertiary)] flex-shrink-0 font-medium">{name}</span>
            <span className="text-[var(--text-primary)] break-all whitespace-pre-wrap">
                {typeof value === 'string' ? value : JSON.stringify(value)}
            </span>
        </div>
    );
}

/**
 * @param {object[]} calls      de `pendingToolCalls` van dit bericht
 * @param {Function} [onDecide] (argsKey, 'approve'|'decline', call) — weglaten
 *   waar een beslissing nergens heen kan; dan rendert de kaart als mededeling
 * @param {object} [decided]    { [argsKey]: 'approve'|'decline' } — wat er in
 *   deze sessie al geklikt is, zodat de knoppen niet terugspringen
 * @param {Function} t
 */
export default function ToolConfirmCard({ calls, onDecide, decided = {}, t = (k, d) => d }) {
    const list = Array.isArray(calls) ? calls.filter(Boolean) : [];
    if (list.length === 0) return null;

    return (
        <div className="my-3 space-y-2">
            {list.map((call, i) => {
                const key = call.argsKey || call.callId || String(i);
                // Stand EN herkomst, uit de ene lezing die het spoor ook
                // gebruikt (`toolConfirmStatus.js`). De herkomst doet er hier
                // toe: de server zegt dat een goedgekeurde call GEDRAAID heeft,
                // een klik in deze sessie zegt dat hij bij het volgende bericht
                // gaat draaien. Dat stond hier eerst allebei als "it ran".
                const { status, by } = confirmDecisionOf(call, decided);
                const entries = call.preview && typeof call.preview === 'object'
                    ? Object.entries(call.preview)
                    : [];
                const sends = call.effect === 'sends';

                return (
                    <div
                        key={key}
                        data-testid="tool-confirm-card"
                        data-status={status}
                        className={`rounded-xl border overflow-hidden ${status === 'approved'
                            ? 'border-green-500/40 bg-green-500/5'
                            : status === 'declined'
                                ? 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)] opacity-60'
                                : status === 'unknown'
                                    ? 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)]'
                                    : 'border-amber-500/40 bg-amber-500/5'}`}
                    >
                        <div className="flex items-center gap-2 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider">
                            {status === 'approved' ? <Check className="w-3.5 h-3.5 text-green-500" />
                                : status === 'declined' ? <X className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                                    : status === 'unknown' ? <HelpCircle className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                                        : sends ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                                            : <ShieldQuestion className="w-3.5 h-3.5 text-amber-500" />}
                            <span className={status === 'approved' ? 'text-green-500'
                                : (status === 'declined' || status === 'unknown') ? 'text-[var(--text-tertiary)]'
                                    : 'text-amber-500'}>
                                {status === 'approved'
                                    ? (by === 'session'
                                        // Geklikt, nog niet verstuurd: de call
                                        // draait pas als het model hem bij het
                                        // volgende bericht opnieuw voorstelt.
                                        ? t('agent_studio.test.tool_confirm_approved_next', 'You approved this — it runs on your next message')
                                        : t('agent_studio.test.tool_confirm_approved', 'You approved this — it ran'))
                                    : status === 'declined'
                                        ? t('agent_studio.test.tool_confirm_declined', 'You declined this — it did not run')
                                        : status === 'unknown'
                                            ? t('agent_studio.test.tool_confirm_unknown', 'Could not tell whether this ran')
                                            : t('agent_studio.test.tool_confirm_title', 'Wanted to do this — it has not run')}
                            </span>
                        </div>

                        <div className="px-4 pb-3 space-y-1.5">
                            <div className="flex items-center gap-2">
                                <code className="text-sm font-semibold text-[var(--text-primary)]">{call.toolName}</code>
                                {sends && (
                                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
                                        {t('agent_studio.test.tool_effect_sends', 'leaves this workspace')}
                                    </span>
                                )}
                            </div>
                            {entries.length > 0 && (
                                <div className="space-y-1 pt-1">
                                    {entries.map(([name, value]) => (
                                        <PreviewRow key={name} name={name} value={value} />
                                    ))}
                                </div>
                            )}
                        </div>

                        {status === 'pending' && (
                            onDecide ? (
                                <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                                    <button
                                        type="button"
                                        onClick={() => onDecide(call.argsKey, 'approve', call)}
                                        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-[var(--accent)] text-white hover:opacity-90"
                                    >
                                        {t('agent_studio.test.tool_confirm_approve', 'Approve and run')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onDecide(call.argsKey, 'decline', call)}
                                        className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                                    >
                                        {t('agent_studio.test.tool_confirm_decline', 'Do not run it')}
                                    </button>
                                    <span className="text-[11px] text-[var(--text-tertiary)] ml-auto">
                                        {t('agent_studio.test.tool_confirm_next_turn', 'Applies on your next message')}
                                    </span>
                                </div>
                            ) : (
                                // Geen pad om ja te zeggen ⇒ geen knop die dat
                                // suggereert. Dit is de eerlijke helft van punt 2
                                // in de kop hierboven.
                                <div className="px-4 py-2.5 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-tertiary)]">
                                    {t('agent_studio.test.tool_confirm_no_decision',
                                        'Nothing was done — this agent asks a person before actions like this.')}
                                </div>
                            )
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/**
 * EERLIJK FALEN op elke plek waar een BRUG draait — één mechanisme, twee bruggen.
 *
 * ── HET GAT DAT DEZE MODULE DICHT ───────────────────────────────────
 *
 * Op een react-pagina draait JS, maar de bruggen die de elementen nodig hebben
 * zijn er niet: `beeflowTables` weigert en `beeflowAutomations` deed tot voor
 * kort een no-op die RESOLVET. Een `bf-*`-element dat daarvan afhangt kan daar
 * dus niets — en zonder hulp is dat ONZICHTBAAR: een niet-gedefinieerd custom
 * element is `display:inline` zonder kinderen, oftewel een leeg vak. Een lezer
 * ziet een lege tabel (die leest als "er zijn geen rijen") of een knop die niets
 * doet zonder te zeggen waarom.
 *
 * Dit mechanisme stond eerst alleen in services/publicBridgeScript.js, en die
 * brug wordt UITSLUITEND geïnjecteerd als de auteur publieke AI heeft
 * aangezet — een instelling die default UIT staat (stores/webpage/bridgeGrants.js).
 * Op de standaard publieke react-share draaide dus alleen de ingebakken stub uit
 * reactBundleServer.js, en die kende het mechanisme niet: alle vijf de elementen
 * waren daar stil dood. Precies wat W4 bestaat om uit te roeien, en dan op het
 * STANDAARDPAD. Daarom staat het mechanisme nu hier, en bakken beide bruggen het
 * onvoorwaardelijk in.
 *
 * ── WAT HIER NIET STAAT ─────────────────────────────────────────────
 *
 * Geen enkele tagnaam, geen enkele zin die de lezer te zien krijgt. Alles komt
 * uit `bridgeVocabulary(surface)` in core/webpages/bfElements.js; hier staat
 * alleen het mechanisme. core/webpages/bfElements.drift.test.js verbiedt een
 * met de hand geschreven tagnaam in dit bestand.
 *
 * ── DE PLEK IS EEN PARAMETER, GEEN AANNAME ──────────────────────────
 *
 * Dezelfde stub bedient TWEE plekken: de publieke share (`reactShare`) en het
 * plaatje dat de bouwer-AI van de pagina van de auteur te zien krijgt
 * (`headlessRender`, services/webpageRender.js). Daar zou "op een gedeelde link"
 * liegen over een pagina die ingelogd gewoon werkt, dus elke plek draagt in de
 * registry zijn eigen zin. Wie hier een plek toevoegt, voegt hem in
 * BRIDGE_SURFACES toe en de registry dwingt de teksten af.
 *
 * ── WELKE ELEMENTEN WORDEN GEMARKEERD ───────────────────────────────
 *
 * Alles wat op deze plek NIET zelf werkt: elke toestand behalve `live` (het
 * element doet het hier) en `static` (de snapshot-writer heeft het element al
 * vóór DOMPurify door gewone HTML vervangen, dus het staat niet meer in de DOM).
 * Dus ook `inert`, en ook een `bf-*`-element dat het vocabulaire NIET kent — die
 * laatste zou anders het enige element zijn dat hier nog stil verdwijnt, terwijl
 * de client-kant er wel een melding voor tekent.
 */

'use strict';

const { bridgeVocabulary } = require('../core/webpages/bfElements');

/**
 * JSON dat veilig binnen een inline `<script>` staat.
 *
 * `</script>` in een tekst uit het vocabulaire zou de brug anders in tweeën
 * knippen en alles erna laten verdwijnen. De client-tweeling
 * (agent-hub/src/utils/bfElementsRuntime.js) ontsnapt met dezelfde drie regels;
 * twee verschillende afspraken over ontsnappen zijn net zo goed drift als twee
 * lijsten.
 */
function jsonLiteral(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * Het blok dat `window.beeflowBf` neerzet en elk element dat hier niets kan een
 * zichtbare melding geeft.
 *
 * Levert een FRAGMENT, geen `<script>`: beide bruggen hebben al een eigen IIFE
 * en één script-blok per brug is wat hun tests vastleggen.
 *
 * @param {string} surface  een van bfElements.BRIDGE_SURFACES
 * @returns {string} JavaScript-brontekst
 */
function buildBfNoticeScript(surface) {
    const literal = jsonLiteral(bridgeVocabulary(surface));
    return `
  // Het elementvocabulaire zoals het HIER geldt, afgeleid uit
  // core/webpages/bfElements.js. Een element dat deze lijst niet kent is
  // "unknown" — herkenbaar onbekend, nooit stilzwijgend in orde.
  var BF_MARK = "data-bf-state";
  var BF_PREFIX = "bf-";
  window.beeflowBf = {
    elements: ${literal},
    lookup: function(tag){ return this.elements[String(tag || "").toLowerCase()] || null; },
    state: function(tag){ var e = this.lookup(tag); return e ? e.state : "unknown"; },
    reason: function(tag){
      var e = this.lookup(tag);
      if (e) return e.message || null;
      return "Unknown Bee Flow element " + String(tag || "");
    },
    // Wat de LEZER te zien krijgt. Valt terug op de ontwikkelaarstekst, en
    // daarna op een zin die tenminste nog zegt dát het hier niet kan: stilte is
    // het enige antwoord dat we niet mogen geven.
    notice: function(tag){
      var e = this.lookup(tag);
      if (e && e.notice) return e.notice;
      if (e && e.message) return e.message;
      return "This Bee Flow element is not available here.";
    },
    // Opnieuw langslopen. Zelfde naam en zelfde bedoeling als aan de
    // client-kant, zodat paginacode op beide plekken dezelfde vraag kan
    // stellen; hier is het bovendien de uitweg voor code die knopen invoegt
    // op een manier waarbij de custom-element-hook niet vuurt.
    refresh: function(root){ return bfSweep(root); }
  };
  // Werkt dit element hier zelf? "live" wel, "static" staat er niet meer (de
  // snapshot-writer heeft hem vervangen). Al het andere — inert, refused, en een
  // element dat we niet kennen — krijgt een melding.
  function bfSilentHere(state){ return state !== "live" && state !== "static"; }
  function bfIsOurs(tag){ return String(tag || "").toLowerCase().indexOf(BF_PREFIX) === 0; }
  function bfDecorate(el){
    if (!el || el.nodeType !== 1 || el.hasAttribute(BF_MARK)) return false;
    var tag = String(el.tagName || "").toLowerCase();
    if (!bfIsOurs(tag)) return false;
    var state = window.beeflowBf.state(tag);
    if (!bfSilentHere(state)) return false;
    el.setAttribute(BF_MARK, state);
    var box = document.createElement("div");
    box.setAttribute("data-bf-notice", tag);
    box.setAttribute("role", "note");
    // currentColor + opacity, zodat de melding leesbaar blijft op elke
    // achtergrond die de auteur heeft gekozen. De pagina draagt zijn eigen
    // stijlblad; wij weten er niets van.
    box.setAttribute("style", "display:block;margin:.25em 0;padding:.5em .75em;border:1px dashed currentColor;border-radius:4px;opacity:.7;font:inherit;font-size:.9em");
    // textContent, nooit innerHTML: dit is onze eigen tekst en dat moet zo
    // blijven, ook als er ooit een variabel deel bij komt.
    box.textContent = window.beeflowBf.notice(tag);
    // Toevoegen, niet vervangen: wat de auteur zelf in het element schreef (een
    // label, een terugvaltekst) is van hem en blijft staan.
    el.appendChild(box);
    return true;
  }
  // De tags waarvoor we een custom element mogen definiëren: alles wat we KENNEN
  // en dat hier niets kan. Een onbekende tag staat hier per definitie niet bij —
  // die wordt door de veeg gevonden.
  function bfSilentTags(){
    var vocab = window.beeflowBf.elements;
    return Object.keys(vocab).filter(function(tag){ return bfSilentHere(vocab[tag].state); });
  }
  // De custom-element-hook hieronder dekt alles wat de app later invoegt (React
  // doet precies dat). Deze veeg dekt wat er al stond, elk element met ons
  // voorvoegsel dat we NIET kennen, en is de uitweg voor code die knopen op een
  // manier invoegt waarbij die hook niet vuurt. Daarom scant hij op "*" en niet
  // op de lijst met tags.
  function bfSweep(root){
    var scope = root || document;
    var done = 0;
    if (scope.nodeType === 1 && bfDecorate(scope)) done++;
    var all;
    try { all = scope.querySelectorAll("*"); } catch (e) { return done; }
    for (var i = 0; i < all.length; i++) if (bfDecorate(all[i])) done++;
    return done;
  }
  (function(){
    var CE = window.customElements;
    if (CE && typeof CE.define === "function"){
      bfSilentTags().forEach(function(tag){
        // Wie eerder was, wint — een tweede define op dezelfde naam GOOIT, en
        // dat zou de rest van deze brug meenemen. Deze brug staat in <head>,
        // dus in de praktijk zijn wij eerst.
        if (CE.get(tag)) return;
        try {
          CE.define(tag, class extends HTMLElement {
            connectedCallback(){ bfDecorate(this); }
          });
        } catch (e) {}
      });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ bfSweep(); });
    else bfSweep();
  })();`;
}

module.exports = { buildBfNoticeScript, jsonLiteral };

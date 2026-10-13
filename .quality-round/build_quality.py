#!/usr/bin/env python3
"""Builds the code-quality report page (Dutch) from synthesis.json and progress.json. Run: python3 .quality-round/build_quality.py"""
import html, json, os, re, subprocess, datetime
D = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(f'{D}/synthesis.json'))
prog = json.load(open(f'{D}/progress.json')) if os.path.exists(f'{D}/progress.json') else {'items': {}, 'phases': {}}
commit = subprocess.run(['git', '-C', os.path.dirname(D), 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
today = datetime.date.today().isoformat()
css = re.search(r'<style>.*?</style>', open(f'{D}/old_template.html').read(), re.S).group(0)
css = css.replace('</style>', '''
.item.sev-critical { border-left: 4px solid var(--bad) }
.item.sev-urgent { border-left: 4px solid var(--warn) }
.item.sev-high { border-left: 4px solid var(--line) }
.sev-critical .chip.sev, .st-open { background: var(--bad-soft); color: var(--bad) }
.sev-urgent .chip.sev { background: var(--warn-soft); color: var(--warn) }
.sev-high .chip.sev { background: var(--info-soft); color: var(--muted) }
.st-done { background: var(--ok-soft); color: var(--ok) } .st-partial, .st-busy { background: var(--warn-soft); color: var(--warn) } .st-skipped, .st-todo { background: var(--info-soft); color: var(--muted) }
.score { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px }
.score .fig b { font-size: 34px } .score .fig b small { font-size: 14px; color: var(--muted); font-weight: 400 }
.bar { height: 6px; background: var(--info-soft); border-radius: 3px; overflow: hidden } .bar i { display: block; height: 100%; background: var(--accent) }
.phase-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline }
td code { font-size: 0.8em } .wrapcol { max-width: 420px }
</style>''')

def md(s):
    s = html.escape(str(s or ''))
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'((?:server|agent-hub|mobile|desktop|components|scripts|guard-service|classify-service|hub-module-sdk|nextcloud-connector|\.github|docs)/[\w./\-\[\]{},*<>]+(?::\d+(?:-\d+)?)?)', r'<code>\1</code>', s)
    return s

SEV = {'critical': 'kritiek', 'urgent': 'urgent', 'high': 'hoog'}
EFF = {'S': 'klein', 'M': 'middel', 'L': 'groot'}
RISK = {'laag': 'laag', 'middel': 'middel', 'hoog': 'hoog', 'low': 'laag', 'medium': 'middel', 'high': 'hoog'}
STATUS = {'done': 'gedaan', 'partial': 'deels', 'skipped': 'overgeslagen', 'busy': 'bezig', 'todo': 'nog te doen', 'open': 'open'}

def chip(cls, text): return f'<span class="chip {cls}">{html.escape(text)}</span>'
def status_chip(key):
    st = prog['items'].get(key, {}).get('status', 'todo')
    return chip(f'st-{st}', STATUS.get(st, st))

out = []
w = out.append
t = d['totals']
w(f'''<title>Codekwaliteit Bee Flow</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap">
{css}
<div class="wrap">
<header class="top">
  <div class="eyebrow">Kwaliteitsronde · structuur, modules, duplicatie, best practices</div>
  <h1>Codekwaliteit Bee Flow</h1>
  <div class="meta"><span>stand {today}</span><span>branch ccr-8c0edf67-243f59 · {commit}</span><span>13 Opus-agents (6 mappers, 6 skeptics, 1 synthese)</span></div>
  <p class="lede">{md(d["headline"])}</p>
  <div class="figures">
    <div class="fig"><b>{t["critical"]} / {t["urgent"]} / {t["high"]}</b><span>kritiek / urgent / hoog (bevestigd)</span></div>
    <div class="fig"><b>{t["code_files_over_1200"]}</b><span>codebestanden &gt; 1200 regels ({t["code_files_over_600"]} &gt; 600)</span></div>
    <div class="fig"><b>{t["prod_dup_lines"]:,}</b><span>gedupliceerde productieregels (+{t["test_dup_lines"]:,} in tests)</span></div>
    <div class="fig"><b>603</b><span>bestanden in de server-cyclus (via lazy requires)</span></div>
  </div>
</header>
<nav class="index"><ol>
  <li><a href="#status">Uitvoering</a></li><li><a href="#kritiek">Kritiek</a></li><li><a href="#structuur">Structuur</a></li>
  <li><a href="#splits">Splitsen</a></li><li><a href="#hergebruik">Hergebruik</a></li><li><a href="#praktijk">Best practices</a></li>
  <li><a href="#plan">Plan</a></li><li><a href="#nietnu">Niet nu</a></li><li><a href="#deps">Dependencies</a></li><li><a href="#methode">Methode</a></li>
</ol></nav>''')

# scores + status
sc = d['scores']
now = prog.get('scores_now') or {}
w('<section class="block" id="status"><div class="secno">0</div><h2>Rapportcijfers en uitvoering</h2>')
w('<p>Het eerste cijfer is de meting bij de start van de ronde; het tweede is de stand nu, bijgewerkt na elke afgeronde fase op basis van hermeting (cycli, duplicatie, lange bestanden, open bevindingen).</p><div class="score">')
for k, lab in [('structuur', 'structuur'), ('modulariteit', 'modulariteit'), ('duplicatie', 'duplicatie'), ('best_practices', 'best practices'), ('tests', 'tests')]:
    cur = now.get(k, sc[k])
    arrow = '' if cur == sc[k] else (' <span style="color:var(--ok)">▲</span>' if cur > sc[k] else ' <span style="color:var(--bad)">▼</span>')
    w(f'<div class="fig"><b>{cur}<small> /10</small>{arrow}</b><span>{lab} <span class="muted">(start {sc[k]})</span></span><div class="bar"><i style="width:{cur*10}%"></i></div></div>')
w(f'</div><p class="muted" style="margin-top:10px"><b>Bij de start:</b> {md(sc["toelichting"])}</p>')
if now.get('toelichting'): w(f'<p style="margin-top:6px"><b>Nu:</b> {md(now["toelichting"])}</p>')
mn = prog.get('metrics_now')
if mn:
    w('<div class="tablewrap"><table><tr><th>Meting</th><th>Start</th><th>Nu</th></tr>')
    for lab, a, b in mn: w(f'<tr><td>{html.escape(lab)}</td><td>{html.escape(str(a))}</td><td><b>{html.escape(str(b))}</b></td></tr>')
    w('</table></div>')
w('<h3>Stand van de uitvoering</h3><div class="tablewrap"><table><tr><th>Fase</th><th>Doel</th><th>Status</th><th>Opmerking</th></tr>')
for i, p in enumerate(d['plan'], 1):
    ps = prog['phases'].get(str(i), {})
    w(f'<tr><td>{i}. {html.escape(p["fase"])}</td><td class="wrapcol">{md(p["doel"])}</td><td>{chip("st-"+ps.get("status","todo"), STATUS.get(ps.get("status","todo")))}</td><td class="wrapcol">{md(ps.get("note",""))}</td></tr>')
w('</table></div></section>')

# critical
w('<section class="block" id="kritiek"><div class="secno">1</div><h2>Kritiek, urgent en hoog</h2><p>Alleen bevindingen die een onafhankelijke tweede agent op de genoemde regels heeft bevestigd. Elke fix krijgt een test die het lek eerst aantoont.</p>')
for c in d['critical']:
    w(f'''<details class="item sev-{c["severity"]}"><summary><span class="count">{html.escape(c["id"])}</span><span class="title">{md(c["title"])}</span>{chip("sev", SEV[c["severity"]])}{chip("eff-"+ {"S":"small","M":"medium","L":"large"}[c["effort"]], "moeite: "+EFF[c["effort"]])}{status_chip(c["id"])}</summary>
<dl><dt>Waar</dt><dd>{md(c["area"])}</dd><dt>Bewijs</dt><dd>{md(c["evidence"])}</dd><dt>Gevolg</dt><dd>{md(c["impact"])}</dd><dt>Fix</dt><dd>{md(c["fix"])}</dd>''')
    note = prog['items'].get(c['id'], {}).get('note')
    if note: w(f'<dt>Uitvoering</dt><dd>{md(note)}</dd>')
    w('</dl></details>')
w('</section>')

# structure
s = d['structure']
w(f'<section class="block" id="structuur"><div class="secno">2</div><h2>Structuur en modules</h2><p>{md(s["summary"])}</p>')
w('<h3>Cycli</h3><div class="tablewrap"><table><tr><th>Waar</th><th>Omvang</th><th>Mechanisme</th><th>Fix</th><th>Moeite</th></tr>')
for c in s['cycles']: w(f'<tr><td>{md(c["scope"])}</td><td class="num">{c["size"]}</td><td class="wrapcol">{md(c["mechanism"])}</td><td class="wrapcol">{md(c["fix"])}</td><td>{EFF.get(c["effort"], c["effort"])}</td></tr>')
w('</table></div><h3>Laagregels die de repo moet afdwingen</h3><div class="panel"><ul>')
for r in s['layering_rules']: w(f'<li>{md(r)}</li>')
w('</ul></div><details class="item"><summary><span class="title">Modulekaart (de belangrijkste modules over alle pakketten)</span><span class="count">' + str(len(s['module_map'])) + '</span></summary><div class="tablewrap"><table><tr><th>Module</th><th>Rol</th><th>Staat</th><th>Opmerking</th></tr>')
HC = {'goed': 'prod-no', 'gemengd': 'partial', 'slecht': 'eff-large', 'good': 'prod-no', 'mixed': 'partial', 'poor': 'eff-large'}
for m in s['module_map']: w(f'<tr><td><code>{html.escape(m["path"])}</code></td><td class="wrapcol">{md(m["role"])}</td><td>{chip(HC.get(m["health"], ""), m["health"])}</td><td class="wrapcol">{md(m.get("note",""))}</td></tr>')
w('</table></div></details></section>')

# splits
w('<section class="block" id="splits"><div class="secno">3</div><h2>Lange bestanden opsplitsen</h2><p>Alleen echte code; data, templates en fixtures staan onder "Niet nu". Golf 1 is laag risico en hoge waarde; golf 3 raakt beveiligingskritieke code en gaat alleen achter een gate-volgordetest.</p>')
for wave in (1, 2, 3):
    items = [x for x in d['splits'] if x['wave'] == wave]
    w(f'<h3>Golf {wave} <span class="count">{len(items)} bestanden</span></h3><div class="tablewrap"><table><tr><th>Bestand</th><th>Regels</th><th>Wordt</th><th>Risico</th><th>Moeite</th><th>Status</th></tr>')
    for x in items:
        into = '<br>'.join(f'<code>{html.escape(m["module"])}</code> <span class="muted">{html.escape(m["responsibility"])}</span>' for m in x['into'])
        w(f'<tr><td><code>{html.escape(x["file"])}</code><div class="muted" style="font-size:13px">{md(x.get("why_now",""))}</div></td><td class="num">{x["lines"]}</td><td class="wrapcol">{into}</td><td>{chip("risk-"+{"laag":"low","middel":"medium","hoog":"high"}.get(x["risk"],x["risk"]), RISK.get(x["risk"], x["risk"]))}</td><td>{EFF.get(x["effort"], x["effort"])}</td><td>{status_chip("split:"+x["file"])}</td></tr>')
    w('</table></div>')
w('</section>')

# reuse
AP = {'generate-mirror': 'genereren (één bron, mirror)', 'extract-shared': 'gedeelde module', 'merge': 'samenvoegen', 'test-helper': 'testhelper', 'keep': 'bewust laten'}
w('<section class="block" id="hergebruik"><div class="secno">4</div><h2>Duplicatie en hergebruik</h2><p>Gesorteerd op aantal gedupliceerde regels. "Genereren" betekent: één bron, de kopie wordt door <code>scripts/gen-shared-mirror.mjs</code> gemaakt en door <code>lint:shared-mirror</code> bewaakt, zoals <code>shared/expr</code> nu al.</p><div class="tablewrap"><table><tr><th>Regels</th><th>Wat</th><th>Aanpak</th><th>Doel</th><th>Status</th></tr>')
for r in d['reuse']:
    w(f'<tr><td class="num">{r["lines"]}</td><td class="wrapcol">{md(r["concept"])}<div class="muted" style="font-size:13px">{md(r.get("note",""))}</div></td><td>{AP.get(r["approach"], r["approach"])}</td><td class="wrapcol">{md(r["target"])}</td><td>{status_chip("reuse:"+r["concept"])}</td></tr>')
w('</table></div></section>')

# best practices + ratchets
w('<section class="block" id="praktijk"><div class="secno">5</div><h2>Best practices en ratchets</h2><div class="tablewrap"><table><tr><th>Praktijk</th><th>Status</th><th>Bewijs</th><th>Fix</th><th>Impact</th></tr>')
BP = {'ontbreekt': 'eff-large', 'gedeeltelijk': 'partial', 'aanwezig-maar-niet-afgedwongen': 'where'}
for b in d['best_practices']: w(f'<tr><td>{md(b["title"])}</td><td>{chip(BP.get(b["status"], ""), b["status"].replace("-", " "))}</td><td class="wrapcol">{md(b["evidence"])}</td><td class="wrapcol">{md(b["fix"])}</td><td>{b["impact"]}</td></tr>')
w('</table></div><h3>Ratchets: werken ze of bevriezen ze?</h3><div class="tablewrap"><table><tr><th>Ratchet</th><th>Budget</th><th>Oordeel</th><th>Actie</th></tr>')
RV = {'werkt': 'prod-no', 'bevroren': 'partial', 'ontbreekt': 'eff-large'}
for r in d['ratchets']: w(f'<tr><td>{md(r["name"])}</td><td>{md(r["budget"])}</td><td>{chip(RV.get(r["verdict"], ""), r["verdict"])}</td><td class="wrapcol">{md(r["action"])}</td></tr>')
w('</table></div></section>')

# plan
MODEL = {'sonnet': 'Sonnet', 'opus': 'Opus', 'fable': 'Fable'}
w('<section class="block" id="plan"><div class="secno">6</div><h2>Plan van aanpak</h2><p>Zes fasen, elk item is één PR-grote eenheid. Volgorde: eerst de lekken, dan de grenzen (zodat splitsen geen nieuwe opwaartse imports maakt), dan splitsen en hergebruik, als laatste de ratchets.</p>')
for i, p in enumerate(d['plan'], 1):
    ps = prog['phases'].get(str(i), {})
    w(f'<div class="phase"><div class="phase-head"><h3>{i}. {html.escape(p["fase"])}</h3>{chip("eff-"+{"S":"small","M":"medium","L":"large"}.get(p["effort"],"medium"), "moeite: "+EFF.get(p["effort"],p["effort"]))}{chip("risk-"+{"geen":"low","laag":"low","middel":"medium"}.get(p["risico_ux"],"low"), "UX-risico: "+p["risico_ux"])}{chip("where", "model: "+MODEL.get(p["model_advies"],p["model_advies"]))}{chip("st-"+ps.get("status","todo"), STATUS.get(ps.get("status","todo")))}</div><p class="goal">{md(p["doel"])}</p><ol class="steps">')
    for it in p['items']: w(f'<li>{md(it)}</li>')
    w('</ol></div>')
w('</section>')

# not now
w('<section class="block" id="nietnu"><div class="secno">7</div><h2>Bewust niet nu</h2><div class="tablewrap"><table><tr><th>Wat</th><th>Waarom niet</th></tr>')
for n in d['not_now']: w(f'<tr><td class="wrapcol">{md(n["item"])}</td><td>{md(n["reason"])}</td></tr>')
w('</table></div></section>')

# deps
w('''<section class="block" id="deps"><div class="secno">8</div><h2>Dependencies: hebben we alles nodig?</h2>
<p>Tekstscan over alle 8 npm-pakketten (geen installs): welke gedeclareerde dependency wordt nergens geïmporteerd, in een script of in een config gebruikt; en wat elk pakket aan transitieve pakketten en schijfruimte meebrengt.</p>
<div class="cols"><div class="panel"><h3 style="margin-top:0">Overbodig (2)</h3><ul>
<li><code>server</code>: <code>docker-modem</code> staat als directe dependency, wordt nergens geïmporteerd; <code>dockerode</code> brengt dezelfde 5.0.7 al mee. Wordt verwijderd.</li>
<li><code>server</code>: <code>y-protocols</code> wordt alleen in tests geïmporteerd (de collab-bundle heeft het ingebakken). Gaat naar <code>devDependencies</code>; de versie-gelijkheid met agent-hub blijft gelden.</li></ul>
<p class="muted">Alles wat verder verdacht leek is nodig: <code>@vitest/coverage-v8</code> (via <code>vitest --coverage</code>), <code>react-dom</code> en <code>react-test-renderer</code> in mobile (peer deps van radix/vaul en jest-expo), de Docusaurus-pakketten, <code>esbuild</code> en <code>jszip</code> in hub-module-sdk.</p></div>
<div class="panel"><h3 style="margin-top:0">Zwaar, maar in gebruik</h3><div class="tablewrap"><table><tr><th>Pakket</th><th>Schijf</th><th>Oordeel</th></tr>
<tr><td><code>onnxruntime-node</code> (via <code>@huggingface/transformers</code>)</td><td class="num">288 MB</td><td>Fallback-tier voor embeddings, lokale whisper en CPU-rerank; dezelfde image draait prd en self-host. Blijft.</td></tr>
<tr><td><code>googleapis</code></td><td class="num">242 MB</td><td>Vervangbaar door losse <code>@googleapis/*</code>-pakketten met dezelfde API (~95% kleiner). Kandidaat voor een aparte fase.</td></tr>
<tr><td><code>@opentelemetry/auto-instrumentations-node</code></td><td class="num">46 MB</td><td>150 pakketten voor ~60 bibliotheken; we gebruiken er een handvol. Gericht instrumenteren is klein werk.</td></tr>
<tr><td><code>exceljs</code>, <code>isolated-vm</code>, <code>re2</code>, <code>sodium-native</code>, <code>esbuild</code></td><td class="num">12–23 MB</td><td>Alle in gebruik; laten staan.</td></tr></table></div></div></div></section>''')

# method
w(f'''<section class="block" id="methode"><div class="secno">9</div><h2>Hoe gemeten</h2><div class="panel"><ul>
<li><b>Meetdata vooraf</b> (deterministisch, geen agents): regellengte van alle niet-testbronbestanden; jscpd-cloneranalyse (budget 49.644, gemeten 49.166); import-graaf per pakket met Tarjan-cycli, fan-in/fan-out en map-naar-map-edges.</li>
<li><b>Zes mappers</b> (Opus) per gebied: server-core, server-routes-stores, server-domein, agent-hub, mobile+desktop, tooling. Elke claim met <code>pad:regel</code>.</li>
<li><b>Zes skeptics</b> (Opus, onafhankelijk): weerleggen of bevestigen per bevinding op de genoemde regels; {sum(1 for c in d["critical"])} van 40 claims bleven over, {t["critical"]} kritiek, {t["urgent"]} urgent, {t["high"]} hoog. Downgrades en weerleggingen zijn niet opgenomen.</li>
<li><b>Synthese</b> (Opus): merge over gebieden, één plan. Templates, fixtures en catalogi zijn als data geclassificeerd en geen splitskandidaat.</li>
<li><b>Grenzen</b>: de graaf telt ook type-only imports (mobile) en lazy requires (server); de synthese corrigeert daarvoor. Mobile-cycli zijn grotendeels type-only.</li>
</ul></div></section>
</div>''')
open(f'{D}/kwaliteitsronde.html', 'w').write('\n'.join(out))
print('ok', len('\n'.join(out)))

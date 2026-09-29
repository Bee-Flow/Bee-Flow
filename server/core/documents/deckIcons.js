// @typecheck
/**
 * Icons on slides — a card's, a KPI tile's — from a bundled Lucide subset
 * (deckIconData.js). Two outputs from one source: an inline SVG for the PDF
 * deck, and a PNG (rasterised with sharp, cached per name × colour × size)
 * for the .pptx, where pptxgenjs can only place bitmaps reliably.
 *
 * Names are Lucide's kebab-case ones; a few spellings people reach for
 * ("home", "chart", "wifi off", "check_circle") are mapped. An unknown name
 * yields no icon and a warning from the model, never a broken slide.
 */

const ICONS = require('./deckIconData');

const ALIASES = Object.freeze({
    home: 'house', chart: 'chart-column', 'bar-chart': 'chart-column', 'line-chart': 'chart-line', 'pie-chart': 'chart-pie',
    graph: 'chart-line', help: 'info', question: 'info', warning: 'triangle-alert', alert: 'circle-alert', error: 'circle-x',
    success: 'circle-check', done: 'circle-check', tick: 'check', tools: 'wrench', tool: 'wrench', cog: 'settings', gear: 'settings',
    ai: 'sparkles', robot: 'bot', chip: 'cpu', security: 'shield', secure: 'shield-check', privacy: 'lock', password: 'key',
    document: 'file-text', doc: 'file-text', documents: 'files', email: 'mail', chat: 'message-square', team: 'users', person: 'user',
    company: 'building-2', office: 'building', world: 'globe', location: 'map-pin', time: 'clock', speed: 'gauge', growth: 'trending-up',
    money: 'coins', euros: 'euro', invoice: 'receipt', idea: 'lightbulb', launch: 'rocket', goal: 'target', favourite: 'star', favorite: 'star',
    apps: 'layout-grid', app: 'app-window', automation: 'workflow', flow: 'workflow', process: 'workflow', pipeline: 'git-branch',
    play: 'circle-play', offline: 'wifi-off', online: 'wifi', 'cloud-off': 'cloud-off', storage: 'database', data: 'database',
});

function normaliseIconName(name) {
    const raw = String(name || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/^:|:$/g, '');
    if (!raw) return null;
    const resolved = ALIASES[raw] || raw;
    return Object.prototype.hasOwnProperty.call(ICONS, resolved) ? resolved : null;
}

function iconNames() {
    return Object.keys(ICONS);
}

function attrs(obj) {
    return Object.entries(obj).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
}

/**
 * The icon as an SVG element string, `size` px square, stroked in `colour`.
 * Lucide icons are stroke drawings: 2px on the 24-grid, round caps/joins.
 */
function iconSvg(name, colour = '#1A1D21', { size = 24, strokeWidth = 2 } = {}) {
    const key = normaliseIconName(name);
    if (!key) return '';
    const body = ICONS[key].map(([tag, a]) => `<${tag}${attrs(a)}/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${colour}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const pngCache = new Map();

/** The icon as a PNG data: URL, `px` square — for pptxgenjs. Null without sharp or for an unknown name. */
async function iconPng(name, colour = '#1A1D21', px = 192) {
    const key = normaliseIconName(name);
    if (!key) return null;
    const cacheKey = `${key}|${colour}|${px}`;
    if (pngCache.has(cacheKey)) return pngCache.get(cacheKey);
    let sharp;
    try { sharp = require('sharp'); } catch { return null; }
    try {
        const svg = iconSvg(key, colour, { size: px, strokeWidth: 1.75 });
        const png = await sharp(Buffer.from(svg), { density: 192 }).resize(px, px).png().toBuffer();
        const url = `data:image/png;base64,${png.toString('base64')}`;
        if (pngCache.size > 400) pngCache.clear();
        pngCache.set(cacheKey, url);
        return url;
    } catch {
        return null;
    }
}

module.exports = { normaliseIconName, iconNames, iconSvg, iconPng };

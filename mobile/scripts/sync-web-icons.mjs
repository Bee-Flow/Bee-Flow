/**
 * Generate src/shared/ui/icons/registry.generated.ts: every Lucide icon the
 * phone can draw, by name.
 *
 * The web app draws Lucide (`lucide-react`, 0.562); the phone draws the same
 * set through `lucide-react-native`, pinned to the same release so a name
 * means the same glyph on both. The registry holds two lists:
 *
 *   - the web's own ICON_REGISTRY (agent-hub/src/components/icons/iconRegistry.js,
 *     read as text: Metro cannot import from agent-hub), because those are the
 *     names a user or the CMS can put in `app.icon` and friends, which
 *     AppIcon must resolve;
 *   - MOBILE_ICONS below: the names the phone's own screens pass to <Icon>;
 *   - FLOW_EDITOR_ICONS: the flow editor's glyphs, spelled as the web spells them.
 *
 * WHY ONE MODULE PER ICON. The package's `exports` offers only its barrel,
 * which re-exports all ~1,670 icons. Metro does not tree-shake, so even a
 * named `import { Bot } from 'lucide-react-native'` bundles every one of them
 * (and makes every Jest test that renders an icon load 1,670 modules). The
 * registry therefore imports each icon's own file, `dist/esm/icons/<file>.js`;
 * metro.config.js and jest.config.js resolve those paths, and icons.d.ts types
 * them. Never `import *`.
 *
 * A web name that Lucide has since renamed (HelpCircle, MoreVertical, …) stays
 * a key here — the web and stored content still use it — and points at the
 * same component as its current name.
 *
 * Run:    cd mobile && node scripts/sync-web-icons.mjs
 * Check:  node scripts/sync-web-icons.mjs --check   (exit 1 when out of date;
 *         src/shared/ui/icons/registry.generated.test.ts runs this)
 *
 * To use a new icon on the phone: add its current Lucide name
 * (https://lucide.dev/icons) to MOBILE_ICONS and run the script.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '..');
const WEB_REGISTRY = path.resolve(MOBILE, '../agent-hub/src/components/icons/iconRegistry.js');
const LUCIDE_BARREL = path.join(MOBILE, 'node_modules/lucide-react-native/dist/esm/lucide-react-native.js');
const OUT = path.join(MOBILE, 'src/shared/ui/icons/registry.generated.ts');
const ICON_PATH = 'lucide-react-native/dist/esm/icons';

/** Names the phone's screens use directly, as current Lucide names. */
export const MOBILE_ICONS = [
    'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Award', 'Ban', 'Bell', 'Book', 'BookOpen', 'Bookmark', 'Bot', 'Brain',
    'Briefcase', 'Camera', 'CameraOff', 'ChartNoAxesColumn', 'Check', 'ChevronDown', 'ChevronRight',
    'ChevronUp', 'Circle', 'CircleAlert', 'CircleCheck', 'CircleCheckBig', 'CircleMinus', 'CircleQuestionMark',
    'CircleX', 'Clapperboard', 'Clipboard', 'ClipboardList', 'Clock', 'Cloud', 'CloudUpload', 'Compass', 'Copy',
    'CornerDownRight', 'CornerUpLeft', 'Cpu', 'Database', 'Download', 'Droplet', 'Ellipsis', 'EllipsisVertical', 'Eraser',
    'ExternalLink', 'Eye', 'EyeOff', 'FastForward', 'File', 'FilePlus', 'FileText', 'Folder',
    'GitCommitHorizontal', 'Github', 'Globe', 'GraduationCap', 'Handshake', 'HardDrive', 'Hexagon', 'History',
    'House', 'Image', 'Inbox', 'Info', 'Key', 'LayoutGrid', 'LayoutTemplate', 'Library', 'LifeBuoy', 'Link',
    'List', 'Loader', 'LoaderCircle', 'Lock', 'LockOpen', 'LogIn', 'LogOut', 'Mail', 'Menu', 'MessageCircle',
    'MessageSquare', 'Mic', 'MicOff', 'Minus', 'Monitor', 'OctagonAlert', 'Package', 'PanelsTopLeft', 'Pause',
    'Pen', 'PenLine', 'Pencil', 'PhoneCall', 'PhoneOff', 'Pin', 'PinOff', 'Play', 'Plus', 'Power', 'Printer',
    'Redo2', 'RefreshCw', 'Repeat', 'RotateCw', 'Search', 'Server', 'Settings', 'Share2', 'Shield',
    'ShieldCheck', 'ShieldOff', 'ShieldQuestionMark', 'SlidersVertical', 'Smartphone', 'Square',
    'SquareCheckBig', 'SquarePen', 'Star', 'Table2', 'TextAlignStart', 'ThumbsDown', 'ThumbsUp', 'Trash2',
    'TriangleAlert', 'Type', 'Undo2', 'Unlink', 'Upload', 'User', 'Users', 'Volume2', 'WifiOff', 'Workflow',
    'Wrench', 'X', 'Zap',
    // The organisation's settings (features/org and the org-* features).
    'Activity', 'AtSign', 'BadgeCheck', 'ChartLine', 'ChartPie', 'CircleDollarSign', 'CloudCog', 'Crown',
    'DatabaseZap', 'FingerprintPattern', 'FolderGit2', 'Funnel', 'Hash', 'ImagePlus', 'KeySquare', 'Link2',
    'Network', 'QrCode', 'Receipt', 'Save', 'Siren', 'SwatchBook', 'Tag', 'Timer', 'TrendingUp',
    'Unplug', 'UserMinus', 'UserPlus', 'UserX', 'Wallet', 'Webhook',
    // App Studio (features/app-studio).
    'Braces', 'Dna', 'FilePenLine', 'SquareStack',
    // Rich answers (shared/markdown): link cards, diagram full view, test reports.
    'ArrowRight', 'Bug', 'Maximize2',
];

/**
 * The flow editor's glyphs, in the WEB's spelling. The step picker's items
 * (model/palette), the node cards (components/outline/stepIcons.ts) and the
 * step-symbol picker (STEP_ICON_NAMES) name their Lucide icons exactly as the
 * web files do, because lockstep tests compare them with those files — and a
 * few are Lucide's older aliases (CheckCircle2, Code2, FileSignature), which
 * resolve to the current glyph like any web name.
 */
export const FLOW_EDITOR_ICONS = [
    // Node cards and palette items.
    'Activity', 'AppWindow', 'Bell', 'BellRing', 'BookOpen', 'Bot', 'Box', 'Braces', 'Calendar', 'CheckCircle2',
    'ChevronsDown', 'ClipboardList', 'Clock', 'Code', 'Code2', 'Copy', 'Eye', 'FilePen', 'FilePlus', 'FileSignature',
    'FileText', 'FileUp', 'GitFork', 'Globe', 'Hourglass', 'Layers', 'ListFilter', 'LogIn', 'LogOut', 'Mail',
    'MousePointer2', 'OctagonX', 'Pencil', 'Plus', 'Presentation', 'RectangleHorizontal', 'RefreshCw', 'Repeat',
    'Rows3', 'ScanText', 'Search',
    'Share2', 'ShieldAlert', 'ShieldCheck', 'Sigma', 'Sparkles', 'Split', 'StickyNote', 'Table2', 'Tag', 'Trash2',
    'VenetianMask', 'Webhook', 'Wrench', 'Zap',
    // The step-symbol picker (flow/stepIcons.jsx ICON_DEFS).
    'Mail', 'MessageSquare', 'MessagesSquare', 'Send', 'Bell', 'Phone', 'AtSign',
    'FileText', 'File', 'Files', 'Folder', 'FolderOpen', 'Paperclip', 'Clipboard', 'ClipboardList',
    'Book', 'BookOpen', 'Newspaper', 'Image', 'Mic', 'Video', 'Camera',
    'Database', 'Table', 'Server', 'HardDrive', 'Box', 'Boxes', 'Package', 'Archive',
    'Zap', 'Play', 'Repeat', 'RefreshCw', 'GitBranch', 'Filter', 'Workflow', 'Shuffle', 'ArrowRightLeft',
    'Clock', 'Calendar', 'CalendarClock', 'Timer', 'AlarmClock',
    'User', 'Users', 'UserPlus', 'Contact', 'Building2', 'Briefcase',
    'Globe', 'Cloud', 'Link', 'Rss', 'Webhook', 'Wifi',
    'Bot', 'Sparkles', 'Brain', 'Cpu', 'Wand2',
    'Check', 'CheckCircle', 'Flag', 'Star', 'Heart', 'Bookmark', 'Tag', 'Tags', 'ShieldCheck', 'Lock', 'Key',
    'AlertTriangle', 'Info', 'Eye', 'Search', 'Settings', 'Wrench', 'Code', 'Terminal', 'Hash',
    'ListChecks', 'Pencil', 'Download', 'Upload', 'Target', 'Rocket', 'Lightbulb', 'Gift',
    'DollarSign', 'CreditCard', 'ShoppingCart', 'Receipt', 'TrendingUp', 'BarChart3', 'PieChart',
    'MapPin', 'Map', 'Home', 'Truck', 'Coffee', 'Printer', 'Calculator', 'Activity',
];

/** The names in the web's `export const ICON_REGISTRY = { … }`, in order. */
export function webIconNames(src) {
    const body = /export const ICON_REGISTRY\s*=\s*\{([\s\S]*?)\};/.exec(src)?.[1];
    if (!body) throw new Error(`No ICON_REGISTRY object in ${WEB_REGISTRY}`);
    return body
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** The web's last-resort icon: `export const FALLBACK_ICON = HelpCircle;`. */
export function webFallbackName(src) {
    const name = /export const FALLBACK_ICON\s*=\s*([A-Za-z0-9]+);/.exec(src)?.[1];
    if (!name) throw new Error(`No FALLBACK_ICON in ${WEB_REGISTRY}`);
    return name;
}

/** Every name lucide-react-native exports, mapped to the icon file it comes from. */
export function lucideExports(barrelSrc) {
    const files = new Map();
    for (const m of barrelSrc.matchAll(/export \{([^}]*)\} from '\.\/icons\/([a-z0-9-]+)\.js'/g)) {
        for (const part of m[1].split(',')) {
            files.set(part.trim().replace(/^default as /, ''), m[2]);
        }
    }
    return files;
}

/** `circle-question-mark` → `CircleQuestionMark`: the icon's current name. */
const pascal = (file) =>
    file
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');

export function render({ webNames, fallback, mobileNames, exportsMap }) {
    const names = [...new Set([...webNames, fallback, ...mobileNames])].sort();
    const missing = names.filter((n) => !exportsMap.has(n));
    if (missing.length) throw new Error(`Not in lucide-react-native: ${missing.join(', ')}`);

    // One import per icon FILE, bound to that icon's current name.
    const bindings = new Map();
    for (const name of names) {
        const file = exportsMap.get(name);
        const current = pascal(file);
        if (exportsMap.get(current) !== file) throw new Error(`Cannot name ${file}.js (${name})`);
        bindings.set(file, current);
    }
    // Code-unit order, like `names` above: localeCompare follows the machine's
    // locale (Estonian files Z between S and T), and --check must not.
    const imports = [...bindings]
        .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([file, binding]) => `import ${binding} from '${ICON_PATH}/${file}.js';`);
    const entries = names.map((name) => {
        const binding = bindings.get(exportsMap.get(name));
        return binding === name ? `    ${name},` : `    ${name}: ${binding},`;
    });
    const list = (xs) => xs.map((n) => `    '${n}',`).join('\n');

    return `/**
 * GENERATED by scripts/sync-web-icons.mjs — do not edit. Run
 * \`node scripts/sync-web-icons.mjs\` after changing its MOBILE_ICONS or when
 * the web's iconRegistry.js changes (registry.generated.test.ts fails then).
 *
 * One import per icon file: the package barrel would bundle all of Lucide.
 */
/* eslint-disable import/order, max-lines -- generated: one import per icon, sorted by name */
import type { LucideIcon } from 'lucide-react-native';

${imports.join('\n')}

export const ICON_REGISTRY = {
${entries.join('\n')}
} satisfies Record<string, LucideIcon>;

/** A name <Icon> and <AppIcon> can draw. */
export type IconName = keyof typeof ICON_REGISTRY;

/** The web's ICON_REGISTRY names (agent-hub/src/components/icons/iconRegistry.js). */
export const WEB_ICON_NAMES = [
${list(webNames)}
] as const satisfies readonly IconName[];

/** The web's FALLBACK_ICON: what an unknown name draws. */
export const WEB_FALLBACK_ICON: IconName = '${fallback}';
`;
}

function main() {
    const webSrc = fs.readFileSync(WEB_REGISTRY, 'utf8');
    const out = render({
        webNames: webIconNames(webSrc),
        fallback: webFallbackName(webSrc),
        mobileNames: [...MOBILE_ICONS, ...FLOW_EDITOR_ICONS],
        exportsMap: lucideExports(fs.readFileSync(LUCIDE_BARREL, 'utf8')),
    });
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (process.argv.includes('--check')) {
        if (current !== out) {
            console.error(`${path.relative(MOBILE, OUT)} is out of date: run node scripts/sync-web-icons.mjs`);
            process.exit(1);
        }
        return;
    }
    if (current !== out) fs.writeFileSync(OUT, out);
    console.log(`${path.relative(MOBILE, OUT)}: ${current === out ? 'up to date' : 'written'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

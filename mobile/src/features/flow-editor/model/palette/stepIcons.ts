/**
 * The symbols a reusable Step (or a step's own `icon`) may carry — the names
 * of the web builder's flow/stepIcons.jsx ICON_DEFS, in picker order. A name
 * outside this list draws the generic Box. palette.lockstep.test.ts reads the
 * web file and compares the list.
 */

export const STEP_ICON_NAMES: readonly string[] = [
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

const KNOWN = new Set(STEP_ICON_NAMES);

/** True when `name` is one of the step symbols. */
export function isStepIcon(name: unknown): name is string {
    return typeof name === 'string' && KNOWN.has(name);
}

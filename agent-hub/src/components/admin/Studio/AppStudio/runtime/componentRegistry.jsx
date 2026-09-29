import {
    AlignLeft,
    AppWindow,
    BarChart3,
    Box,
    Calendar,
    CalendarClock,
    CalendarDays,
    CheckSquare,
    ChevronsUpDown,
    ClipboardList,
    FileText,
    FileUp,
    Dna,
    Footprints,
    Gauge,
    Globe,
    Hash,
    Heading1,
    History,
    IdCard,
    Image,
    Images,
    LayoutTemplate,
    Link2,
    List,
    ListChecks,
    ListFilter,
    Megaphone,
    MousePointerClick,
    PanelTop,
    PlugZap,
    Percent,
    Repeat2,
    Rows3,
    SeparatorHorizontal,
    Columns2,
    MessagesSquare,
    ShieldCheck,
    Sparkles,
    Square,
    SquareKanban,
    SquareStack,
    StretchVertical,
    Table,
    Table2,
    TableProperties,
    Tags,
    TextCursorInput,
    TextQuote,
    Type,
    UserRound,
} from 'lucide-react';

import AppAiChat from './components/AppAiChat';
import AppApprovalList from './components/AppApprovalList';
import AppBadgeList from './components/AppBadgeList';
import AppButton from './components/AppButton';
import AppCalendar from './components/AppCalendar';
import AppCallout from './components/AppCallout';
import AppCard from './components/AppCard';
import AppChart from './components/AppChart';
import AppContainer from './components/AppContainer';
import AppMessageThread from './components/AppMessageThread';
import AppPane from './components/AppPane';
import AppDataGrid from './components/AppDataGrid';
import AppDivider from './components/AppDivider';
import AppFilterBar from './components/AppFilterBar';
import AppForm from './components/AppForm';
import AppHeading from './components/AppHeading';
import AppConnectorStatus from './components/AppConnectorStatus';
import AppFileGallery from './components/AppFileGallery';
import AppFilePreview from './components/AppFilePreview';
import AppStepper from './components/AppStepper';
import AppImage from './components/AppImage';
import AppInputCheckbox from './components/AppInputCheckbox';
import AppInputDate from './components/AppInputDate';
import AppInputDatetime from './components/AppInputDatetime';
import AppBrowserView from './components/AppBrowserView';
import AppDatasetUpload from './components/AppDatasetUpload';
import AppInputFile from './components/AppInputFile';
import AppInputMultiselect from './components/AppInputMultiselect';
import AppInputNumber from './components/AppInputNumber';
import AppInputPerson from './components/AppInputPerson';
import AppInputRelation from './components/AppInputRelation';
import AppInputHtml from './components/AppInputHtml';
import AppInputRichtext from './components/AppInputRichtext';
import AppInputSelect from './components/AppInputSelect';
import AppInputText from './components/AppInputText';
import AppInputTextarea from './components/AppInputTextarea';
import AppKanban from './components/AppKanban';
import AppKeyValue from './components/AppKeyValue';
import AppList from './components/AppList';
import AppMarkdown from './components/AppMarkdown';
import AppModal from './components/AppModal';
import AppPageHeader from './components/AppPageHeader';
import AppPivot from './components/AppPivot';
import AppProgress from './components/AppProgress';
import AppRecordDetail from './components/AppRecordDetail';
import AppRepeater from './components/AppRepeater';
import AppSpacer from './components/AppSpacer';
import AppStat from './components/AppStat';
import AppTab from './components/AppTab';
import AppTable from './components/AppTable';
import AppTabs from './components/AppTabs';
import AppText from './components/AppText';
import AppTimeline from './components/AppTimeline';

/**
 * App Studio runtime — component registry: type → renderer + palette metadata.
 *
 * The catalog (types, labels, categories, prop/style defaults) is owned by
 * server/appStudio/componentSpecs.js — that file is AUTHORITATIVE and is also
 * served verbatim via GET /api/studio-apps/catalog. The label/category/
 * defaultProps/defaultStyle values below are mirrored from it so the palette
 * can render offline; keep them in lockstep. defaultProps/defaultStyle are
 * TEMPLATES — deep-clone them when building a node, never mutate them.
 *
 * NO editor imports here: this registry is shared by the editor canvas and
 * the end-user run view.
 */

export const APP_COMPONENT_TYPES = {
    heading: {
        Component: AppHeading, label: 'Heading', icon: Heading1, category: 'Content',
        defaultProps: { text: 'Heading', level: 2, accent: 'none' },
        defaultStyle: { span: 12 },
    },
    text: {
        Component: AppText, label: 'Text', icon: Type, category: 'Content',
        defaultProps: { text: 'Text', muted: false },
        defaultStyle: { span: 12 },
    },
    button: {
        Component: AppButton, label: 'Button', icon: MousePointerClick, category: 'Basics',
        defaultProps: { label: 'Button', variant: 'primary', iconLeft: null, role: 'button', disabledWhen: null },
        defaultStyle: { span: 3 },
    },
    image: {
        Component: AppImage, label: 'Image', icon: Image, category: 'Content',
        defaultProps: { src: null, alt: '', fit: 'cover' },
        defaultStyle: { span: 6, height: 'md' },
    },
    file_preview: {
        Component: AppFilePreview, label: 'File preview', icon: FileText, category: 'Content',
        defaultProps: { source: { kind: 'static', value: null }, emptyText: 'No document selected.', allowDownload: true },
        defaultStyle: { span: 12, height: 'lg' },
    },
    browser_view: {
        Component: AppBrowserView, label: 'Live browser', icon: Globe, category: 'Content',
        defaultProps: { actionId: '', emptyText: null, aspect: '16:10' },
        defaultStyle: { span: 12 },
    },
    divider: {
        Component: AppDivider, label: 'Divider', icon: SeparatorHorizontal, category: 'Layout',
        defaultProps: { orientation: 'horizontal' },
        defaultStyle: { span: 12 },
    },
    spacer: {
        Component: AppSpacer, label: 'Spacer', icon: StretchVertical, category: 'Layout',
        defaultProps: { steps: 2 },
        defaultStyle: { span: 12 },
    },
    callout: {
        Component: AppCallout, label: 'Callout', icon: Megaphone, category: 'Content',
        defaultProps: {
            title: null, text: 'Something worth highlighting.', textFrom: { kind: 'static', value: null },
            tone: 'info', toneFrom: { kind: 'static', value: null },
            meta: null, metaFrom: { kind: 'static', value: null }, collapsible: false,
        },
        defaultStyle: { span: 12 },
    },
    stat: {
        Component: AppStat, label: 'Stat', icon: Gauge, category: 'Data',
        defaultProps: {
            label: 'Metric', value: { kind: 'static', value: '0' }, caption: null, captionSegments: [], icon: null,
            // v2 additive — delta chip + sparkline (null bindings = v1 render).
            delta: { kind: 'static', value: null }, deltaFormat: 'number',
            trend: { kind: 'static', value: null }, positiveIsGood: true,
            look: 'plain',
        },
        defaultStyle: { span: 3 },
    },
    keyValue: {
        Component: AppKeyValue, label: 'Key–value', icon: Rows3, category: 'Data',
        defaultProps: { source: { kind: 'static', value: null }, fields: [], layout: 'rows', columns: 2, emptyText: 'No data yet.' },
        defaultStyle: { span: 6 },
    },
    table: {
        Component: AppTable, label: 'Table', icon: Table, category: 'Data',
        defaultProps: { source: { kind: 'static', value: [] }, columns: [], emptyText: 'Nothing to show yet.', rowLimit: 25, look: 'default' },
        defaultStyle: { span: 12 },
    },
    list: {
        Component: AppList, label: 'List', icon: List, category: 'Data',
        defaultProps: {
            source: { kind: 'static', value: [] }, titleKey: 'title', subtitleKey: null,
            metaKey: null, timestampKey: null, badgeKey: null, badgeToneMap: [], unreadKey: null,
            badgePlacement: 'meta', selectedWhen: null, selectedDetailKey: null,
            groupKey: null, groupOrder: [], groupLabelMap: [],
            icon: null, emptyText: 'Nothing to show yet.', look: 'rows',
            peekSource: null, peekMatchKey: null, peekRowKey: null,
            peekTitleKey: null, peekTextKey: null,
            peekGroupKey: null, peekGroupLabelMap: [], peekCountKey: null,
            peekLimit: 6, peekTitle: null, peekMoreText: null, peekBadge: false,
        },
        defaultStyle: { span: 12 },
    },
    card: {
        Component: AppCard, label: 'Card', icon: SquareStack, category: 'Layout', container: true,
        defaultProps: { title: null, description: null, look: 'default' },
        defaultStyle: { span: 6, padding: 3, gap: 3, background: 'surface' },
    },
    form: {
        Component: AppForm, label: 'Form', icon: ClipboardList, category: 'Input', container: true,
        defaultProps: { name: null, submitLabel: 'Submit', showReset: false, showSubmit: true, resetKey: null },
        defaultStyle: { span: 6, gap: 3, padding: 0 },
    },
    input_text: {
        Component: AppInputText, label: 'Text input', icon: TextCursorInput, category: 'Input', isInput: true,
        defaultProps: { name: 'field', label: 'Text', placeholder: null, required: false, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } },
        defaultStyle: { span: 12 },
    },
    input_textarea: {
        Component: AppInputTextarea, label: 'Text area', icon: AlignLeft, category: 'Input', isInput: true,
        defaultProps: {
            name: 'message', label: 'Message', placeholder: null, required: false, rows: 4,
            valueFrom: { kind: 'static', value: null },
            snippets: { kind: 'static', value: null }, snippetKey: 'shortcut', snippetBody: 'body', snippetLabel: 'title',
        },
        defaultStyle: { span: 12 },
    },
    input_number: {
        Component: AppInputNumber, label: 'Number input', icon: Hash, category: 'Input', isInput: true,
        defaultProps: { name: 'amount', label: 'Amount', min: null, max: null, step: 1, required: false, defaultValue: null, valueFrom: { kind: 'static', value: null } },
        defaultStyle: { span: 6 },
    },
    input_select: {
        Component: AppInputSelect, label: 'Select', icon: ChevronsUpDown, category: 'Input', isInput: true,
        defaultProps: {
            name: 'choice', label: 'Choice', options: [], required: false, defaultValue: null, placeholder: null,
            valueFrom: { kind: 'static', value: null }, optionsFrom: null, optionValueKey: null, optionLabelKey: null,
        },
        defaultStyle: { span: 6 },
    },
    input_checkbox: {
        Component: AppInputCheckbox, label: 'Checkbox', icon: CheckSquare, category: 'Input', isInput: true,
        defaultProps: { name: 'agree', label: 'Yes', defaultChecked: false },
        defaultStyle: { span: 12 },
    },
    input_date: {
        Component: AppInputDate, label: 'Date picker', icon: CalendarDays, category: 'Input', isInput: true,
        defaultProps: { name: 'date', label: 'Date', required: false, defaultValue: null, valueFrom: { kind: 'static', value: null } },
        defaultStyle: { span: 6 },
    },

    // ── v2 data & visualization ──────────────────────────────────────────
    data_grid: {
        Component: AppDataGrid, label: 'Data grid', icon: Table2, category: 'Data',
        defaultProps: {
            source: { kind: 'static', value: [] }, columns: [], pageSize: 25, selectable: 'none',
            searchable: false, rowActions: [], bulkActions: [], toolbarActions: [],
            addRowLabel: null, addRowActionId: null, density: 'comfortable', zebra: false,
            emptyText: 'Nothing to show yet.', look: 'default', clamp: 'off', rowTone: [],
            groupBy: null, groupOrder: [], activeWhen: null,
        },
        defaultStyle: { span: 12 },
    },
    chart: {
        Component: AppChart, label: 'Chart', icon: BarChart3, category: 'Data',
        defaultProps: {
            chartType: 'bar', orientation: 'vertical', source: { kind: 'static', value: [] }, title: null, xKey: 'label',
            xType: 'category', series: [], stacked: false, showLegend: true, showGrid: true,
            valueFormat: 'number', yMin: null, yMax: null,
            referenceLines: [], referenceBands: [], unitLabel: null,
        },
        defaultStyle: { span: 6, height: 'md' },
    },
    pivot: {
        Component: AppPivot, label: 'Pivot table', icon: TableProperties, category: 'Data',
        defaultProps: {
            source: { kind: 'static', value: [] }, rows: [], columns: [], values: [],
            showTotals: true, emptyText: 'Nothing to show yet.',
        },
        defaultStyle: { span: 12 },
    },

    // ── v2 rich inputs ───────────────────────────────────────────────────
    input_file: {
        Component: AppInputFile, label: 'File upload', icon: FileUp, category: 'Input', isInput: true,
        defaultProps: { name: 'file', label: 'File', accept: null, multiple: false, required: false, buttonLabel: null },
        defaultStyle: { span: 6 },
    },
    input_dataset: {
        Component: AppDatasetUpload, label: 'Dataset upload', icon: Dna, category: 'Input', isInput: true,
        defaultProps: { name: 'dataset', label: 'Genome file', required: false, buttonLabel: null, allowExisting: true },
        defaultStyle: { span: 12 },
    },
    input_richtext: {
        Component: AppInputRichtext, label: 'Rich text', icon: TextQuote, category: 'Input', isInput: true,
        defaultProps: { name: 'body', label: 'Content', required: false, defaultValue: null, valueFrom: { kind: 'static', value: null } },
        defaultStyle: { span: 12 },
    },
    input_html: {
        Component: AppInputHtml, label: 'Formatted text (HTML)', icon: Type, category: 'Input', isInput: true,
        defaultProps: {
            name: 'body', label: 'Message', required: false, placeholder: null, defaultValue: null,
            valueFrom: { kind: 'static', value: null }, minRows: 8, allowImages: false,
        },
        defaultStyle: { span: 12 },
    },
    input_datetime: {
        Component: AppInputDatetime, label: 'Date & time', icon: CalendarClock, category: 'Input', isInput: true,
        defaultProps: { name: 'when', label: 'When', required: false, withTime: true, defaultValue: null },
        defaultStyle: { span: 6 },
    },
    input_relation: {
        Component: AppInputRelation, label: 'Relation', icon: Link2, category: 'Input', isInput: true,
        defaultProps: {
            name: 'related', label: 'Related', tableId: null, displayField: null,
            multiple: false, required: false, filter: null,
        },
        defaultStyle: { span: 6 },
    },
    input_person: {
        Component: AppInputPerson, label: 'Person', icon: UserRound, category: 'Input', isInput: true,
        defaultProps: {
            name: 'person', label: 'Person', multiple: false, required: false, allowMe: true,
        },
        defaultStyle: { span: 6 },
    },
    input_multiselect: {
        Component: AppInputMultiselect, label: 'Multi-select', icon: ListChecks, category: 'Input', isInput: true,
        defaultProps: { name: 'choices', label: 'Choices', options: [], required: false, defaultValue: [], valueFrom: { kind: 'static', value: null } },
        defaultStyle: { span: 6 },
    },

    // ── v2 containers ────────────────────────────────────────────────────
    tabs: {
        Component: AppTabs, label: 'Tabs', icon: PanelTop, category: 'Layout', container: true,
        defaultProps: { look: 'underline' },
        defaultStyle: { span: 12, gap: 3, padding: 0 },
    },
    tab: {
        Component: AppTab, label: 'Tab', icon: Square, category: 'Layout', container: true,
        defaultProps: { label: 'Tab', icon: null, badge: null, badgeTone: 'neutral' },
        defaultStyle: { gap: 3, padding: 0 },
    },
    modal: {
        Component: AppModal, label: 'Modal', icon: AppWindow, category: 'Layout', container: true,
        defaultProps: { title: null, size: 'md', placement: 'center', triggerLabel: null },
        defaultStyle: { gap: 3, padding: 4 },
    },
    repeater: {
        Component: AppRepeater, label: 'Repeater', icon: Repeat2, category: 'Data', container: true,
        defaultProps: { source: { kind: 'static', value: [] }, itemActions: [], emptyText: 'Nothing to show yet.' },
        defaultStyle: { span: 12, gap: 3, padding: 0 },
    },

    // ── v2.1 layout & content ────────────────────────────────────────────
    container: {
        Component: AppContainer, label: 'Container', icon: Box, category: 'Layout', container: true,
        defaultProps: { look: 'plain' },
        defaultStyle: { span: 6, gap: 3 },
    },
    pane: {
        Component: AppPane, label: 'Pane', icon: Columns2, category: 'Layout', container: true,
        defaultProps: { direction: 'vertical', scroll: 'none' },
        defaultStyle: { span: 12, gap: 3, height: 'fill' },
    },
    page_header: {
        Component: AppPageHeader, label: 'Page header', icon: LayoutTemplate, category: 'Content', container: true,
        defaultProps: { title: 'Page title', subtitle: null, titleFrom: { kind: 'static', value: null }, subtitleFrom: { kind: 'static', value: null }, icon: null, showDivider: true, look: 'plain' },
        defaultStyle: { span: 12, gap: 3, padding: 0 },
    },
    markdown: {
        Component: AppMarkdown, label: 'Markdown', icon: FileText, category: 'Content',
        defaultProps: { content: '## Heading\n\nWrite **markdown** here.', contentFrom: { kind: 'static', value: null } },
        defaultStyle: { span: 12 },
    },

    // ── v2.1 data display ────────────────────────────────────────────────
    badge_list: {
        Component: AppBadgeList, label: 'Badge list', icon: Tags, category: 'Data',
        defaultProps: {
            source: { kind: 'static', value: [] }, labelKey: 'label', colorKey: null,
            countKey: null, colorMap: [], emptyText: 'Nothing to show yet.', activeWhen: null, look: 'soft',
        },
        defaultStyle: { span: 12 },
    },
    progress: {
        Component: AppProgress, label: 'Progress', icon: Percent, category: 'Data',
        defaultProps: {
            value: { kind: 'static', value: 0 }, max: { kind: 'static', value: 100 },
            format: 'percent', label: null, tone: 'primary', segments: [],
            liveSeconds: 0, liveWhile: null, look: 'bar',
        },
        defaultStyle: { span: 6 },
    },
    stepper: {
        Component: AppStepper, label: 'Stepper', icon: Footprints, category: 'Data',
        defaultProps: {
            value: { kind: 'static', value: null }, steps: [],
            orientation: 'horizontal', tone: 'primary', showLabels: true,
        },
        defaultStyle: { span: 12 },
    },
    file_gallery: {
        Component: AppFileGallery, label: 'File gallery', icon: Images, category: 'Data',
        defaultProps: {
            source: { kind: 'static', value: [] }, fileKey: 'file', titleKey: 'filename',
            subtitleKey: null, sizeKey: null, groupKey: null, columns: 3, rowLimit: 24,
            emptyText: 'No files yet.', liveSeconds: 0, liveWhile: null,
        },
        defaultStyle: { span: 12 },
    },
    connector_status: {
        Component: AppConnectorStatus, label: 'Connection status', icon: PlugZap, category: 'Data',
        defaultProps: { connectorId: '', title: null, showSync: true },
        defaultStyle: { span: 12 },
    },
    timeline: {
        Component: AppTimeline, label: 'Timeline', icon: History, category: 'Data',
        defaultProps: {
            source: { kind: 'static', value: [] }, titleKey: 'title', dateKey: 'created_at',
            descriptionKey: null, metaKey: null, icon: null, rowLimit: 25,
            emptyText: 'Nothing to show yet.',
        },
        defaultStyle: { span: 12 },
    },
    message_thread: {
        Component: AppMessageThread, label: 'Message thread', icon: MessagesSquare, category: 'Data',
        defaultProps: {
            source: { kind: 'static', value: [] },
            bodyField: 'body', htmlField: null, authorField: 'author', timestampField: 'created_at',
            sideField: null, sideMap: [],
            attachmentsField: null, attachmentLabelKey: 'filename',
            attachmentsSource: null, attachmentMatchKey: null,
            citationsField: null, citationLabelKey: 'title',
            emailField: null, toField: null, subjectField: null, showAvatar: false, centerMeta: 'hidden',
            eventsSource: null, eventsBodyField: 'detail', eventsTimestampField: 'at',
            rowLimit: 100, emptyText: 'No messages yet.',
        },
        defaultStyle: { span: 12, height: 'fill' },
    },
    record_detail: {
        Component: AppRecordDetail, label: 'Record detail', icon: IdCard, category: 'Data',
        defaultProps: {
            source: { kind: 'static', value: null }, fields: [], columns: 2, emptyText: 'No record selected.',
            layout: 'stacked',
        },
        defaultStyle: { span: 12 },
    },

    // ── v2.1 interactive data ────────────────────────────────────────────
    filter_bar: {
        Component: AppFilterBar, label: 'Filter bar', icon: ListFilter, category: 'Data',
        defaultProps: { fields: [] },
        defaultStyle: { span: 12 },
    },
    kanban: {
        Component: AppKanban, label: 'Kanban', icon: SquareKanban, category: 'Data',
        defaultProps: {
            source: { kind: 'static', value: [] }, groupByField: 'status', columns: [],
            columnsSource: null, swimlaneField: null, swimlanes: [], swimlanesSource: null,
            titleKey: 'title', subtitleKey: null, badgeKey: null, badgeToneMap: [],
            cardFields: [], rankKey: null, colorKey: null, cardColorMap: [],
            collapsible: false, emptyText: null, allowDrag: true, cardLook: 'default',
        },
        defaultStyle: { span: 12 },
    },
    calendar: {
        Component: AppCalendar, label: 'Calendar', icon: Calendar, category: 'Data',
        defaultProps: {
            source: { kind: 'static', value: [] }, dateKey: 'date', endDateKey: null,
            titleKey: 'title', colorKey: null, view: 'month', emptyText: 'No events yet.',
        },
        defaultStyle: { span: 12 },
    },
    approval_list: {
        Component: AppApprovalList, label: 'Approvals', icon: ShieldCheck, category: 'Data',
        defaultProps: {
            scope: 'mine', show: 'waiting', limit: 10,
            emptyText: 'No approvals right now.', showDetails: true,
        },
        defaultStyle: { span: 12 },
    },
    ai_chat: {
        Component: AppAiChat, label: 'AI chat', icon: Sparkles, category: 'AI',
        defaultProps: {
            systemPrompt: '', modelTier: 'auto', knowledgeBaseIds: [], greeting: '',
            placeholder: 'Ask a question…', starters: [], mode: 'chat',
        },
        defaultStyle: { span: 12 },
    },
};

/** Palette section order (mirrors the categories used in componentSpecs.js). */
export const PALETTE_CATEGORIES = ['Basics', 'Content', 'Layout', 'Data', 'Input', 'AI'];

/**
 * The handful of components a first-time builder reaches for, in the order
 * they usually get placed. A VIEW over the catalog, never a re-homing: each
 * type keeps the `category` the server spec gives it (catalogLockstep.test.js
 * enforces that), so every category tab and the palette search are unaffected.
 */
export const PALETTE_STARTERS = ['heading', 'text', 'button', 'image', 'card', 'table', 'form', 'chart'];

export function getComponentEntry(type) {
    return APP_COMPONENT_TYPES[type] || null;
}

export default APP_COMPONENT_TYPES;

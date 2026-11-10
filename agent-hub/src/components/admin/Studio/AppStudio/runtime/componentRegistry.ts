import {
    AlignLeft,
    AppWindow,
    BarChart3,
    Box,
    Calendar,
    CalendarDays,
    CheckSquare,
    ChevronsUpDown,
    ClipboardList,
    FileDiff,
    FileText,
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
    List,
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
    Type,
} from 'lucide-react';
import type { NodeStyle } from '../inspector/appDefinition';
import { types as catalogTypes } from './catalogSnapshot.generated.json';
import { COMPONENT_EXTENSION_MODULES, collectComponentExtensions } from './componentExtensions';
import type { ComponentRenderer, ComponentExtension, RegistryEntry } from './componentRegistry.types';
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
import AppPdfCompare from './components/AppPdfCompare';
import { DOCUMENT_COMPONENT_TYPES } from './documentComponentTypes';
import { RICH_INPUT_COMPONENT_TYPES } from './richInputComponentTypes';
import AppStepper from './components/AppStepper';
import AppImage from './components/AppImage';
import AppInputCheckbox from './components/AppInputCheckbox';
import AppInputDate from './components/AppInputDate';
import AppBrowserView from './components/AppBrowserView';
import AppInputNumber from './components/AppInputNumber';
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
 * served verbatim via GET /api/studio-apps/catalog. Only the renderer and the
 * icon are kept here; label, category, container, isInput, defaultProps and
 * defaultStyle come from catalogSnapshot.generated.json (written from the spec
 * by scripts/gen-app-catalog.mjs), so the palette renders offline without a
 * hand mirror. defaultProps/defaultStyle are TEMPLATES — deep-clone them when
 * building a node, never mutate them.
 *
 * NO editor imports here: this registry is shared by the editor canvas and
 * the end-user run view.
 */

/** A type's catalog slice in the snapshot. */
interface CatalogType {
    label: string;
    category: string;
    container?: boolean;
    isInput?: boolean;
    since?: number;
    defaultProps: Record<string, unknown>;
    defaultStyle: NodeStyle;
}

const CATALOG: Record<string, CatalogType | undefined> = catalogTypes;

/** Renderers in palette order. A type the snapshot lacks is left out (catalogLockstep.test.js fails on it). */
const RENDERERS: Record<string, ComponentRenderer> = {
    heading: { Component: AppHeading, icon: Heading1 },
    text: { Component: AppText, icon: Type },
    button: { Component: AppButton, icon: MousePointerClick },
    image: { Component: AppImage, icon: Image },
    file_preview: { Component: AppFilePreview, icon: FileText },
    pdf_compare: { Component: AppPdfCompare, icon: FileDiff },
    browser_view: { Component: AppBrowserView, icon: Globe },
    divider: { Component: AppDivider, icon: SeparatorHorizontal },
    spacer: { Component: AppSpacer, icon: StretchVertical },
    callout: { Component: AppCallout, icon: Megaphone },
    stat: { Component: AppStat, icon: Gauge },
    keyValue: { Component: AppKeyValue, icon: Rows3 },
    table: { Component: AppTable, icon: Table },
    list: { Component: AppList, icon: List },
    card: { Component: AppCard, icon: SquareStack },
    form: { Component: AppForm, icon: ClipboardList },
    input_text: { Component: AppInputText, icon: TextCursorInput },
    input_textarea: { Component: AppInputTextarea, icon: AlignLeft },
    input_number: { Component: AppInputNumber, icon: Hash },
    input_select: { Component: AppInputSelect, icon: ChevronsUpDown },
    input_checkbox: { Component: AppInputCheckbox, icon: CheckSquare },
    input_date: { Component: AppInputDate, icon: CalendarDays },

    // ── v2 data & visualization ──────────────────────────────────────────
    data_grid: { Component: AppDataGrid, icon: Table2 },
    chart: { Component: AppChart, icon: BarChart3 },
    pivot: { Component: AppPivot, icon: TableProperties },

    // ── v2 rich inputs (./richInputComponentTypes) ─────────────────────
    ...RICH_INPUT_COMPONENT_TYPES,

    // ── v2 containers ────────────────────────────────────────────────────
    tabs: { Component: AppTabs, icon: PanelTop },
    tab: { Component: AppTab, icon: Square },
    modal: { Component: AppModal, icon: AppWindow },
    repeater: { Component: AppRepeater, icon: Repeat2 },

    // ── v2.1 layout & content ────────────────────────────────────────────
    container: { Component: AppContainer, icon: Box },
    pane: { Component: AppPane, icon: Columns2 },
    page_header: { Component: AppPageHeader, icon: LayoutTemplate },
    markdown: { Component: AppMarkdown, icon: FileText },

    // ── v2.1 data display ────────────────────────────────────────────────
    badge_list: { Component: AppBadgeList, icon: Tags },
    progress: { Component: AppProgress, icon: Percent },
    stepper: { Component: AppStepper, icon: Footprints },
    file_gallery: { Component: AppFileGallery, icon: Images },
    connector_status: { Component: AppConnectorStatus, icon: PlugZap },
    timeline: { Component: AppTimeline, icon: History },
    message_thread: { Component: AppMessageThread, icon: MessagesSquare },
    record_detail: { Component: AppRecordDetail, icon: IdCard },

    // ── v2.1 interactive data ────────────────────────────────────────────
    filter_bar: { Component: AppFilterBar, icon: ListFilter },
    kanban: { Component: AppKanban, icon: SquareKanban },
    calendar: { Component: AppCalendar, icon: Calendar },
    approval_list: { Component: AppApprovalList, icon: ShieldCheck },
    ai_chat: { Component: AppAiChat, icon: Sparkles },

    // Studio documents: a read-only view, a picker, what changed.
    ...DOCUMENT_COMPONENT_TYPES,
};

/** Types added after the base (components/registry/<type>.ts), after the base in file-name order. */
const EXTENSIONS: Record<string, ComponentExtension> = collectComponentExtensions(
    COMPONENT_EXTENSION_MODULES, CATALOG, Object.keys(RENDERERS),
);

function registryEntry(renderer: ComponentRenderer | ComponentExtension, spec: CatalogType): RegistryEntry {
    return {
        Component: renderer.Component,
        label: spec.label,
        icon: renderer.icon,
        category: spec.category,
        ...(spec.container ? { container: true } : {}),
        ...(spec.isInput ? { isInput: true } : {}),
        defaultProps: spec.defaultProps,
        defaultStyle: spec.defaultStyle,
        ...('sample' in renderer ? { sample: renderer.sample } : {}),
    };
}

export const APP_COMPONENT_TYPES: Record<string, RegistryEntry | undefined> = Object.fromEntries(
    Object.entries({ ...RENDERERS, ...EXTENSIONS }).flatMap(([type, renderer]) => {
        const spec = CATALOG[type];
        return spec ? [[type, registryEntry(renderer, spec)]] : [];
    }),
);

/** Palette section order (mirrors the categories used in componentSpecs.js). */
export const PALETTE_CATEGORIES: string[] = ['Basics', 'Content', 'Layout', 'Data', 'Input', 'AI'];

/**
 * The handful of components a first-time builder reaches for, in the order
 * they usually get placed. A VIEW over the catalog, never a re-homing: each
 * type keeps the `category` the server spec gives it (catalogLockstep.test.js
 * enforces that), so every category tab and the palette search are unaffected.
 */
export const PALETTE_STARTERS: string[] = ['heading', 'text', 'button', 'image', 'card', 'table', 'form', 'chart'];

export function getComponentEntry(type?: string | null): RegistryEntry | null {
    return (type == null ? undefined : APP_COMPONENT_TYPES[type]) || null;
}

export default APP_COMPONENT_TYPES;

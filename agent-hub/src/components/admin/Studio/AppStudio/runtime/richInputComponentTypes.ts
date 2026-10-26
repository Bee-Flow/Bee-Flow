import { CalendarClock, Dna, FileUp, Link2, ListChecks, TextQuote, Type, UserRound } from 'lucide-react';
import AppDatasetUpload from './components/AppDatasetUpload';
import AppInputDatetime from './components/AppInputDatetime';
import AppInputFile from './components/AppInputFile';
import AppInputHtml from './components/AppInputHtml';
import AppInputMultiselect from './components/AppInputMultiselect';
import AppInputPerson from './components/AppInputPerson';
import AppInputRelation from './components/AppInputRelation';
import AppInputRichtext from './components/AppInputRichtext';
import type { RegistryEntry } from './componentRegistry.types';

/**
 * The registry entries of the v2 rich inputs (spec: server/appStudio/componentSpecs/richInputSpecs.js),
 * spread into APP_COMPONENT_TYPES at their place in the palette. Split out of componentRegistry.ts
 * by family; catalogLockstep.test.js pins every entry against the spec.
 */
export const RICH_INPUT_COMPONENT_TYPES: Record<string, RegistryEntry> = {
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
};

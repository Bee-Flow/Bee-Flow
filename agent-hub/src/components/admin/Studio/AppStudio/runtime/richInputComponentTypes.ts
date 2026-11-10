import { CalendarClock, Dna, FileUp, Link2, ListChecks, TextQuote, Type, UserRound } from 'lucide-react';
import AppDatasetUpload from './components/AppDatasetUpload';
import AppInputDatetime from './components/AppInputDatetime';
import AppInputFile from './components/AppInputFile';
import AppInputHtml from './components/AppInputHtml';
import AppInputMultiselect from './components/AppInputMultiselect';
import AppInputPerson from './components/AppInputPerson';
import AppInputRelation from './components/AppInputRelation';
import AppInputRichtext from './components/AppInputRichtext';
import type { ComponentRenderer } from './componentRegistry.types';

/**
 * The renderers and icons of the v2 rich inputs (spec: server/appStudio/componentSpecs/richInputSpecs.js),
 * spread into APP_COMPONENT_TYPES at their place in the palette. Split out of componentRegistry.ts
 * by family; their palette data comes from the catalog snapshot.
 */
export const RICH_INPUT_COMPONENT_TYPES: Record<string, ComponentRenderer> = {
    input_file: { Component: AppInputFile, icon: FileUp },
    input_dataset: { Component: AppDatasetUpload, icon: Dna },
    input_richtext: { Component: AppInputRichtext, icon: TextQuote },
    input_html: { Component: AppInputHtml, icon: Type },
    input_datetime: { Component: AppInputDatetime, icon: CalendarClock },
    input_relation: { Component: AppInputRelation, icon: Link2 },
    input_person: { Component: AppInputPerson, icon: UserRound },
    input_multiselect: { Component: AppInputMultiselect, icon: ListChecks },
};

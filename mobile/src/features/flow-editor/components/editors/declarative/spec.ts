/**
 * The declarative editor format: a step type's settings as DATA — sections of
 * fields, each field a kind, the draft key it edits, its words and when it
 * shows — rendered by DeclarativeEditor and saved through formState's
 * `buildPatch`, exactly as the web's hand-written editors save
 * (agent-hub `Builder/flow/settings/*`). One spec per simpler step type
 * (specs/); the types that need a bespoke editor register one instead.
 *
 * Words are `Msg` pairs — `[key, English]` — resolved through t() at render,
 * so a spec is plain data and specs.lockstep.test.ts can check every key it
 * borrows from the web against both dictionaries.
 */

import type { FlowNode, JsonSchema } from '@/features/flow-editor/bindings';
import type { FormDraft, StepPatch } from '@/features/flow-editor/formState';

import type { StepEditorContext } from '../types';

/** A translatable word: the key, its English, and any `{placeholders}` it fills. */
export type Msg = readonly [key: string, english: string, params?: Readonly<Record<string, string | number>>];

export const msg = (key: string, english: string, params?: Readonly<Record<string, string | number>>): Msg =>
    params ? [key, english, params] : [key, english];

export interface SpecContext extends StepEditorContext {
    step: FlowNode;
}

/** One declared input of a flowlet or a published Step. */
export interface ContractParam {
    name: string;
    type?: string;
    required?: boolean;
    description?: string;
    label?: string;
}

/** The translator a `display` field words its sentence with. */
export type SpecTranslate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

export type When = (draft: FormDraft, ctx: SpecContext) => boolean;

/** Words that depend on the draft ("What to scan" vs "What to restore"). */
export type Words = Msg | ((draft: FormDraft, ctx: SpecContext) => Msg | null);

export interface OptionSpec {
    value: string;
    /** A Msg for fixed words, a plain string for data (a knowledge base's name). */
    label: Msg | string;
    blurb?: Msg | string;
    disabled?: boolean;
    /** Chips only: always on. */
    fixed?: boolean;
}

export type Options = readonly OptionSpec[] | ((draft: FormDraft, ctx: SpecContext) => readonly OptionSpec[]);

interface FieldBase {
    /** Unique within the spec; defaults to `key`. */
    id?: string;
    /** The draft key the field edits — a dotted path for a nested value (`privacy.mode`). */
    key?: string;
    /** Read the value some other way than `key` (a view over several keys). */
    read?: (draft: FormDraft, ctx: SpecContext) => unknown;
    /** Write it some other way: the draft keys to change. */
    write?: (value: unknown, draft: FormDraft, ctx: SpecContext) => FormDraft;
    label?: Words;
    hint?: Words;
    /** An example for the empty field, shown as-is (`{{steps.ai_1.output.text}}`). */
    example?: string;
    /** A sentence for the empty field ("Pick a knowledge base…"). */
    prompt?: Msg;
    required?: boolean;
    visibleWhen?: When;
    /**
     * A change that costs something (a connection, a setting) is asked about
     * first: the question, and the word on the button that goes ahead.
     */
    confirm?: (value: unknown, draft: FormDraft, ctx: SpecContext) => { message: Msg; action: Msg } | null;
    /** Text fields: values to offer under the field (the keys of a list's items). */
    suggest?: (draft: FormDraft, ctx: SpecContext) => readonly string[];
}

export type FieldSpec =
    | (FieldBase & { kind: 'template'; multiline?: boolean })
    | (FieldBase & { kind: 'binding' })
    | (FieldBase & { kind: 'path'; list?: boolean })
    | (FieldBase & { kind: 'text' })
    | (FieldBase & { kind: 'multiline'; maxLength?: number })
    | (FieldBase & { kind: 'number'; min?: number; max?: number; integer?: boolean; allowBlank?: boolean; suffix?: Msg })
    | (FieldBase & { kind: 'toggle'; description?: Words })
    | (FieldBase & { kind: 'select' | 'segmented' | 'choice' | 'chips'; options: Options })
    | (FieldBase & { kind: 'duration' })
    | (FieldBase & { kind: 'rows'; keepEmpty?: boolean })
    | (FieldBase & { kind: 'list' })
    /** Template strings under fixed names (a document's placeholder values). */
    | (FieldBase & { kind: 'templateMap' })
    /** A tool's inputs from its catalog input schema (integration_action). */
    | (FieldBase & { kind: 'schema'; schema: (draft: FormDraft, ctx: SpecContext) => JsonSchema | null })
    /** A flowlet's or a Step's declared inputs (call_layer / call_block), one binding each. */
    | (FieldBase & { kind: 'contract'; contract: (ctx: SpecContext) => readonly ContractParam[] })
    /** Data extraction's field rows. */
    | (FieldBase & { kind: 'extraction' })
    /** "Run once per item", "Try again if this step fails", "Ask this app only once per run". */
    | (FieldBase & { kind: 'forEach' | 'retry' | 'askOnce' })
    /** A standing sentence: `hint` is the text. */
    | (FieldBase & { kind: 'note'; tone?: 'info' | 'warning' })
    /** A read-only value; `t` lets a sentence built from several keys be worded at render. */
    | (FieldBase & { kind: 'display'; show: (draft: FormDraft, ctx: SpecContext, t: SpecTranslate) => string });

export type FieldKind = FieldSpec['kind'];

export interface SectionSpec {
    /** One of the type's nodeDefs `sectionKeys`. */
    key: string;
    title: Msg;
    /** A sentence under the band, before the fields. */
    intro?: Msg;
    fields: readonly FieldSpec[];
    defaultOpen?: boolean | When;
    /** Already configured: never hidden in Simple, and badged there. */
    hasContent?: When;
}

export interface EditorSpec {
    type: string;
    sections: readonly SectionSpec[];
    /** Draft keys formState does not carry for this type (a note's text). */
    extract?: (step: FlowNode) => FormDraft;
    /** …and their half of the patch, written in place. */
    patch?: (patch: StepPatch, step: FlowNode, draft: FormDraft) => void;
}

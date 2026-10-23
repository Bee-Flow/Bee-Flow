import type { OmittedFact, QuestionRow, SourcesRow, HeldActionRow, AnswerRow, RuleRow, TraceRow as TraceRowData, TraceMessage } from './answerTrace.types';
import type { TranslateParams } from '../../hooks/useTranslation';

/** One muted line per reason: which facts are missing, and why. */
export interface OmittedNoteProps {
    omitted: OmittedFact[];
    tt: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

/** The facts of one recorded line. */
export interface RowFactsProps {
    row: QuestionRow | SourcesRow | HeldActionRow | AnswerRow;
    tt: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

/**
  * The judged line. Own shape, own heading, own glyph — the same four carriers
  * as the chip row, so the difference survives both a greyscale screenshot and a
  * screen reader.
 */
export interface JudgedFactsProps {
    row: RuleRow;
    tt: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface TraceRowProps {
    row: TraceRowData;
    n: number;
    tt: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface AnswerTracePanelProps {
    msg?: TraceMessage | null;
    toolDecisions?: {};
    t?: ((key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) | null;
    className?: string;
}

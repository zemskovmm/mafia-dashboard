import type { Locale } from "../../i18n/I18nProvider.js";

export interface RulesChapterText {
  readonly title: readonly [string, string];
  readonly name: string;
  readonly tag: string;
  readonly plate: string;
  readonly note: string;
  readonly lede: string;
  readonly intro?: string;
  readonly outro?: string;
  readonly rules?: readonly (readonly [string, string])[];
  readonly paragraphs?: readonly string[];
  readonly margin: string;
  readonly signature?: string;
}

export interface RulesChapter {
  readonly id: string;
  readonly art: "club" | "night" | "table" | "cards";
  readonly source: string;
  readonly reference?: string;
  readonly en: RulesChapterText;
  readonly ru: RulesChapterText;
}

export interface RulesSketchbookProps {
  readonly open: boolean;
  /** The host keeps optional presentation flat until shared assets are ready. */
  readonly enhancedReady?: boolean;
  readonly targetId?: string;
  readonly locale: Locale;
  readonly chapters: readonly RulesChapter[];
  readonly onClose: () => void;
}

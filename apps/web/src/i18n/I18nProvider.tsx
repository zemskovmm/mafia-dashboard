import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { englishMessages, type MessageKey } from "./messages/en.js";
import { russianMessages } from "./messages/ru.js";
import type { Locale, Message, MessageValues } from "./messages/types.js";

export type { Locale, Message, MessageKey, MessageValues };

export interface I18nValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: (key: MessageKey, values?: MessageValues) => string;
  readonly formatDate: (value: Date | string) => string;
  readonly formatDateTime: (value: Date | string) => string;
  readonly formatTime: (value: Date | string) => string;
  readonly formatList: (values: readonly string[]) => string;
}

export type FeatureMessages<Key extends string> = Readonly<
  Record<Locale, Readonly<Record<Key, Message>>>
>;

export type FeatureI18n<Key extends string> = Omit<I18nValue, "t"> & {
  readonly t: (key: Key, values?: MessageValues) => string;
};

const catalogs: Record<Locale, Record<MessageKey, Message>> = {
  en: englishMessages,
  ru: russianMessages,
};

const interpolate = (template: string, values: MessageValues): string =>
  template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, name: string) =>
    values[name] === undefined ? token : String(values[name]),
  );

const translator =
  <Key extends string>(locale: Locale, messages: FeatureMessages<Key>): FeatureI18n<Key>["t"] =>
  (key, values = {}) => {
    const message = messages[locale][key];
    const template =
      typeof message === "string"
        ? message
        : (message[new Intl.PluralRules(locale).select(Number(values.count ?? 0))] ??
          message.other);
    return interpolate(template, values);
  };

export const resolveBrowserLocale = (languages?: readonly string[]): Locale => {
  const candidates =
    languages ??
    (typeof navigator === "undefined"
      ? []
      : navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language]);
  return candidates[0]?.toLowerCase().startsWith("ru") === true ? "ru" : "en";
};

export const createI18n = (
  locale: Locale,
  setLocale: (locale: Locale) => void = () => undefined,
): I18nValue => {
  const t = (key: MessageKey, values: MessageValues = {}): string => {
    const message = catalogs[locale][key];
    const template =
      typeof message === "string"
        ? message
        : (message[new Intl.PluralRules(locale).select(Number(values.count ?? 0))] ??
          message.other);
    return interpolate(template, values);
  };
  const date = (value: Date | string) => (value instanceof Date ? value : new Date(value));
  return {
    locale,
    setLocale,
    t,
    formatDate: (value) => new Intl.DateTimeFormat(locale).format(date(value)),
    formatDateTime: (value) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
        date(value),
      ),
    formatTime: (value) =>
      new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(date(value)),
    formatList: (values) => new Intl.ListFormat(locale, { type: "conjunction" }).format(values),
  };
};

const I18nContext = createContext<I18nValue>(createI18n("en"));

export const I18nProvider = ({
  children,
  locale: controlledLocale,
  onLocaleChange,
  manageDocumentLanguage = true,
}: {
  readonly children: ReactNode;
  readonly locale?: Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
  readonly manageDocumentLanguage?: boolean;
}) => {
  const [uncontrolledLocale, setUncontrolledLocale] = useState(resolveBrowserLocale);
  const locale = controlledLocale ?? uncontrolledLocale;
  const setLocale = useCallback(
    (next: Locale) => {
      if (controlledLocale === undefined) setUncontrolledLocale(next);
      onLocaleChange?.(next);
    },
    [controlledLocale, onLocaleChange],
  );
  const value = useMemo(() => createI18n(locale, setLocale), [locale, setLocale]);

  useEffect(() => {
    if (!manageDocumentLanguage) return;
    const previous = document.documentElement.lang;
    document.documentElement.lang = locale;
    return () => {
      document.documentElement.lang = previous;
    };
  }, [locale, manageDocumentLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = (): I18nValue => useContext(I18nContext);

export const useMessages = <Key extends string>(
  messages: FeatureMessages<Key>,
): FeatureI18n<Key> => {
  const i18n = useI18n();
  return useMemo(() => ({ ...i18n, t: translator(i18n.locale, messages) }), [i18n, messages]);
};

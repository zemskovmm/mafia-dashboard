import { useI18n, type Locale } from "./I18nProvider.js";

export const LanguageSelector = ({
  className = "",
  value,
  onChange,
  disabled = false,
}: {
  readonly className?: string;
  readonly value?: Locale;
  readonly onChange?: (locale: Locale) => void;
  readonly disabled?: boolean;
}) => {
  const { locale, setLocale, t } = useI18n();
  const selected = value ?? locale;
  return (
    <label className={`language-selector ${className}`.trim()}>
      <span>{t("Language")}</span>
      <select
        aria-label={t("Language")}
        value={selected}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value as Locale;
          onChange?.(next);
          if (value === undefined) setLocale(next);
        }}
      >
        <option value="en">{t("English")}</option>
        <option value="ru">{t("Russian")}</option>
      </select>
    </label>
  );
};

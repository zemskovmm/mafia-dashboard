export interface DeveloperSettingToggleProps {
  readonly title: string;
  readonly description?: string;
  readonly ariaLabel: string;
  readonly ariaDescribedBy?: string;
  readonly pressed: boolean;
  readonly stateLabel: string;
  readonly stateBadge?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

export const DeveloperSettingToggle = ({
  title,
  description,
  ariaLabel,
  ariaDescribedBy,
  pressed,
  stateLabel,
  stateBadge = true,
  disabled,
  onClick,
}: DeveloperSettingToggleProps) => (
  <button
    type="button"
    className="dev-setting-toggle"
    aria-label={ariaLabel}
    aria-describedby={ariaDescribedBy}
    aria-pressed={pressed}
    disabled={disabled}
    onClick={onClick}
  >
    {description === undefined ? (
      <strong>{title}</strong>
    ) : (
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    )}
    <span className={stateBadge ? "dev-setting-state" : undefined}>{stateLabel}</span>
  </button>
);

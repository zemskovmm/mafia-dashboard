import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  EyeOff,
  FlaskConical,
  House,
  LogOut,
  Music2,
  Palette,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useMessages } from "../../i18n/I18nProvider.js";
import { menusMessages } from "../../i18n/messages/menus.js";
import { shellMessages } from "../../i18n/messages/shell.js";
import "./WorkspaceMenus.css";
import type { Club } from "../../api/client.js";

export interface ManageMenuProps {
  readonly club: Club;
  readonly onClose: () => void;
  readonly onNewGame: () => void;
  readonly onPlayers: () => void;
  readonly onTimeline: () => void;
  readonly onStatistics: () => void;
  readonly onEditClub: () => void;
  readonly onDeleteClub: () => void;
  readonly onExit: () => void;
  readonly onOpenRules: () => void;
  readonly onMusicOpen: () => void;
  readonly onBestMoveChange: (enabled: boolean) => Promise<void>;
  readonly clubSaving: boolean;
  readonly activeGames: ReactNode;
  readonly tournament: ReactNode;
  readonly appearance: ReactNode;
  readonly help: ReactNode;
  readonly language: ReactNode;
  readonly music: ReactNode;
}

export interface DeveloperMenuProps {
  readonly visualEffects: ReactNode;
  readonly gameTesting: ReactNode;
  readonly diagnostics: ReactNode;
  readonly onClose: () => void;
  readonly onHide: () => void;
}

const MenuRow = ({
  title,
  description,
  icon: Icon,
  onClick,
  disabled = false,
  danger = false,
  ariaLabel,
}: {
  readonly title: string;
  readonly description?: string;
  readonly icon: LucideIcon;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly ariaLabel?: string;
}) => (
  <button
    type="button"
    className={`workspace-menu-row${danger ? " danger-action" : ""}`}
    aria-label={ariaLabel ?? title}
    disabled={disabled}
    onClick={onClick}
  >
    <span className="workspace-menu-row-icon">
      <Icon aria-hidden="true" />
    </span>
    <span className="workspace-menu-row-text">
      <strong>{title}</strong>
      {description ? <small>{description}</small> : null}
    </span>
    <ChevronRight className="workspace-menu-chevron" aria-hidden="true" />
  </button>
);

const MenuGroup = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) => (
  <section className="workspace-menu-group" aria-label={title}>
    <h3 className="workspace-menu-group-title">{title}</h3>
    {children}
  </section>
);

const Drawer = ({
  kind,
  label,
  title,
  subtitle,
  onBack,
  onClose,
  children,
}: {
  readonly kind: "manage" | "dev";
  readonly label: string;
  readonly title: string;
  readonly subtitle: string;
  readonly onBack?: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) => {
  const { t } = useMessages(menusMessages);
  return (
    <aside
      id={`${kind}-menu-drawer`}
      className={`app-drawer ${kind}-menu-drawer workspace-menu-drawer`}
      role="dialog"
      aria-label={label}
    >
      <header className="workspace-menu-header">
        {onBack ? (
          <button
            type="button"
            className="workspace-menu-icon-button"
            aria-label={t("back")}
            onClick={onBack}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
        ) : null}
        <div className="workspace-menu-heading">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <button
          type="button"
          className="workspace-menu-icon-button workspace-menu-close"
          aria-label={t("closeMenu")}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="workspace-menu-body">{children}</div>
    </aside>
  );
};

const BestMoveForm = ({
  value,
  clubSaving,
  onSave,
  onCancel,
}: {
  readonly value: boolean;
  readonly clubSaving: boolean;
  readonly onSave: (enabled: boolean) => Promise<void>;
  readonly onCancel: () => void;
}) => {
  const { t } = useMessages(menusMessages);
  const shell = useMessages(shellMessages);
  const [saved, setSaved] = useState(value);
  const [draft, setDraft] = useState(value);
  const [status, setStatus] = useState<"idle" | "saving" | "error" | "saved">("idle");
  const saving = useRef(false);
  const mounted = useRef(false);
  const descriptionId = useId();
  const scopeId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setSaved(value);
    setDraft(value);
  }, [value]);
  const changed = draft !== saved;
  const busy = status === "saving" || clubSaving;
  const save = async () => {
    // The ref closes the same-event gap before React paints the disabled button.
    if (saving.current || clubSaving || !changed) return;
    saving.current = true;
    const submitted = draft;
    setStatus("saving");
    try {
      await onSave(submitted);
      if (!mounted.current) return;
      setSaved(submitted);
      setStatus("saved");
    } catch {
      if (mounted.current) setStatus("error");
    } finally {
      saving.current = false;
    }
  };
  return (
    <form
      className="workspace-menu-best-move"
      aria-label={t("gameOptions")}
      aria-busy={status === "saving"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="workspace-menu-setting-box">
        <div className="workspace-menu-setting-label">
          <div>
            <h3>{t("bestMove")}</h3>
            <p className="workspace-menu-setting-state">
              {shell.t(draft ? "settingOn" : "settingOff")}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            className="workspace-menu-switch"
            aria-label={shell.t("bestMoveEnabled")}
            aria-checked={draft}
            aria-describedby={`${descriptionId} ${scopeId}`}
            disabled={busy}
            onClick={() => {
              setDraft(!draft);
              setStatus("idle");
            }}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <p id={descriptionId}>{t("bestMoveDescription")}</p>
      </div>
      <p id={scopeId} className="workspace-menu-setting-scope">
        {t("bestMoveScope")}
      </p>
      {status === "error" ? (
        <p className="workspace-menu-error" role="alert">
          {t("bestMoveSaveFailed")}
        </p>
      ) : null}
      <div className="workspace-menu-form-actions">
        <button type="button" onClick={onCancel}>
          {shell.t("cancel")}
        </button>
        <button type="submit" className="workspace-menu-primary" disabled={busy || !changed}>
          {t(
            status === "saving"
              ? "savingChanges"
              : status === "error"
                ? "retrySave"
                : "saveChanges",
          )}
        </button>
      </div>
      <p className="workspace-menu-save-status" role="status">
        {t(
          status === "saving"
            ? "savingChanges"
            : clubSaving
              ? "clubSavePending"
              : status === "saved"
                ? "bestMoveSaved"
                : changed
                  ? "unsavedChanges"
                  : "noChanges",
        )}
      </p>
    </form>
  );
};

type ManagePage = "root" | "games" | "club" | "preferences" | "appearance" | "help" | "music";

const ManageMenuContent = (props: ManageMenuProps) => {
  const { t } = useMessages(menusMessages);
  const shell = useMessages(shellMessages);
  const [page, setPage] = useState<ManagePage>("root");
  const [clubSection, setClubSection] = useState<"options" | "details">("options");
  const manager = props.club.role === "manager";
  // A lost manager permission must remove the current privileged page as well as its entry.
  const currentPage = !manager && (page === "club" || page === "music") ? "root" : page;
  const parent: ManagePage = ["appearance", "help", "music"].includes(currentPage)
    ? "preferences"
    : "root";
  const title = {
    root: t("menu"),
    games: t("gameRecords"),
    club: t("clubSettings"),
    preferences: t("preferences"),
    appearance: t("appearance"),
    help: t("help"),
    music: shell.t("musicPlayerSetup"),
  }[currentPage];
  const subtitle = {
    root: props.club.name,
    games: t("gameRecordsSubtitle"),
    club: t("clubSettingsSubtitle"),
    preferences: t("preferencesSubtitle"),
    appearance: t("appearanceSubtitle"),
    help: t("helpSubtitle"),
    music: t("musicDescription"),
  }[currentPage];
  const close = () => {
    setPage("root");
    setClubSection("options");
    props.onClose();
  };

  return (
    <Drawer
      kind="manage"
      label={shell.t("manage")}
      title={title}
      subtitle={subtitle}
      onClose={close}
      onBack={currentPage === "root" ? undefined : () => setPage(parent)}
    >
      {currentPage === "root" ? (
        <>
          <button type="button" className="workspace-menu-primary" onClick={props.onNewGame}>
            <Plus aria-hidden="true" />
            {shell.t("startNewGame")}
          </button>
          <MenuGroup title={t("workspace")}>
            <MenuRow
              title={t("gameRecords")}
              description={t(manager ? "gameRecordsDescription" : "memberRecordsDescription")}
              icon={ClipboardList}
              onClick={() => setPage("games")}
            />
            {manager ? (
              <MenuRow
                title={t("players")}
                ariaLabel={shell.t("playersScreen")}
                description={t("playersDescription")}
                icon={Users}
                onClick={props.onPlayers}
              />
            ) : null}
          </MenuGroup>
          <MenuGroup title={t("settings")}>
            {manager ? (
              <MenuRow
                title={t("clubSettings")}
                description={t("clubSettingsDescription")}
                icon={House}
                onClick={() => {
                  setClubSection("options");
                  setPage("club");
                }}
              />
            ) : null}
            <MenuRow
              title={t("preferences")}
              description={t(manager ? "preferencesDescription" : "memberPreferencesDescription")}
              icon={SlidersHorizontal}
              onClick={() => setPage("preferences")}
            />
          </MenuGroup>
          <button type="button" className="workspace-menu-footer-action" onClick={props.onExit}>
            <LogOut aria-hidden="true" />
            {t("chooseAnotherClub")}
          </button>
        </>
      ) : null}
      {currentPage === "games" ? (
        <>
          <MenuGroup title={t("continueHosting")}>
            {props.activeGames}
            {props.tournament}
          </MenuGroup>
          <MenuGroup title={t("review")}>
            {manager ? (
              <MenuRow
                title={shell.t("pastGameTimeline")}
                icon={ClipboardList}
                onClick={props.onTimeline}
              />
            ) : null}
            <MenuRow
              title={shell.t("statisticsScreen")}
              icon={Activity}
              onClick={props.onStatistics}
            />
          </MenuGroup>
        </>
      ) : null}
      {currentPage === "club" ? (
        <>
          <div className="workspace-menu-tabs" role="group" aria-label={t("clubSettingsSections")}>
            <button
              type="button"
              aria-pressed={clubSection === "options"}
              onClick={() => setClubSection("options")}
            >
              {t("gameOptions")}
            </button>
            <button
              type="button"
              aria-pressed={clubSection === "details"}
              onClick={() => setClubSection("details")}
            >
              {shell.t("clubDetails")}
            </button>
          </div>
          {clubSection === "options" ? (
            <BestMoveForm
              value={props.club.bestMoveEnabled}
              clubSaving={props.clubSaving}
              onSave={props.onBestMoveChange}
              onCancel={() => setPage("root")}
            />
          ) : (
            <>
              <MenuRow
                title={shell.t("editClub")}
                icon={House}
                disabled={props.clubSaving}
                onClick={props.onEditClub}
              />
              <MenuGroup title={t("clubLanguage")}>
                <fieldset className="workspace-menu-language" disabled={props.clubSaving}>
                  {props.language}
                </fieldset>
              </MenuGroup>
              <MenuGroup title={t("dangerZone")}>
                <MenuRow
                  title={shell.t("deleteClub")}
                  description={t("deleteClubDescription")}
                  icon={Trash2}
                  danger
                  disabled={props.clubSaving}
                  onClick={props.onDeleteClub}
                />
              </MenuGroup>
            </>
          )}
        </>
      ) : null}
      {currentPage === "preferences" ? (
        <>
          <MenuGroup title={t("thisDevice")}>
            <MenuRow
              title={t("appearance")}
              description={t(manager ? "appearanceDescription" : "memberAppearanceDescription")}
              icon={Palette}
              onClick={() => setPage("appearance")}
            />
            <MenuRow
              title={t("help")}
              description={t("helpDescription")}
              icon={CircleHelp}
              onClick={() => setPage("help")}
            />
          </MenuGroup>
          {manager ? (
            <MenuGroup title={t("connectedAccount")}>
              <MenuRow
                title={shell.t("musicPlayerSetup")}
                description={t("musicDescription")}
                icon={Music2}
                onClick={() => {
                  props.onMusicOpen();
                  setPage("music");
                }}
              />
            </MenuGroup>
          ) : null}
        </>
      ) : null}
      {currentPage === "appearance" ? props.appearance : null}
      {currentPage === "help" ? (
        <>
          <MenuRow title={t("rulesGuide")} icon={ClipboardList} onClick={props.onOpenRules} />
          {props.help}
        </>
      ) : null}
      {currentPage === "music" ? props.music : null}
    </Drawer>
  );
};

/** Callbacks retain ownership of workspace/save guards and destination routing. */
export const ManageMenu = (props: ManageMenuProps) => (
  <ManageMenuContent key={props.club.id} {...props} />
);

export const DeveloperMenu = (props: DeveloperMenuProps) => {
  const { t } = useMessages(menusMessages);
  const shell = useMessages(shellMessages);
  const [page, setPage] = useState<"root" | "visualEffects" | "gameTesting" | "diagnostics">(
    "root",
  );
  const close = () => {
    setPage("root");
    props.onClose();
  };
  return (
    <Drawer
      kind="dev"
      label={shell.t("developerMenu")}
      title={page === "root" ? shell.t("devMenu") : t(page)}
      subtitle={t("developerSubtitle")}
      onClose={close}
      onBack={page === "root" ? undefined : () => setPage("root")}
    >
      {page === "root" ? (
        <>
          <MenuGroup title={t("groupedTools")}>
            <MenuRow
              title={t("visualEffects")}
              description={t("visualEffectsDescription")}
              icon={Sparkles}
              onClick={() => setPage("visualEffects")}
            />
            <MenuRow
              title={t("gameTesting")}
              description={t("gameTestingDescription")}
              icon={FlaskConical}
              onClick={() => setPage("gameTesting")}
            />
            <MenuRow
              title={t("diagnostics")}
              description={t("diagnosticsDescription")}
              icon={Activity}
              onClick={() => setPage("diagnostics")}
            />
          </MenuGroup>
          <button type="button" className="workspace-menu-footer-action" onClick={props.onHide}>
            <EyeOff aria-hidden="true" />
            {shell.t("hideDeveloperMode")}
          </button>
        </>
      ) : (
        <div className="dev-menu-actions">{props[page]}</div>
      )}
    </Drawer>
  );
};

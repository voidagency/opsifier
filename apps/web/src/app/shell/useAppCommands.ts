import { useNavigate } from "@tanstack/react-router";
import { Activity, Gauge, Globe, KeyRound, Languages, LayoutGrid, LogOut } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { languages, setLanguage } from "../../i18n";
import { setThemePreference, themePreferences } from "../../lib/theme";
import { type PaletteCommand, useRegisterCommands } from "../commands";
import { languageNames, themeIcons } from "./preferences";
import { useSignOut } from "./useSignOut";

/** The commands that exist on every screen of the signed-in app. */
export function useAppCommands(): void {
  const { t } = useTranslation("shell");
  const navigate = useNavigate();
  const signOut = useSignOut();

  const commands = useMemo<PaletteCommand[]>(() => {
    const navigation = t("palette.groups.navigation");
    const settings = t("palette.groups.settings");
    const preferences = t("palette.groups.preferences");
    return [
      {
        id: "go.overview",
        group: navigation,
        title: t("nav.overview"),
        icon: LayoutGrid,
        keywords: ["home", "dashboard"],
        run: () => navigate({ to: "/" }),
      },
      {
        id: "go.activity",
        group: navigation,
        title: t("nav.activity"),
        icon: Activity,
        keywords: ["actions", "log", "history"],
        run: () => navigate({ to: "/activity" }),
      },
      {
        id: "go.monitor",
        group: navigation,
        title: t("nav.monitor"),
        icon: Gauge,
        keywords: ["cpu", "memory", "metrics"],
        run: () => navigate({ to: "/monitor" }),
      },
      {
        id: "go.domains",
        group: navigation,
        title: t("nav.domains"),
        icon: Globe,
        keywords: ["dns", "routes", "certificates"],
        run: () => navigate({ to: "/domains" }),
      },
      {
        id: "go.authentication",
        group: settings,
        title: t("settingsNav.authentication"),
        icon: KeyRound,
        keywords: ["password", "email", "two-factor", "2fa", "security"],
        run: () => navigate({ to: "/settings/user/authentication" }),
      },
      ...themePreferences.map((preference) => ({
        id: `theme.${preference}`,
        group: preferences,
        title: t("palette.useTheme", { theme: t(`theme.${preference}`) }),
        icon: themeIcons[preference],
        keywords: ["appearance", "dark mode", "light mode"],
        run: () => setThemePreference(preference),
      })),
      ...languages.map((language) => ({
        id: `language.${language}`,
        group: preferences,
        title: languageNames[language],
        icon: Languages,
        keywords: ["language", "langue", language],
        run: () => setLanguage(language),
      })),
      {
        id: "session.signout",
        group: preferences,
        title: t("user.signOut"),
        icon: LogOut,
        keywords: ["logout", "exit"],
        run: () => void signOut(),
      },
    ];
  }, [t, navigate, signOut]);

  useRegisterCommands(commands);
}

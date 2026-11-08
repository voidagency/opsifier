import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../features/auth/session";
import { type Language, languages, setLanguage } from "../../i18n";
import {
  setThemePreference,
  type ThemePreference,
  themePreferences,
  useThemePreference,
} from "../../lib/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useCopy,
} from "../../ui";
import { languageNames } from "./preferences";
import { systemInfoQuery } from "./systemInfo";
import { useSignOut } from "./useSignOut";

export function UserMenu() {
  const { t, i18n } = useTranslation("shell");
  const user = useCurrentUser();
  const navigate = useNavigate();
  const signOut = useSignOut();
  const preference = useThemePreference();
  const { data: system } = useQuery(systemInfoQuery);
  const ip = system?.serverIp ?? null;
  const { copy } = useCopy(ip ?? "");

  if (!user) {
    return null;
  }

  const initial = user.email.charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("user.menu")}
        className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-sm border border-off font-medium text-xs hover:bg-wash data-[state=open]:bg-wash"
      >
        {initial}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[260px]">
        <div className="px-2 py-1.5">
          <p className="truncate font-mono text-xs" title={user.email}>
            {user.email}
          </p>
          <p className="mt-0.5 text-xs text-muted">{t(`user.role.${user.role}`)}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate({ to: "/settings/user/authentication" })}>
          <Settings aria-hidden="true" className="size-4 text-muted" />
          {t("settingsNav.authentication")}
        </DropdownMenuItem>
        {ip && (
          <DropdownMenuItem onSelect={copy} className="xl:hidden">
            <span className="flex-1">{t("server.copyIp")}</span>
            <span className="font-mono text-xs text-muted">{ip}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("theme.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => setThemePreference(value as ThemePreference)}
        >
          {themePreferences.map((choice) => (
            <DropdownMenuRadioItem key={choice} value={choice}>
              {t(`theme.${choice}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("language")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={i18n.language}
          onValueChange={(value) => setLanguage(value as Language)}
        >
          {languages.map((language) => (
            <DropdownMenuRadioItem key={language} value={language}>
              {languageNames[language]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut aria-hidden="true" className="size-4 text-muted" />
          {t("user.signOut")}
        </DropdownMenuItem>
        {system && <p className="px-2 pt-1 pb-1.5 font-mono text-micro text-muted">v{system.version}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

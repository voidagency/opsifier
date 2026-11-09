import { Laptop, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type Language, languages, setLanguage } from "../../i18n";
import { cn } from "../../lib/cn";
import { setThemePreference, type ThemePreference, useThemePreference } from "../../lib/theme";

export const themeIcons = { system: Laptop, light: Sun, dark: Moon } as const;

export const languageNames: Record<Language, string> = { en: "English", fr: "Français" };

function SegmentButton({
  pressed,
  label,
  onClick,
  className,
  children,
}: {
  pressed: boolean;
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center justify-center rounded-sm text-xs text-muted hover:text-ink aria-pressed:bg-wash aria-pressed:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Compact theme control, for screens without the user menu. */
export function ThemeSwitch() {
  const { t } = useTranslation("shell");
  const current = useThemePreference();
  const choices: ThemePreference[] = ["system", "light", "dark"];
  return (
    <div className="flex gap-px">
      {choices.map((choice) => {
        const Icon = themeIcons[choice];
        return (
          <SegmentButton
            key={choice}
            pressed={current === choice}
            label={t(`theme.${choice}`)}
            onClick={() => setThemePreference(choice)}
            className="w-7"
          >
            <Icon aria-hidden="true" className="size-3.5" />
          </SegmentButton>
        );
      })}
    </div>
  );
}

/** Compact language control, for screens without the user menu. */
export function LanguageSwitch() {
  const { i18n } = useTranslation();
  return (
    <div className="flex gap-px">
      {languages.map((language) => (
        <SegmentButton
          key={language}
          pressed={i18n.language === language}
          label={`${languageNames[language]}, ${language.toUpperCase()}`}
          onClick={() => setLanguage(language)}
          className="w-8 font-mono uppercase"
        >
          {language}
        </SegmentButton>
      ))}
    </div>
  );
}

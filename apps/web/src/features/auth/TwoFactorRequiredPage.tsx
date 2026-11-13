import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSignOut } from "../../app/shell/useSignOut";
import { Button } from "../../ui";
import { TwoFactorSetupDialog } from "../settings/AuthenticationPage";
import { AuthLayout } from "./AuthLayout";
import { sessionQuery } from "./session";

/**
 * While the panel requires two-factor sign-in, an account without it lands here and can do nothing
 * else: turning it on takes it into the panel, signing out takes it away.
 */
export function TwoFactorRequiredPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const signOut = useSignOut();
  const { data: session } = useQuery(sessionQuery);
  const [open, setOpen] = useState(false);
  const email = session?.status === "signed-in" ? session.user.email : "";
  const turnedOn = session?.status === "signed-in" && session.user.twoFactorEnabled;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // The dialog only closes once the recovery codes are saved, and then the panel is open.
    if (!next && turnedOn) {
      void navigate({ to: "/", replace: true });
    }
  };

  return (
    <AuthLayout title={t("twoFactorRequired.title")} description={t("twoFactorRequired.description")}>
      <div className="grid gap-3">
        <p className="text-sm text-muted">{t("twoFactorRequired.account", { email })}</p>
        <Button variant="primary" size="lg" className="w-full" onClick={() => setOpen(true)}>
          {t("twoFactorRequired.start")}
        </Button>
        <Button variant="ghost" className="w-full" onClick={signOut}>
          {t("twoFactorRequired.signOut")}
        </Button>
      </div>
      <TwoFactorSetupDialog open={open} onOpenChange={onOpenChange} />
    </AuthLayout>
  );
}

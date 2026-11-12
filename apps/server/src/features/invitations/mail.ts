import type { InvitationLanguage, UserRole } from "@opsifier/contract";

export interface InvitationMailInput {
  language: InvitationLanguage;
  /**
   * Who invites, by address. Never their name: that is free text anyone can set, and nothing in an
   * e-mail sent under the panel's name may be.
   */
  inviter: string;
  /** The host people open the panel at. */
  panel: string;
  role: UserRole;
  link: string;
  expiresAt: Date;
}

interface Wording {
  subject: (panel: string) => string;
  body: (input: InvitationMailInput, until: string) => string[];
  locale: string;
}

const wordings: Record<InvitationLanguage, Wording> = {
  en: {
    locale: "en-GB",
    subject: (panel) => `Your invitation to Opsifier on ${panel}`,
    body: (input, until) => [
      "Hello,",
      "",
      `${input.inviter} has invited you to the Opsifier panel at ${input.panel}, as ${
        input.role === "admin" ? "an administrator" : "a member"
      }.`,
      "",
      "To create your account, choose your password here:",
      input.link,
      "",
      `This link works once, until ${until} UTC. If you were not expecting this invitation, you can ignore this message.`,
    ],
  },
  fr: {
    locale: "fr-FR",
    subject: (panel) => `Votre invitation à Opsifier sur ${panel}`,
    body: (input, until) => [
      "Bonjour,",
      "",
      `${input.inviter} vous invite à rejoindre le panneau Opsifier de ${input.panel}, en tant ${
        input.role === "admin" ? "qu'administrateur" : "que membre"
      }.`,
      "",
      "Pour créer votre compte, choisissez votre mot de passe ici :",
      input.link,
      "",
      `Ce lien ne fonctionne qu'une fois, jusqu'au ${until} UTC. Si vous n'attendiez pas cette invitation, ignorez ce message.`,
    ],
  },
};

/** The e-mail that carries one invitation. Plain text: the link is the only thing in it that matters. */
export function invitationMail(input: InvitationMailInput): { subject: string; body: string } {
  const wording = wordings[input.language];
  const until = new Intl.DateTimeFormat(wording.locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(input.expiresAt);
  return { subject: wording.subject(input.panel), body: wording.body(input, until).join("\n") };
}

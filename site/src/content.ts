export type Locale = "en" | "fr";

export const REPOSITORY = "https://github.com/voidagency/opsifier";
export const REPORT_ABUSE = `${REPOSITORY}/issues/new?title=Abuse%20report`;

const NB = " ";

const en = {
  meta: {
    title: "Opsifier: an open-source control panel for your own server",
    description:
      "Deploy apps and databases on your own server, and see at a glance that they are running. Open source, Apache 2.0, in early development.",
  },
  nav: {
    skip: "Skip to content",
    label: "Main",
    what: "What it runs",
    status: "Where it stands",
    github: "GitHub",
    switchLabel: "Français",
    switchLang: "fr",
    home: "Opsifier home",
  },
  hero: {
    question: "Is everything running?",
    lead: "Opsifier is an open-source control panel for your own server. It deploys your apps and databases, and tells you how they are doing before you read a word.",
    primary: "Read the code on GitHub",
    secondary: "See what it runs",
    early: "Early development. Not ready for production yet.",
    scroll: "Scroll to deploy",
    boardLabel:
      "A board of status lights. As you scroll, every light settles on running and the summary reads All clear.",
    clear: "All clear",
    deploying: "Deploying",
    problem: "problem",
    problems: "problems",
    states: {
      failed: "Failed",
      degraded: "Degraded",
      unknown: "Unknown",
      progress: "In progress",
      running: "Running",
      stopped: "Stopped",
    },
  },
  glance: {
    title: "The answer comes before the words.",
    body: "Open the panel and you already know. Every service has one light, and each of the six states has its own colour, shape and motion, so nothing depends on colour alone.",
    rule: "Only work in progress moves. A problem flashes three times, then holds still until you deal with it.",
    alt: "The Opsifier overview, with a summary of every state, gauges for the server and a list of projects",
    caption: "A demo server with sample data.",
  },
  runs: {
    title: "It runs what you already run.",
    rows: [
      ["app", "Apps", "From a Docker image, a Git repository, GitHub, a Dockerfile or an uploaded archive."],
      ["postgres", "Databases", "Postgres, MySQL, MariaDB, MongoDB and Redis, with credentials and backups handled for you."],
      ["compose", "Compose stacks", "Bring your compose file and keep it."],
      ["template", "Templates", "Ready-made apps, installed in a few clicks."],
      ["box", "Box", "A runtime with the languages you pick and an editor in the browser."],
      ["schedule", "Scripts", "On a schedule, with a time limit, a real cancel and a history of every run."],
    ],
  },
  back: {
    title: "Every deployment is a version you can return to.",
    body: "Opsifier records the exact image each deployment ran and keeps its settings, five versions per service by default. When a release of an app goes wrong, one action puts the previous one back, and your volumes stay as they were.",
    failed: "If an update fails on its own, the version before it comes back without you asking.",
    alt: "The deployments of a service, with the active version and earlier versions you can go back to",
  },
  address: {
    title: "An address, on request.",
    body: "Ask for one from the panel. Once a person has approved it, your server gets its own name and one wildcard certificate for everything under it, with no DNS to set up. You can always use your own domain instead.",
    another: "Another example",
    note: "An example of what a server's address looks like.",
    apps: "Your apps appear under it",
  },
  roles: {
    title: "Say what the server is for.",
    body: "Until you decide, every site stays behind a password and out of search engines. Going to production takes a typed confirmation.",
    label: "Server role",
    items: [
      {
        id: "development",
        name: "Development",
        rows: ["Every site asks for a password", "robots.txt tells crawlers to stay away", "Nothing gets indexed"],
        lock: true,
      },
      {
        id: "staging",
        name: "Staging",
        rows: ["Password required, for your clients too", "Closed to crawlers by robots.txt", "Invisible to search engines"],
        lock: true,
      },
      {
        id: "production",
        name: "Production",
        rows: ["Sites are open to everyone", "Crawlers are welcome", "Made to be indexed"],
        lock: false,
      },
    ],
  },
  terminal: {
    title: "From a terminal, or from an agent.",
    body: "The command line and the MCP server use the same API keys and the same rights as the API, so neither can do what the key could not.",
    label: "Commands of the Opsifier command line",
  },
  status: {
    title: "Where it stands.",
    body: "Opsifier is in early development. Expect breaking changes, and don't put anything on it yet that you can't afford to lose.",
    worksTitle: "Works today",
    works: ["Deployments and going back", "Domains and HTTPS", "Databases and backups", "Logs, console and metrics", "Two-factor sign-in and project roles"],
    notYetTitle: "Not yet",
    notYet: ["A one-line installer", "WordPress sites", "Moving a project between servers", "Multi-node clusters and tunnels"],
  },
  start: {
    title: "Read it, run it, change it.",
    body: "Apache 2.0, with every feature included and no paid tiers. Development mode uses a simulated Docker, so it changes nothing on your machine.",
    copy: "Copy",
    copied: "Copied",
    needs: "You need Bun and Node.js 22.13 or later.",
    cta: "Open the repository",
  },
  footer: {
    license: "Apache 2.0",
    abuse: "Report abuse",
    independent: "An independent project, not affiliated with any other control panel vendor.",
  },
  abuse: {
    title: "Report abuse of an opsifier.dev address",
    description: "How to report phishing, malware or other abuse on an opsifier.dev address.",
    lead: "Names under opsifier.dev are issued on request to people running Opsifier on their own servers. We don't host what those servers publish, and we can take a name away.",
    howTitle: "How to report it",
    how: "Open an issue on GitHub with the address and what you saw. Issues are public, so leave out anything personal.",
    action: "Open an issue",
    includeTitle: "What to include",
    include: ["The full address, such as abc12345.opsifier.dev", "What you saw and when", "A link or a screenshot, if you have one"],
    afterTitle: "What happens next",
    after: "We can disable an address. That removes its records, and the name is never issued again.",
    back: "Back to the home page",
  },
  notFound: {
    title: "This address isn't running",
    description: "This page does not exist.",
    body: "There is nothing deployed here. It may have moved, or it may never have existed.",
    back: "Back to the home page",
  },
};

export type Content = typeof en;

const fr: Content = {
  meta: {
    title: "Opsifier : un panneau de contrôle open source pour votre serveur",
    description:
      "Déployez applications et bases de données sur votre propre serveur, et voyez d'un coup d'œil que tout tourne. Open source, Apache 2.0, en développement précoce.",
  },
  nav: {
    skip: "Aller au contenu",
    label: "Principale",
    what: "Ce qu'il fait tourner",
    status: "Où il en est",
    github: "GitHub",
    switchLabel: "English",
    switchLang: "en",
    home: "Accueil Opsifier",
  },
  hero: {
    question: `Est-ce que tout tourne${NB}?`,
    lead: "Opsifier est un panneau de contrôle open source pour votre propre serveur. Il déploie vos applications et vos bases de données, et vous dit comment elles vont avant que vous ayez lu un mot.",
    primary: "Lire le code sur GitHub",
    secondary: "Voir ce qu'il fait tourner",
    early: "Développement précoce. Pas encore prêt pour la production.",
    scroll: "Faites défiler pour déployer",
    boardLabel:
      "Un tableau de voyants. Au défilement, chaque voyant se stabilise sur En marche et le résumé indique Tout va bien.",
    clear: "Tout va bien",
    deploying: "Déploiement",
    problem: "problème",
    problems: "problèmes",
    states: {
      failed: "En échec",
      degraded: "Dégradé",
      unknown: "Inconnu",
      progress: "En cours",
      running: "En marche",
      stopped: "Arrêté",
    },
  },
  glance: {
    title: "La réponse arrive avant les mots.",
    body: "Ouvrez le panneau et vous savez déjà. Chaque service a un seul voyant, et chacun des six états a sa couleur, sa forme et son mouvement, pour que rien ne dépende de la couleur seule.",
    rule: "Seul le travail en cours bouge. Un problème clignote trois fois, puis reste immobile jusqu'à ce que vous vous en occupiez.",
    alt: "La vue d'ensemble d'Opsifier, avec le résumé de chaque état, les jauges du serveur et la liste des projets",
    caption: "Un serveur de démonstration avec des données d'exemple.",
  },
  runs: {
    title: "Il fait tourner ce que vous faites déjà tourner.",
    rows: [
      ["app", "Applications", "Depuis une image Docker, un dépôt Git, GitHub, un Dockerfile ou une archive envoyée."],
      ["postgres", "Bases de données", "Postgres, MySQL, MariaDB, MongoDB et Redis, avec les accès et les sauvegardes gérés pour vous."],
      ["compose", "Stacks Compose", "Apportez votre fichier compose et gardez-le."],
      ["template", "Modèles", "Des applications prêtes à l'emploi, installées en quelques clics."],
      ["box", "Box", "Un environnement avec les langages de votre choix et un éditeur dans le navigateur."],
      ["schedule", "Scripts", "Planifiés, avec une durée maximale, une vraie annulation et l'historique de chaque exécution."],
    ],
  },
  back: {
    title: "Chaque déploiement est une version où revenir.",
    body: "Opsifier enregistre l'image exacte de chaque déploiement et conserve ses réglages, cinq versions par service par défaut. Quand une version d'une application tourne mal, une seule action remet la précédente, et vos volumes restent tels quels.",
    failed: "Si une mise à jour échoue d'elle-même, la version d'avant revient sans que vous ayez à le demander.",
    alt: "Les déploiements d'un service, avec la version active et les versions précédentes où revenir",
  },
  address: {
    title: "Une adresse, sur demande.",
    body: "Demandez-la depuis le panneau. Une fois validée par une personne, votre serveur reçoit son propre nom et un certificat wildcard pour tout ce qui se trouve dessous, sans DNS à configurer. Vous pouvez toujours utiliser votre propre domaine à la place.",
    another: "Un autre exemple",
    note: "Un exemple de ce à quoi ressemble l'adresse d'un serveur.",
    apps: "Vos applications apparaissent dessous",
  },
  roles: {
    title: "Dites à quoi sert le serveur.",
    body: "Tant que vous n'avez pas choisi, chaque site reste derrière un mot de passe et hors des moteurs de recherche. Passer en production demande une confirmation écrite.",
    label: "Rôle du serveur",
    items: [
      {
        id: "development",
        name: "Développement",
        rows: ["Chaque site demande un mot de passe", "robots.txt éloigne les robots d'indexation", "Rien n'est indexé"],
        lock: true,
      },
      {
        id: "staging",
        name: "Préproduction",
        rows: ["Mot de passe exigé, pour vos clients aussi", "Fermé aux robots par robots.txt", "Invisible des moteurs de recherche"],
        lock: true,
      },
      {
        id: "production",
        name: "Production",
        rows: ["Les sites sont ouverts à tous", "Les robots d'indexation sont les bienvenus", "Fait pour être indexé"],
        lock: false,
      },
    ],
  },
  terminal: {
    title: "Depuis un terminal, ou depuis un agent.",
    body: "La ligne de commande et le serveur MCP utilisent les mêmes clés d'API et les mêmes droits que l'API : aucun des deux ne peut faire ce que la clé ne permet pas.",
    label: "Commandes de la ligne de commande Opsifier",
  },
  status: {
    title: "Où il en est.",
    body: "Opsifier est en développement précoce. Attendez-vous à des changements incompatibles, et n'y mettez encore rien que vous ne puissiez vous permettre de perdre.",
    worksTitle: "Fonctionne aujourd'hui",
    works: ["Les déploiements et le retour en arrière", "Les domaines et HTTPS", "Les bases de données et les sauvegardes", "Les journaux, la console et les métriques", "La connexion à deux facteurs et les rôles par projet"],
    notYetTitle: "Pas encore",
    notYet: ["Une installation en une ligne", "Les sites WordPress", "Le déplacement d'un projet entre serveurs", "Les clusters multi-nœuds et les tunnels"],
  },
  start: {
    title: "Lisez-le, lancez-le, modifiez-le.",
    body: "Apache 2.0, toutes les fonctionnalités incluses et aucune offre payante. Le mode développement utilise un Docker simulé : rien ne change sur votre machine.",
    copy: "Copier",
    copied: "Copié",
    needs: "Il vous faut Bun et Node.js 22.13 ou plus récent.",
    cta: "Ouvrir le dépôt",
  },
  footer: {
    license: "Apache 2.0",
    abuse: "Signaler un abus",
    independent: "Un projet indépendant, sans lien avec un autre éditeur de panneau de contrôle.",
  },
  abuse: {
    title: "Signaler un abus sur une adresse opsifier.dev",
    description: "Comment signaler un hameçonnage, un logiciel malveillant ou un autre abus sur une adresse opsifier.dev.",
    lead: "Les noms sous opsifier.dev sont attribués sur demande aux personnes qui font tourner Opsifier sur leur propre serveur. Nous n'hébergeons pas ce que ces serveurs publient, et nous pouvons retirer un nom.",
    howTitle: "Comment le signaler",
    how: "Ouvrez un ticket sur GitHub avec l'adresse et ce que vous avez vu. Les tickets sont publics : n'y mettez rien de personnel.",
    action: "Ouvrir un ticket",
    includeTitle: "Ce qu'il faut indiquer",
    include: ["L'adresse complète, par exemple abc12345.opsifier.dev", "Ce que vous avez vu et quand", "Un lien ou une capture d'écran, si vous en avez"],
    afterTitle: "Ce qui se passe ensuite",
    after: "Nous pouvons désactiver une adresse. Ses enregistrements sont supprimés, et le nom n'est jamais réattribué.",
    back: "Retour à l'accueil",
  },
  notFound: {
    title: "Cette adresse ne tourne pas",
    description: "Cette page n'existe pas.",
    body: "Rien n'est déployé ici. La page a peut-être changé de place, ou n'a jamais existé.",
    back: "Retour à l'accueil",
  },
};

export const content: Record<Locale, Content> = { en, fr };

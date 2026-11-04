/**
 * Minimal i18n (English source strings as keys, gettext-style). The language is the user's choice (localStorage),
 * else the browser's; switching reloads the page. Untranslated strings fall back to English.
 * Add a language: a dictionary below + an entry in LANGS.
 */
export type Lang = 'en' | 'fr';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' },
];

const fr: Record<string, string> = {
  // navigation
  Dashboard: 'Tableau de bord',
  'New application': 'Nouvelle application',
  Applications: 'Applications',
  'Your applications will appear here.': 'Vos applications apparaîtront ici.',
  Theme: 'Thème',
  More: 'Plus',
  'Sign out': 'Se déconnecter',
  'Sign out everywhere': 'Se déconnecter partout',
  'Sign out on every device?': 'Se déconnecter sur tous les appareils ?',
  Light: 'Clair',
  Dark: 'Sombre',
  System: 'Système',
  // statuses & phases
  'Setting up': 'Mise en place',
  Ready: 'Prête',
  'Waiting for a free agent': 'En attente d’un agent',
  Working: 'En cours',
  'Ready for feedback': 'Prête pour vos retours',
  'Needs attention': 'À vérifier',
  Archived: 'Archivée',
  Understanding: 'Compréhension',
  Planning: 'Plan',
  Building: 'Construction',
  Testing: 'Tests',
  Preview: 'Aperçu',
  Review: 'Revue',
  Done: 'Terminé',
  'Waiting for you': 'En attente de vous',
  Preparing: 'Préparation',
  Starting: 'Démarrage',
  Live: 'En ligne',
  Failed: 'Échec',
  Removed: 'Supprimé',
  'Waiting for approval': 'En attente d’approbation',
  'Approved & merged': 'Approuvée et fusionnée',
  Closed: 'Fermée',
  // app view
  Progress: 'Avancement',
  Previews: 'Aperçus',
  Changes: 'Modifications',
  History: 'Historique',
  People: 'Personnes',
  Settings: 'Réglages',
  'Try it': 'Essayer',
  Code: 'Code',
  'Toggle details panel': 'Afficher / masquer le panneau',
  'Try again': 'Réessayer',
  // chat
  'Setting things up — you can already add details…': 'Mise en place — vous pouvez déjà ajouter des détails…',
  'Add a comment — the agent will take it into account as it works': 'Ajoutez un commentaire — l’agent en tiendra compte',
  'Share feedback or ask for the next change…': 'Donnez votre avis ou demandez la prochaine modification…',
  Stop: 'Arrêter',
  Attach: 'Joindre',
  'Approve the plan': 'Approuver le plan',
  'Request changes': 'Demander des changements',
  'Please change the plan: ': 'Merci de modifier le plan : ',
  'Approved — go ahead with this plan.': 'Approuvé — allez-y avec ce plan.',
  'Setting up your project…': 'Mise en place de votre projet…',
  'All agents are busy — your request starts as soon as one is free…': 'Tous les agents sont occupés — votre demande démarre dès qu’un agent est libre…',
  'Working on it…': 'Je m’en occupe…',
  'Blackbox proposes every change for approval before it reaches the main version.':
    'Blackbox soumet chaque modification à approbation avant qu’elle n’atteigne la version principale.',
  'You can follow this application. Ask its owner for chat access to steer the agent.':
    'Vous pouvez suivre cette application. Demandez à son propriétaire l’accès au chat pour guider l’agent.',
  // new application
  'What would you like to build?': 'Que voulez-vous construire ?',
  "Describe it like you would to a colleague: who it's for, what they should be able to do, anything that matters to you. Blackbox plans it, builds it":
    'Décrivez-la comme à un collègue : pour qui, ce qu’ils doivent pouvoir faire, ce qui compte pour vous. Blackbox la planifie, la construit',
  ' and gives you a link to try it': ' et vous donne un lien pour l’essayer',
  'Give it a name — e.g. Feedback portal': 'Donnez-lui un nom — ex. Portail de retours',
  'Our sales team needs a place to…': 'Notre équipe commerciale a besoin d’un endroit pour…',
  'The agent will share a plan before it starts building.': 'L’agent partagera un plan avant de commencer.',
  'Start from': 'Partir de',
  'Let the agent choose': 'Laisser l’agent choisir',
  'Work on an existing repository': 'Travailler sur un dépôt existant',
  // dashboard
  'Hello {name}': 'Bonjour {name}',
  All: 'Toutes',
  'In progress': 'En cours',
  'Needs you': 'Vous attendent',
  'Live preview': 'Aperçu en ligne',
  'Search applications': 'Rechercher une application',
  'Everything is up to date.': 'Tout est à jour.',
  'No application matches.': 'Aucune application ne correspond.',
  'Describe it in your own words': 'Décrivez-la avec vos mots',
  'This month': 'Ce mois-ci',
  // timeline
  Checklist: 'Liste',
  'Latest updates': 'Dernières nouvelles',
  'Technical details': 'Détails techniques',
  'Updates will appear here as the agent works.': 'Les nouvelles apparaîtront ici pendant que l’agent travaille.',
};

const DICTS: Record<Lang, Record<string, string>> = { en: {}, fr };

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('blackbox.lang');
    if (saved === 'en' || saved === 'fr') return saved;
  } catch {
    /* no storage */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export let lang: Lang = initialLang();

/** Translate an English UI string; `{name}` placeholders are filled from `vars`. */
export function t(s: string, vars?: Record<string, string | number>) {
  const out = DICTS[lang][s] ?? s;
  return vars ? out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : out;
}

export function setLang(l: Lang) {
  localStorage.setItem('blackbox.lang', l);
  lang = l;
  location.reload();
}

/** For tests. */
export const dictionary = (l: Lang) => DICTS[l];
export const __setLangForTests = (l: Lang) => (lang = l);

// What the frame and kit pages say when a scene or a brand fails (shown in the editor's preview, read by Claude), and the
// sample content of the kit sheet in the editor's brand panel. The frame server writes the interface language in
// <html lang>; a language change reloads the editor and its frames.
const TEXTS = {
  fr: {
    runtimeError: (scene: string) => `Erreur d’exécution · ${scene}`,
    compileError: (scene: string) => `Erreur de compilation · ${scene}`,
    sceneNotFound: 'Scène introuvable',
    sceneMissing: (id: string) => `La scène « ${id} » n’existe pas dans ce projet.`,
    sceneExport: (id: string) => `scenes/${id}.tsx doit exporter par défaut un composant React`,
    kitExport: 'index.tsx doit exporter par défaut le BrandKit de la marque',
    brandFailed: (id: string, error: string) => `Impossible de charger la marque « ${id} » : ${error}`,
    projectFailed: (id: string, error: string) => `Impossible de charger le projet « ${id} » : ${error}`,
    fontFailed: (face: string) => `La police préchargée « ${face} » ne se charge pas`,
    sheet: {
      save: 'Enregistrer',
      cancel: 'Annuler',
      profile: 'Profil',
      name: 'Nom',
      saved: 'Enregistré il y a 2 minutes',
      active: 'Actif',
      month: 'Ce mois-ci',
      amount: '12 480 €',
      delta: '+12,4 %',
      tabs: ['Jour', 'Semaine', 'Mois'],
      notifications: 'Notifications',
      new: 'Nouveau',
      pending: 'En attente',
    },
  },
  en: {
    runtimeError: (scene: string) => `Runtime error · ${scene}`,
    compileError: (scene: string) => `Compile error · ${scene}`,
    sceneNotFound: 'Scene not found',
    sceneMissing: (id: string) => `The scene "${id}" does not exist in this project.`,
    sceneExport: (id: string) => `scenes/${id}.tsx must export a React component as its default`,
    kitExport: "index.tsx must export the brand's BrandKit as its default",
    brandFailed: (id: string, error: string) => `Could not load the brand "${id}": ${error}`,
    projectFailed: (id: string, error: string) => `Could not load the project "${id}": ${error}`,
    fontFailed: (face: string) => `The preloaded font "${face}" does not load`,
    sheet: {
      save: 'Save',
      cancel: 'Cancel',
      profile: 'Profile',
      name: 'Name',
      saved: 'Saved 2 minutes ago',
      active: 'Active',
      month: 'This month',
      amount: '$12,480',
      delta: '+12.4%',
      tabs: ['Day', 'Week', 'Month'],
      notifications: 'Notifications',
      new: 'New',
      pending: 'Pending',
    },
  },
};

export const texts = TEXTS[document.documentElement.lang === 'en' ? 'en' : 'fr'];

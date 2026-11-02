// What the frame and kit pages say when a scene or a brand fails (shown in the editor's preview, read by Claude), the
// kit sheet's section titles, and the sample content of the kit sheet in the editor's brand panel. The frame server writes
// the interface language in <html lang>; a language change reloads the editor and its frames.
const TEXTS = {
  fr: {
    runtimeError: (scene: string) => `Erreur d’exécution · ${scene}`,
    compileError: (scene: string) => `Erreur de compilation · ${scene}`,
    sceneNotFound: 'Scène introuvable',
    sceneMissing: (id: string) => `La scène « ${id} » n’existe pas dans ce projet.`,
    sceneExport: (id: string) => `scenes/${id}.tsx doit exporter par défaut un composant React`,
    soundsError: (scene: string) => `Erreur dans sounds() · ${scene}`,
    soundsExport: (id: string) => `L’export sounds de scenes/${id}.tsx doit être une fonction (props) => SoundCue[]`,
    soundCues: {
      notArray: 'sounds() doit renvoyer un tableau de sons',
      tooMany: (max: number) => `sounds() renvoie plus de ${max} sons`,
      notObject: (index: number) =>
        `son ${index} : un objet { at, sound, gain? } ou { at, clip, from?, duration?, gain? } est attendu`,
      at: (index: number, duration: number) => `son ${index} : at doit être un nombre de secondes entre 0 et ${duration}`,
      sound: (index: number, received: string, known: string) => `son ${index} : son inconnu ${received} (${known})`,
      gain: (index: number) => `son ${index} : gain doit être un nombre entre 0 et 1`,
      both: (index: number) => `son ${index} : sound ou clip, pas les deux`,
      clipUnknown: (index: number, received: string) =>
        `son ${index} : clip ${received} n’est pas une vidéo de assets/ de ce projet`,
      clipPreparing: (index: number, file: string) =>
        `son ${index} : la vidéo assets/${file} est en cours de préparation ; l’aperçu se met à jour quand elle est prête.`,
      clipFailed: (index: number, file: string, error: string) =>
        `son ${index} : impossible de préparer la vidéo assets/${file} : ${error}`,
      clipSilent: (index: number, file: string) => `son ${index} : la vidéo assets/${file} n’a pas de son`,
      clipFrom: (index: number, file: string, duration: number) =>
        `son ${index} : from doit être un nombre de secondes à partir de 0 et inférieur à ${duration}, la durée de assets/${file}`,
      clipDuration: (index: number) => `son ${index} : duration doit être un nombre de secondes supérieur à 0`,
      clipTotal: (seconds: number) => `sounds() : les sons de clips durent plus de ${seconds} s en tout`,
    },
    kitExport: 'index.tsx doit exporter par défaut le BrandKit de la marque',
    brandFailed: (id: string, error: string) => `Impossible de charger la marque « ${id} » : ${error}`,
    projectFailed: (id: string, error: string) => `Impossible de charger le projet « ${id} » : ${error}`,
    spectrumFailed: (file: string, reason: string) => `Impossible de lire le spectre de la musique ${file} : ${reason}`,
    spectrumSize: (size: number, expected: number) => `${size} octets au lieu de ${expected}`,
    spectrumPending:
      'music.spectrum() n’est pas encore disponible : l’analyse de la musique est en cours, ou elle a échoué (voir l’onglet Musique).',
    fontFailed: (face: string) => `La police préchargée « ${face} » ne se charge pas`,
    clipUnknown: (file: string) => `<Clip> : assets/${file} n’est ni une vidéo ni un GIF de ce projet`,
    clipPreparing: (file: string) =>
      `<Clip> : les images de assets/${file} sont en cours d’extraction ; l’aperçu se met à jour quand elles sont prêtes.`,
    clipFailed: (file: string, error: string) => `<Clip> : impossible d’extraire les images de assets/${file} : ${error}`,
    clipFrameFailed: (file: string, frame: string) => `<Clip> : l’image ${frame} de assets/${file} ne se charge pas`,
    sampleFailed: (name: string, error: string) => `${name} : ${error}`,
    sections: { colors: 'Couleurs', fonts: 'Polices', components: 'Composants', extras: 'Extras' },
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
    soundsError: (scene: string) => `sounds() error · ${scene}`,
    soundsExport: (id: string) => `The sounds export of scenes/${id}.tsx must be a function (props) => SoundCue[]`,
    soundCues: {
      notArray: 'sounds() must return an array of cues',
      tooMany: (max: number) => `sounds() returns more than ${max} cues`,
      notObject: (index: number) =>
        `sound cue ${index}: expected an object { at, sound, gain? } or { at, clip, from?, duration?, gain? }`,
      at: (index: number, duration: number) => `sound cue ${index}: at must be a number of seconds from 0 to ${duration}`,
      sound: (index: number, received: string, known: string) => `sound cue ${index}: unknown sound ${received} (${known})`,
      gain: (index: number) => `sound cue ${index}: gain must be a number from 0 to 1`,
      both: (index: number) => `sound cue ${index}: sound or clip, not both`,
      clipUnknown: (index: number, received: string) =>
        `sound cue ${index}: clip ${received} is not a video under assets/ of this project`,
      clipPreparing: (index: number, file: string) =>
        `sound cue ${index}: the video assets/${file} is being prepared; the preview updates when it is ready.`,
      clipFailed: (index: number, file: string, error: string) =>
        `sound cue ${index}: could not prepare the video assets/${file}: ${error}`,
      clipSilent: (index: number, file: string) => `sound cue ${index}: the video assets/${file} has no sound`,
      clipFrom: (index: number, file: string, duration: number) =>
        `sound cue ${index}: from must be a number of seconds from 0 and below ${duration}, the length of assets/${file}`,
      clipDuration: (index: number) => `sound cue ${index}: duration must be a number of seconds above 0`,
      clipTotal: (seconds: number) => `sounds(): the clip cues are heard more than ${seconds} s in all`,
    },
    kitExport: "index.tsx must export the brand's BrandKit as its default",
    brandFailed: (id: string, error: string) => `Could not load the brand "${id}": ${error}`,
    projectFailed: (id: string, error: string) => `Could not load the project "${id}": ${error}`,
    spectrumFailed: (file: string, reason: string) => `Could not read the music spectrum ${file}: ${reason}`,
    spectrumSize: (size: number, expected: number) => `${size} bytes instead of ${expected}`,
    spectrumPending: 'music.spectrum() is not available yet: the music analysis is running, or it failed (see the Music tab).',
    fontFailed: (face: string) => `The preloaded font "${face}" does not load`,
    clipUnknown: (file: string) => `<Clip>: assets/${file} is not a video or GIF of this project`,
    clipPreparing: (file: string) =>
      `<Clip>: the frames of assets/${file} are being extracted; the preview updates when they are ready.`,
    clipFailed: (file: string, error: string) => `<Clip>: could not extract the frames of assets/${file}: ${error}`,
    clipFrameFailed: (file: string, frame: string) => `<Clip>: frame ${frame} of assets/${file} does not load`,
    sampleFailed: (name: string, error: string) => `${name}: ${error}`,
    sections: { colors: 'Colors', fonts: 'Fonts', components: 'Components', extras: 'Extras' },
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

export const language = document.documentElement.lang === 'en' ? 'en' : 'fr';
export const texts = TEXTS[language];

export default {
  sceneNotFound: (id: string) => `Scène introuvable : ${id}`,
  invalidScale: (scale: unknown) => `Échelle invalide : ${scale}`,
  invalidFps: (fps: unknown) => `Images par seconde invalides : ${fps}`,
  reloadTimeout: 'Le rechargement a pris trop de temps',
  ffmpegStart: (bin: string, error: string) => `Impossible de lancer ffmpeg (${bin}) : ${error}`,
  capture: {
    chromium: (error: string) => `Impossible de démarrer Chromium (lancez « npm run setup » une fois) : ${error}`,
    frameNotStarted: (problems: string[]) =>
      `La page d’image n’a pas démarré${problems.length ? ` : ${problems.join(' \u00b7 ')}` : ''}`,
    frameLoadTimeout: 'Le chargement de la page d’image a pris trop de temps',
    seekTimeout: (time: string, seconds: number) => `Le rendu de t = ${time} a dépassé ${seconds} s (boucle infinie ?)`,
    stopping: 'Cadence s’arrête : capture annulée',
    sceneLoadTimeout: 'Le chargement de la scène a pris trop de temps',
    invalidFormat: (format: string) => `Format invalide : ${format}`,
    invalidTime: 'Temps invalide',
    kitNotStarted: 'La planche du kit n’a pas démarré',
    kitLoadTimeout: 'La planche du kit a pris trop de temps à se charger',
    invalidUrl: (url: string) => `Adresse invalide : ${url}`,
    httpOnly: 'Seules les adresses http(s) peuvent être capturées',
    openFailed: (url: string, error: string) => `Impossible d’ouvrir ${url} : ${error}`,
    hostNotFound: (host: string) => `Adresse introuvable : ${host}`,
    reserved: (host: string, address: string | null) =>
      `Adresse réservée, capture refusée : ${host}${address ? ` (${address})` : ''}`,
    itself: 'Cadence ne peut pas se capturer elle-même',
  },
  render: {
    notFound: 'Rendu introuvable',
    cancelled: 'Rendu annulé',
    invalidFileName: (name: string) => `Nom de fichier invalide : ${name}`,
    ffmpegStopped: (code: number, detail: string) => `ffmpeg s’est arrêté (code ${code}) : ${detail}`,
    videoError: (time: string, error: string) => `Erreur dans la vidéo à ${time} : ${error}`,
    ffmpegFailed: (code: number, detail: string) => `ffmpeg a échoué (code ${code}) : ${detail}`,
    nothing: 'Rien à rendre : la vidéo (ou la plage demandée) est vide',
    projectChanged: 'Le projet a changé pendant le lancement du rendu : relancez l’export.',
    invalidFormats: 'Formats de rendu invalides',
    invalidScale: (scale: number) => `Échelle invalide : ${scale} (0,5, 1 ou 2)`,
    invalidQuality: (quality: string) => `Qualité invalide : ${quality}`,
    invalidRange: 'Plage de rendu invalide',
    noScene: 'Le projet n’a aucune scène à rendre',
    noDetail: 'aucun détail',
  },
  music: {
    projectNotFound: (id: string) => `Projet introuvable : ${id}`,
    unsupported: (ext: string) =>
      `Format audio non pris en charge (${ext || 'sans extension'}) : mp3, wav, m4a, aac, flac ou ogg`,
    empty: 'Le fichier audio est vide',
    tooLarge: 'Fichier audio trop volumineux (200 Mo maximum)',
    trackNotFound: (file: string) => `Piste introuvable : ${file}`,
    invalidTrack: (file: string) => `Piste invalide : ${file}`,
    noMusic: 'Ce projet n’a pas de musique',
    addMusicFirst: 'Ajoutez une musique avant de caler les coupes',
    changed: 'La musique a changé pendant le calage, réessayez',
    analysisFailed: (file: string, error: string) => `Analyse de ${file} impossible : ${error}`,
    cacheNotWritten: (file: string, error: string) => `[cadence] cache d’analyse non écrit (${file}) : ${error}`,
    start: 'Le début de la musique doit être un nombre de secondes positif',
    volume: 'Le volume doit être compris entre 0 et 1',
    tempo: (min: number, max: number) => `Le tempo doit être compris entre ${min} et ${max} BPM`,
    beatsPerBar: 'Une mesure compte 3, 4 ou 6 temps',
    barOffset: (max: number) => `Le décalage de mesure doit être un nombre entier de temps entre 0 et ${max}`,
    gridOffset: 'Le décalage de la grille doit être compris entre −0,25 et 0,25 s',
    decodeFailed: (file: string, code: number | null, detail: string) =>
      `ffmpeg n’a pas pu décoder ${file} (code ${code}) : ${detail}`,
    encodeFailed: (file: string, detail: string | undefined) => `ffmpeg n’a pas pu encoder ${file} : ${detail}`,
  },
  voiceOver: {
    piperMissing: (bin: string) =>
      `Piper est introuvable (${bin}) : installez-le avec \`pipx install piper-tts\`, puis redémarrez Cadence`,
    piperStart: (bin: string, error: string) => `Impossible de lancer Piper (${bin}) : ${error}`,
    piperFailed: (code: number, detail: string) => `Piper a échoué (code ${code})${detail ? ` : ${detail}` : ''}`,
    piperCount: (expected: number, got: number) => `Piper a rendu ${got} fichier(s) pour ${expected} phrase(s)`,
    unknownVoice: (id: string) => `Voix inconnue : ${id}`,
    notDownloaded: (name: string) => `La voix ${name} n’est pas téléchargée : téléchargez-la dans l’onglet Voix`,
    downloadFailed: (name: string, error: string) => `Téléchargement de la voix ${name} impossible : ${error}`,
    corrupted: (name: string) => `La voix ${name} téléchargée est corrompue (md5) : réessayez`,
    noTrack: 'Aucune voix off générée pour ce projet',
  },
  analyze: {
    missingFile: (file: string) => `Fichier introuvable : ${file}`,
    number: (x: number, digits: number) => x.toFixed(digits).replace('.', ','),
    times: (values: string[], more: boolean) => values.join(' \u00b7 ') + (more ? ' \u2026' : ''),
    none: '\u2014',
    file: (file: string) => `Fichier     ${file}`,
    duration: (seconds: string) => `Durée       ${seconds} s`,
    tempo: (bpm: string, beatsPerBar: number, beat: string, bar: string) =>
      `Tempo       ${bpm} BPM \u00b7 ${beatsPerBar} temps par mesure \u00b7 1 temps = ${beat} s \u00b7 1 mesure = ${bar} s`,
    confidence: (value: string) => `Confiance   ${value} (régularité de la grille, 0 à 1)`,
    beats: (count: number, gap: string, spread: string, first: string) =>
      `Temps       ${count} (écart ${gap} ± ${spread} ms) \u00b7 premiers : ${first}`,
    bars: (count: number, first: string) => `Mesures     ${count} \u00b7 premières : ${first}`,
    phrases: (list: string) => `Phrases     ${list}`,
    sections: (count: number) => `Sections    ${count}`,
    section: (start: string, end: string, label: string, energy: string) =>
      `            ${start} \u2192 ${end}  ${label} énergie ${energy}`,
    accents: (count: number, strongest: string) => `Accents     ${count} \u00b7 plus forts : ${strongest}`,
    timings: (decoding: number, analysis: number) => `Durées      décodage ${decoding} ms, analyse ${analysis} ms`,
  },
  soundtracks: {
    unknown: (ids: string, known: string) => `Ambiance inconnue : ${ids} (${known})`,
    written: (file: string, bars: number, duration: number, lufs: string, peak: string) =>
      `${file} ${bars} mesures \u00b7 ${duration} s \u00b7 ${lufs} LUFS \u00b7 crête ${peak} dBFS`,
  },
  brands: {
    build: {
      tools: {
        copy_from_repo: 'Copie d’un fichier du dépôt',
        add_google_font: 'Téléchargement d’une police',
        preview_brand: 'Regarde la planche du kit',
        check_brand: 'Vérifie la marque',
      },
      incomplete: 'La marque ne passe pas la vérification finale.',
      badRepo: 'Dépôt non reconnu : owner/nom, ou une adresse github.com ou gitlab.com (https://\u2026 ou git@\u2026).',
      noName: 'Donnez un nom à la marque.',
      notFound: 'Construction de marque introuvable',
      cloning: (repo: string) => `Copie de ${repo}`,
      reading: 'Claude lit le dépôt',
      checking: 'Vérification de la marque',
      fixing: 'Claude corrige ce que la vérification a trouvé',
      checkingAgain: 'Nouvelle vérification',
      unfinished: 'Claude n’a pas pu terminer la marque.',
    },
    check: {
      missing: (file: string) => `${file} manquant`,
      invalidJson: (error: string) => `brand.json n’est pas du JSON valide : ${error}`,
      wrongId: (found: string, id: string) => `brand.json : id « ${found} » au lieu de « ${id} » (le nom du dossier)`,
      empty: (key: string) => `brand.json : ${key} est vide`,
      url: 'brand.json : url doit être un texte',
      language: 'brand.json : language doit valoir "fr" ou "en"',
      unknownColors: (extra: string, known: string) => `brand.json : couleurs inconnues ${extra} (seulement ${known})`,
      hex: (key: string) => `brand.json : colors.${key} doit être un hex #rrggbb en minuscules`,
      preload: (face: string) => `brand.json : preload « ${face} » doit ressembler à "700 32px 'Famille'"`,
      preloadUnused: (family: string) => `brand.json : la police préchargée ${family} n’est dans aucune pile`,
      radius: 'brand.json : radius.sm, md, lg et xl doivent être ≥ 0',
      radiusOrder: 'brand.json : il faut radius.sm ≤ md ≤ lg ≤ xl',
      logoOutside: (key: string) => `brand.json : logo.${key} doit rester dans le dossier de la marque`,
      logoMissing: (key: string, file: string) => `logo.${key} introuvable : ${file}`,
      logoSvg: (key: string) => `logo.${key} doit être un SVG qui commence par <svg \u2026 viewBox>`,
      logoExternal: (key: string) => `logo.${key} doit se suffire à lui-même (ni script, ni lien externe, ni <image>)`,
      note: (file: string) => `${file} doit être rédigé (plus de 400 caractères)`,
      kitSheet: (error: string) => `Planche du kit : ${error}`,
      compile: (error: string) => `index.tsx ne compile pas : ${error}`,
      themeLine: (line: string) => `theme.css : il manque ${line}`,
      themeColor: (token: string, value: string | undefined) => `theme.css : ${token} doit valoir ${value} comme brand.json`,
      themeFont: (token: string) => `theme.css : ${token} doit être identique à brand.json`,
      themeRadius: (token: string, value: string) => `theme.css : ${token} doit valoir ${value}`,
      notInstalled: (spec: string) =>
        `theme.css : ${spec} n’est pas installé dans Cadence (copiez la police dans fonts/ à la place)`,
      themeFile: (file: string) => `theme.css : ${file} introuvable`,
      fontNotLoaded: (where: string, name: string) => `${where} nomme la police « ${name} », que theme.css ne charge jamais`,
    },
    fonts: {
      invalidName: (family: string) => `Nom de police invalide : ${family}`,
      unknown: (name: string) => `Google Fonts ne connaît pas la police « ${name} »`,
      noFile: (name: string) => `Google Fonts n’a renvoyé aucun fichier pour « ${name} »`,
      refused: (name: string, status: number) => `Téléchargement de ${name} refusé par Google Fonts (HTTP ${status})`,
      down: (status: number) => `Google Fonts ne répond pas (HTTP ${status})`,
    },
    source: {
      copyFailed: (repo: string, error: string) => `Impossible de copier ${repo} : ${error}`,
    },
  },
  doctor: {
    title: 'Cadence \u2014 vérification de l’environnement',
    editor: 'éditeur',
    frames: 'images',
    failed: (count: number) => `${count} problème${count > 1 ? 's' : ''} à corriger, puis relancez \`npm run doctor\`.`,
    ready: (origin: string) => `Tout est prêt. Lancez \`npm start\`, puis ouvrez ${origin}`,
    readyBusy: (origin: string) =>
      `Cadence tourne peut-être déjà : ouvrez ${origin}. Sinon, lancez \`npm start -- --port 5320 --frame-port 5321\``,
    nodeOld: (version: string) => `Node.js ${version} est trop ancien`,
    nodeFix: 'Installez Node.js 22.12 ou plus récent',
    ffmpegMissing: (bin: string) => `ffmpeg introuvable (${bin})`,
    ffmpegFix: 'macOS : `brew install ffmpeg` \u00b7 Debian/Ubuntu : `sudo apt install ffmpeg` \u00b7 ou définissez FFMPEG_PATH',
    encoders: (version: string, missing: string[]) => `ffmpeg ${version} sans encodeur ${missing.join(' ni ')}`,
    encodersFix: 'Installez une version de ffmpeg avec libx264 et aac (par exemple `brew install ffmpeg`)',
    ffprobeMissing: (bin: string) => `ffprobe introuvable (${bin})`,
    ffprobeFix: 'Il est fourni avec ffmpeg \u00b7 ou définissez FFPROBE_PATH',
    chromiumMissing: "Chromium (Playwright) n'est pas installé",
    chromiumFailed: (error: string) => `Chromium ne démarre pas : ${error}`,
    chromiumLibraries: 'Installez ses bibliothèques système : `npm run setup -- --with-deps`',
    claudeMissing: (bin: string) => `Claude Code introuvable (${bin})`,
    claudeInstall:
      'Installez Claude Code (https://code.claude.com), lancez `claude` puis /login \u00b7 ou définissez CLAUDE_PATH',
    claudeReady: (version: string, login: string | undefined) => `Claude Code ${version}${login ? ` : ${login}` : ''}`,
    claudeLoggedOut: (version: string) => `Claude Code ${version} n'est pas connecté`,
    claudeLogin: 'Lancez `claude` dans un terminal puis /login',
    piperReady: 'Piper (voix off)',
    piperMissing: (bin: string) => `Piper introuvable (${bin}) : sans lui, pas de voix off`,
    piperFix: '`pipx install piper-tts` (Python 3.9 ou plus), ou indiquez son chemin dans PIPER_PATH',
    portFree: (port: number, role: string) => `Port ${port} (${role}) libre`,
    portBusy: (port: number, role: string) => `Port ${port} (${role}) déjà utilisé (Cadence tourne peut-être déjà)`,
    portFix: (variable: string) =>
      `Arrêtez l'autre programme ou choisissez un autre port (${variable}, ou --port / --frame-port avec \`npm start --\`)`,
  },
  config: {
    locale: (value: string) => `CADENCE_LOCALE invalide : ${value} (par exemple fr-FR ou en-US)`,
    port: (name: string, value: string) => `${name} invalide : ${value} (port de 0 à 65535)`,
    effort: (value: string, values: string) => `CADENCE_EFFORT invalide : ${value} (valeurs : ${values})`,
  },
  cli: {
    help: `Cadence \u2014 studio de motion design piloté par prompts

Usage : npm run cadence -- <commande> [options]

  start [--port 5310] [--frame-port 5311] [--dev]
                                               démarre l'éditeur (--dev : depuis le serveur de dev de Vite, pour travailler sur Cadence)
  render <projet> [--formats 16:9,9:16] [--quality draft|standard|master]
         [--scale 0.5|1|2] [--fps 24|30|60] [--supersample]
                                               exporte la vidéo en MP4 (tous les formats du projet par défaut)
  analyze <audio> [--json]                     analyse une musique (tempo, temps, mesures, phrases)
  soundtracks [ambiance\u2026]                      recompose les ambiances du panneau Musique (src/editor/soundtracks)
  new <nom> [--brand <id>] [--template <id>] [--formats 16:9,9:16] [--fps 60]
                                               crée un projet
  list                                         liste les projets
  doctor                                       vérifie l'environnement (Node, ffmpeg, Chromium, Claude Code)
  mcp [--port 5310]                            affiche la commande qui branche Claude Code sur Cadence
`,
    unknownCommand: (command: string) => `Commande inconnue : ${command}`,
    stopping: 'Arrêt de Cadence\u2026',
    noProject: 'Précisez le projet à exporter : render <projet>',
    unknownQuality: (quality: string) => `Qualité inconnue : ${quality}`,
    progress: (jobs: { format: string; percent: number }[]) =>
      jobs.map((job) => `${job.format} ${job.percent} %`).join(' \u00b7 '),
    exporting: (name: string, duration: string, formats: string, quality: string) =>
      `Export de « ${name} » (${duration}) : ${formats}, qualité ${quality}`,
    done: (format: string, file: string) => `✓ ${format} \u2192 ${file}`,
    failed: (format: string, reason: string) => `✗ ${format} : ${reason}`,
    cancelled: 'annulé',
    failure: 'échec',
    noAudio: 'Précisez le fichier audio : analyze <audio>',
    noName: 'Précisez le nom du projet : new <nom>',
    versionNotSaved: (error: string) => `Version initiale non enregistrée : ${error}`,
    scenes: (count: number) => `${count} scène${count > 1 ? 's' : ''}`,
    created: (name: string, scenes: string, dir: string) => `Projet « ${name} » créé (${scenes}) : ${dir}`,
    empty: 'Aucun projet. Créez-en un : npm run cadence -- new "Mon projet"',
    mcp: 'Pour utiliser les outils Cadence depuis Claude Code dans un terminal (Cadence doit tourner) :',
    parseErrors: {
      ERR_PARSE_ARGS_UNKNOWN_OPTION: (option: string) => `Option inconnue : ${option}`,
      ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: (argument: string) => `Argument inattendu : ${argument}`,
      ERR_PARSE_ARGS_INVALID_OPTION_VALUE: (option: string) => `Valeur manquante ou invalide pour : ${option}`,
    },
    invalidPort: (value: string) => `Port invalide : ${value}`,
    unknownFormat: (format: string, known: string) => `Format inconnu : ${format} (${known})`,
  },
};

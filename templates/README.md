# Modèles Cadence

Deux familles de modèles vivent ici :

- `scenes/<id>/` : des **modèles de scène**, insérés un par un dans un projet (bouton « Ajouter une scène », outil
  MCP `create_scene`) ;
- `projects/<id>/` : des **modèles de campagne**, qui créent un projet entier (une suite de modèles de scène, un
  tempo, des formats et une direction artistique).

Un modèle est copié dans le projet au moment de l'insertion : le projet ne dépend plus du modèle ensuite. On
personnalise la copie, jamais le modèle, sauf pour améliorer la bibliothèque.

## Contrat d'un modèle de scène

`template.json` (lu par `server/store/templates.ts`, type `SceneTemplateMeta`) :

| Champ | Rôle |
| --- | --- |
| `name` | Nom affiché dans l'éditeur, en français. |
| `description` | Ce que la scène montre, **et sa première et sa dernière image** (« Commence sur... », « finit sur... »). |
| `category` | `intro`, `title`, `ui`, `feature`, `data`, `transition` ou `outro`. |
| `bars` | Longueur par défaut en mesures (4 temps) ; convertie en secondes au tempo du projet. |
| `formats` | Formats où la mise en page est soignée (tous les modèles actuels couvrent 16:9, 9:16, 1:1 et 4:5). |
| `tags` | Mots-clés de recherche. |
| `customize` | Ce qu'il faut adapter après l'insertion (constantes à modifier). |

`scene.tsx` suit le contrat des scènes (`ARCHITECTURE.md`, `src/runtime/API.md`) :

- un `export default function`, pure fonction de ses props : pas d'état, d'effet, de minuterie, de
  `Math.random()`, de `Date.now()`, de transition ou d'animation CSS, de réseau ;
- n'importe que `react` et `cadence` (un modèle doit fonctionner sans le dossier `components/` d'un projet) ;
- ne s'habille qu'avec la marque : `props.brand` / `useBrand()` (couleurs, polices, rayons, `Logo`, composants
  `ui`, textes `copy`) ; les composants vitrine (`brand.extras`) sont optionnels, toujours avec un repli
  (`EXTRA` dans `phone-showcase` et `browser-showcase`) ;
- se met en page pour chaque format avec `useFormat().pick(...)`, garde texte et interface dans `useFormat().safe`,
  et **recompose** le portrait (empilé, texte plus grand) au lieu de réduire le paysage ;
- cale ses temps forts sur la musique : les durées sont en temps (`music.beat(n)`), les fins se comptent depuis la
  fin de la scène (`duration - n * music.beatLength`), les arrivées tombent sur les temps forts ;
- commence et finit sur une image « de raccord » documentée : le fond de la marque, ou une pose nommée partagée
  par les scènes qui se suivent (voir plus bas).

### Constantes en tête de fichier

L'agent de l'éditeur personnalise un modèle en changeant ses constantes, commentées en une ligne :

- `COPY` : le texte à l'écran, par langue (`fr`, `en`), choisi avec `brand.language` ; `{name}` est remplacé par
  le nom de la marque. Quand c'est possible, le modèle utilise le texte réel de la marque (`brand.tagline`,
  `brand.copy.taglines`, `brand.copy.features`) ;
- `TIMING` : les moments clés, en temps musicaux depuis le début de la scène (ou avant sa fin quand c'est dit) ;
- `LAYOUT` (ou `POSES`, `STAGE`, `LABELS`...) : positions et tailles par format ;
- parfois `EXTRA`, `SEQUENCE`, `COLUMNS`, `CODE`... : le contenu propre au modèle.

Typographie française dans les textes : « guillemets », espace avant `:` `;` `!` `?`, `12,5 %`. Dans le code,
jamais d'espace insécable invisible : écrire `'\u00a0'` ou `'\u202f'`.

## Raccords invisibles

Deux scènes se raccordent sans coupure visible quand la dernière image de l'une est identique, au pixel près, à la
première de l'autre (`check_seams` mesure l'écart : 0 % = invisible). Chaque modèle déclare ses deux extrémités :

| Modèle | Première image | Dernière image |
| --- | --- | --- |
| `wireframe-glow` | noir complet | pose « hero » |
| `exploded-anatomy` | pose « hero » | pose « titled » (titre A) |
| `variant-pills` | pose « titled » (titre A) | pose « titled » (titre B) |
| `surface-grid` | pose « titled » (titre B) | pose « hero » |
| `zoom-annotate` | pose « hero » | pose « hero » |
| `cursor-demo` | pose « hero » | fond |
| `full-bleed`, `title-reveal`, `feature-list`, `stat-counters`, `chart-draw`, `phone-showcase`, `browser-showcase`, `code-typing`, `quote-testimonial` | fond | fond |
| `logo-build`, `cta-end` | fond | image finale (fin de vidéo) |

- **Fond** : le fond uni de la marque (`Backdrop`). Deux scènes qui finissent et commencent sur le fond se
  raccordent toujours.
- **Pose « hero »** : la carte de profil seule, centrée. **Pose « titled »** : un titre d'une ligne en haut et la
  carte dessous. Les titres s'enchaînent mot à mot : le `COPY.from` d'une scène reprend le titre de la précédente.

### Blocs partagés

Pour que ces poses soient identiques d'une scène à l'autre, le code qui les dessine est **recopié à l'identique**
en bas de chaque `scene.tsx` :

- `// Shared by every template` : le fond (`Backdrop`) et la graisse des titres (`displayWeight`), dans tous
  les modèles ;
- `// Shared by the teaser templates` : les poses (`POSES`), le titre (`Headline`) et la carte héros (`CARD`,
  `CARD_COPY`, `ProfileCard`, ses variantes), dans les six modèles qui la montrent.

Les tests vérifient que ces blocs sont identiques partout : toute modification se fait dans tous les modèles à la
fois. Dans un projet, mieux vaut déplacer ces blocs dans `components/` et les importer depuis chaque scène.

## Contrat d'un modèle de campagne

`template.json` (type `ProjectTemplateMeta`) : `name`, `description`, `fps` (24, 30 ou 60), `formats`, `bpm` (le
tempo qui convertit les mesures en secondes tant qu'il n'y a pas de musique) et `scenes` (`template`, `name`,
`bars`). `art-direction.md` est ajouté sous la direction artistique de la marque : il commence par un titre `##`,
décrit la structure, ce qu'il faut adapter dès la création, le rythme et les raccords.

| Campagne | Durée | Formats | Scènes |
| --- | --- | --- | --- |
| `teaser-produit` | ≈ 46 s à 145 BPM | 16:9, 9:16 | filaire, anatomie, styles, surfaces, géométrie, curseur, plein cadre, logo |
| `lancement-fonctionnalite` | 20 s à 120 BPM | 16:9, 9:16, 1:1 | titre, navigateur, bénéfices, appel à l'action |
| `reseaux-sociaux-vertical` | 15 s à 144 BPM | 9:16, 4:5 | titre, mobile, chiffres, appel à l'action |
| `nouveautes` | 30 s à 120 BPM | 16:9, 1:1 | titre, nouveautés, navigateur, graphique, témoignage, appel à l'action |

Une campagne n'utilise que des modèles qui déclarent tous ses formats, et enchaîne des extrémités compatibles.

## Ajouter un modèle

1. Créer `scenes/<id>/` (identifiant en kebab-case) avec `template.json` et `scene.tsx`.
2. Partir d'un modèle proche ; garder les constantes en tête et les blocs partagés en bas.
3. Vérifier chaque format avec plusieurs marques, à plusieurs instants, en taille réelle : hiérarchie, marges,
   tailles de texte, coupures, contraste, zones de sécurité, fidélité à la marque.
4. Lancer les tests.

## Tester

```bash
node --import tsx --test tests/templates/templates.test.tsx   # métadonnées, campagnes, règles, rendu
npx tsc --noEmit -p tsconfig.json                              # types
```

Les tests rendent chaque modèle pour chaque marque de `brands/`, chaque format déclaré et plusieurs instants
(`react-dom/server`, comme la page d'image : `createMusic`, `SceneContext`, `BrandContext`), vérifient que le rendu
est déterministe, que les campagnes sont cohérentes et que les blocs partagés sont identiques.

Pour regarder le résultat : créer un projet depuis une campagne
(`npm run cadence -- new "Teaser" --brand cadence --template teaser-produit --formats 16:9,9:16`), l'ouvrir dans
l'éditeur, puis demander au chat de rendre des images (`render_frames`) et de vérifier les raccords
(`check_seams`), ou exporter la vidéo (`npm run cadence -- render <projet> --quality draft`).

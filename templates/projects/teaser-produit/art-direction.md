## Campagne : teaser produit

Un seul objet raconte toute la vidéo : la carte héros (un profil construit avec le kit de la marque). Chaque scène
la montre sous un autre angle ; le public doit sentir un plan-séquence, pas un diaporama.

### Structure (en mesures)

| Scène | Mesures | Idée | Première image → dernière image |
| --- | --- | --- | --- |
| Filaire | 4 | Le plan de la carte se dessine dans le noir, la caméra se redresse | noir → carte seule au centre |
| Anatomie | 2 | La carte s'éclate en couches légendées | carte seule → titre + carte |
| Chaque style | 2 | Un style par temps, balayage de gauche à droite | titre + carte → titre + carte |
| Chaque surface | 3 | Les styles côte à côte, puis sur des fonds du clair au sombre | titre + carte → carte seule |
| Géométrie | 6 | Trois plans rapprochés : coins concentriques, alignement, marges | carte seule → carte seule |
| En direct | 4 | Un curseur tape et enregistre, le titre change de mots | carte seule → fond seul |
| Plein cadre | 3 | Une image passe de la carte au plein cadre et revient | fond seul → fond seul |
| Logo | 4 | Point, symbole, logotype, adresse | fond seul → logo (fin) |

### À adapter dès la création

- Chaque style, Chaque surface : les cinq styles de la carte (Encart, Pleine largeur, Divisée, Séparée, Sans bord)
  sont ceux de la carte Flux qui a inspiré ce teaser. Les remplacer par les vraies variantes du composant de la marque
  (voir ses notes) : `VARIANTS`, `SEQUENCE`, `COLUMNS`, `COPY.labels`, et leur dessin dans `CardShell`. Ne jamais
  inventer une variante que le produit n'a pas : s'il n'en a que deux, n'en montrer que deux.

### Raccords

- Les coupes sont invisibles : la dernière image d'une scène est identique, au pixel près, à la première de la
  suivante. Les poses partagées (« hero » : la carte seule au centre ; « titled » : le titre en haut et la carte
  dessous) sont définies en bas de chaque scène (`POSES`, `CARD`, `CARD_COPY`, `ProfileCard`).
- Toute retouche de la carte, de sa géométrie ou de son texte se fait dans toutes les scènes qui la montrent (ou dans
  `components/`, importé par chacune) ; vérifier ensuite avec `check_seams`.
- Les titres s'enchaînent mot à mot : le `from` de chaque scène reprend le titre de la précédente.

### Rythme

- Les temps forts tombent sur les temps et les mesures (`music.beat`, `music.bar`) : un style par temps, la carte se
  pose sur une mesure, le logo sur la première mesure de sa scène.
- Mouvements de caméra lents et doux (`ease.inOutCubic`), entrées décélérées, sorties plus courtes que les entrées.
- L'accent de la marque sert aux annotations, aux curseurs de saisie et au mot qui change dans un titre : jamais aux
  surfaces.

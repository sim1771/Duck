# 🦆 Cadastre Chasse

Outil web mobile pour identifier **le propriétaire d'un champ** à partir de ta
**position GPS en temps réel** — pratique à la chasse à l'oie/au canard pour
savoir à qui demander la permission d'accès.

Tu ouvres la page sur ton téléphone, tu vois ta position sur une carte
satellite, tu appuies sur **« Propriétaire ici »** (ou tu tapes sur un champ) et
l'application affiche le **nom du propriétaire**, l'adresse, le matricule et la
valeur foncière de la parcelle.

## Fonctionnalités

- 📍 **GPS en temps réel** avec mode « me suivre »
- 🛰️ Fonds de carte **Satellite** (Esri) et **Rue** (OpenStreetMap)
- 🔍 **Barre de recherche** : colle un **lien Google Maps** (même un lien court
  `maps.app.goo.gl`) ou des **coordonnées** (`48.385, -71.676`) pour aller
  directement à un endroit reçu d'un partenaire
- 🎯 **Parcelle sous ta position** en un bouton, ou **tape n'importe où** sur la carte
- 👤 Nom du/des **propriétaire(s)**, adresse civique, **matricule**, valeurs foncières
- 🏛️ Bouton **« Rôle actuel »** : ouvre le **rôle d'évaluation en ligne** de la
  municipalité (propriétaire **à jour**) et copie l'adresse à coller dans la
  recherche — utile là où les données locales sont anciennes
- 📮 **Adresse postale** du propriétaire (quand disponible) pour le contacter
- 📞 Bouton **« Numéro »** : recherche du téléphone dans l'annuaire public
  Canada411, pré-remplie avec le nom et la ville du propriétaire
- 🧭 Lien direct **Google Maps** + bouton **copier** les infos
- 📦 **Aucune dépendance CDN** : Leaflet est fourni localement (`vendor/`)

## Comment ça marche

Les données proviennent des cartes publiques **ArcGIS** des MRC (couche
« Matrice graphique des municipalités »). Deux types de sources sont supportés :

- **Source en ligne** (`type` non défini) : l'application interroge un service
  ArcGIS en temps réel avec ta position et récupère la parcelle.
- **Source locale** (`type: "local"`) : quand une MRC ne publie pas de service
  interrogeable, ses parcelles sont **extraites et fournies avec l'application**
  (dossier `data/`). La recherche « point dans polygone » se fait alors
  **directement sur l'appareil** — pratique quand le réseau est faible.

MRC actuellement incluses :

| MRC | Type | Données | Couverture |
|---|---|---|---|
| **MRC du Domaine-du-Roy** | en ligne | **mars 2025** (à jour) | secteur Roberval / Saint-Félicien |
| **MRC de Lac-Saint-Jean-Est** | locale (`data/ljse/`) | **2018** ⚠️ | Alma, Métabetchouan-Lac-à-la-Croix, Hébertville, Hébertville-Station, Saint-Gédéon, Saint-Bruno, Saint-Nazaire, Desbiens, L'Ascension… (~15 000 parcelles) |

> ⚠️ **Fraîcheur des données.** Chaque source affiche sa date dans le panneau de
> résultat. Les données de **Lac-Saint-Jean-Est datent de 2018** (seule version
> publique disponible) : le propriétaire affiché peut être périmé de plusieurs
> ventes. Le bouton **« Rôle actuel »** ouvre le rôle d'évaluation en ligne de la
> municipalité (plateforme ACCEO Immonet) pour confirmer le **propriétaire
> actuel** ; l'adresse est copiée automatiquement pour la coller dans la
> recherche.

Pour Lac-Saint-Jean-Est, seul le fichier du secteur où tu te trouves est
téléchargé (repéré via les « boîtes englobantes » dans `data/ljse/index.json`),
donc l'app reste légère.

> ⚠️ Les informations affichées proviennent du **rôle d'évaluation foncière**
> public. Elles peuvent contenir des erreurs ou être périmées. Demande toujours
> la permission avant d'entrer sur une terre privée.

> ☎️ **Numéro de téléphone :** il n'existe dans *aucun* jeu de données cadastral
> (le rôle ne contient que le nom et l'adresse postale). Le bouton « Numéro »
> ouvre simplement une recherche dans l'**annuaire public Canada411** avec le nom
> et la ville du propriétaire — les résultats ne sont pas garantis (numéro non
> listé, homonymes, etc.).

## Utilisation

### En local
Ouvre simplement `index.html`. Sur téléphone, sers le dossier en HTTPS
(le GPS exige un contexte sécurisé — `https://` ou `localhost`).

```bash
# Exemple de serveur local
python3 -m http.server 8080
# puis visite http://localhost:8080
```

### Hébergement gratuit (GitHub Pages)
1. Pousse ce dépôt sur GitHub.
2. **Settings → Pages → Deploy from branch** → branche `main` (ou celle-ci), dossier `/root`.
3. Ouvre l'URL fournie sur ton téléphone. GitHub Pages sert en HTTPS → le GPS
   fonctionne.

## Ajouter une autre MRC

Chaque MRC a sa propre couche cadastrale. Tout se configure dans
[`js/config.js`](js/config.js) :

1. Trouve l'URL du **FeatureServer** de la MRC (ex. `.../FeatureServer/0`).
   Astuce : ouvre l'URL avec `?f=json` pour vérifier le **nom exact des champs**.
2. Ajoute (ou complète) un bloc dans `CADASTRE_SOURCES` avec l'`url` et la
   correspondance des champs (`fields`), puis mets `enabled: true`.

L'application interroge **toutes les sources activées** et affiche la première
qui contient une parcelle sous ton point — pas besoin de choisir la MRC
manuellement.

Une deuxième MRC est déjà pré-remplie (`id: "mrc-2"`, désactivée) : il ne reste
qu'à y coller l'URL du FeatureServer.

## Structure

```
index.html          Page principale
css/style.css       Styles (interface mobile)
js/config.js        Sources cadastrales par MRC (à personnaliser)
js/app.js           Logique : carte, GPS, requêtes, affichage
vendor/leaflet/     Librairie de carte Leaflet (locale, sans CDN)
```

## Recherche par lien Google Maps

La barre de recherche accepte :

- des **coordonnées** (`48.385, -71.676`) — traitées instantanément, sans réseau ;
- un **lien Google Maps complet** contenant déjà les coordonnées (`@lat,lng`,
  `?q=lat,lng`, etc.) — sans réseau ;
- un **lien court** `maps.app.goo.gl` / `goo.gl/maps` — développé via le service
  public [unshorten.me](https://unshorten.me) (CORS ouvert) pour en extraire les
  coordonnées, puis lancer la recherche de parcelle.

> Les liens courts dépendent d'un service tiers en ligne. S'il est indisponible,
> ouvre le lien dans Google Maps puis colle le **lien complet** ou les
> **coordonnées** — ces deux formes fonctionnent sans aucun service externe.

## Limites connues

- Les **tuiles de carte** nécessitent une connexion (pas de mode 100 % hors ligne).
- La couverture dépend des MRC configurées dans `config.js`.
- La précision GPS varie selon l'appareil et l'environnement.

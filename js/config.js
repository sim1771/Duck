// ---------------------------------------------------------------------------
// Configuration des sources cadastrales (une par MRC)
// ---------------------------------------------------------------------------
// Chaque source pointe vers une couche ArcGIS "FeatureServer" contenant les
// parcelles avec le nom du propriétaire. L'application interroge toutes les
// sources activées et affiche la première qui retourne une parcelle sous le
// point demandé.
//
// Pour ajouter une nouvelle MRC :
//   1. Trouver l'URL du FeatureServer (ex. .../FeatureServer/0)
//   2. Vérifier le nom exact des champs (ouvrir l'URL + "?f=json" dans le navigateur)
//   3. Copier un bloc ci-dessous et ajuster "url" + "fields"
// ---------------------------------------------------------------------------

const CADASTRE_SOURCES = [
  {
    id: "mrc-ddr",
    name: "MRC du Domaine-du-Roy",
    // Couche "Matrice graphique des municipalités" – contient le propriétaire.
    url:
      "https://services.arcgis.com/u17rFbPcC1ozsiJ0/arcgis/rest/services/" +
      "Matrice_graphique_des_municipalit%C3%A9s/FeatureServer/0",
    enabled: true,
    // Fraîcheur des données (voir editingInfo du service).
    dataDate: "mars 2025",
    stale: false,
    // Correspondance des champs de CETTE couche vers les champs génériques
    // utilisés par l'application. Mettre à null si un champ n'existe pas.
    fields: {
      owner1: "Nom_Prop1",
      owner2: "Nom_Prop2",
      matricule: "No_Matricu",
      civicLow: "No_Civ_Inf",
      civicHigh: "No_Civ_Sup",
      street: "Nom_Voie",
      valueLand: "Valeur_Ter",
      valueBuilding: "Valeur_Bat",
      valueTotal: "Valeur_Imm",
      lot: null,
    },
  },

  // -------------------------------------------------------------------------
  // Deuxième MRC — à compléter avec l'URL réelle du FeatureServer.
  // Laisser "enabled: false" tant que l'URL n'est pas confirmée.
  // -------------------------------------------------------------------------
  {
    id: "mrc-lsje",
    name: "MRC de Lac-Saint-Jean-Est",
    // Source "locale" : les données sont fournies avec l'application
    // (dossier data/ljse/) car cette MRC n'offre pas de service à interroger.
    // La recherche se fait directement sur l'appareil (fonctionne même avec
    // une connexion faible une fois le secteur chargé).
    type: "local",
    indexUrl: "data/ljse/index.json",
    enabled: true,
    // ⚠️ La carte publique source date de 2018 et n'a jamais été mise à jour.
    // Les propriétaires peuvent avoir changé depuis. Vérifier au rôle municipal.
    dataDate: "2018",
    stale: true,
    // Les attributs sont déjà normalisés lors de l'extraction : correspondance
    // identité.
    fields: {
      owner1: "owner1",
      owner2: "owner2",
      matricule: "matricule",
      civicLow: "civicLow",
      civicHigh: "civicHigh",
      street: "street",
      valueLand: "valueLand",
      valueBuilding: "valueBuilding",
      valueTotal: "valueTotal",
      lot: null,
      // Adresse postale du propriétaire + ville (pour le contacter / annuaire).
      mailAddr: "mailAddr",
      mailCity: "mailCity",
      mun: "mun",
    },
  },
];

// Rayon de recherche (mètres) autour du point tapé/GPS. Utile quand le point
// tombe dans un chemin ou un fossé entre deux parcelles.
const SEARCH_TOLERANCE_METERS = 8;

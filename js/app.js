/* ==========================================================================
 * Cadastre Chasse — trouver le propriétaire d'un champ depuis sa position GPS
 * ========================================================================== */

// ---- Carte -----------------------------------------------------------------
const map = L.map("map", {
  zoomControl: false,
  attributionControl: true,
}).setView([46.65, -71.0], 9); // Chaudière-Appalaches par défaut

L.control.zoom({ position: "topright" }).addTo(map);

const basemaps = {
  satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Esri, Maxar, Earthstar Geographics" }
  ),
  rue: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  }),
};
let currentBasemap = "satellite";
basemaps.satellite.addTo(map);

// ---- État ------------------------------------------------------------------
let gpsMarker = null;
let accuracyCircle = null;
let lastFix = null;        // { lat, lng, accuracy }
let followMode = true;
let parcelLayer = null;    // polygone surligné
let watchId = null;

// ---- Éléments UI -----------------------------------------------------------
const el = (id) => document.getElementById(id);
const primaryBtn = el("primaryBtn");
const followFab = el("followFab");
const basemapChip = el("basemapChip");
const sheet = el("sheet");
const toastEl = el("toast");

// ---- Utilitaires -----------------------------------------------------------
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), ms);
}

function setBusy(busy) {
  primaryBtn.disabled = busy;
  primaryBtn.innerHTML = busy
    ? '<span class="spinner"></span> Recherche…'
    : '<span>🎯</span> Propriétaire ici';
}

function fmtMoney(v) {
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  if (!v || Number.isNaN(n) || n === 0) return null;
  return n.toLocaleString("fr-CA") + " $";
}

function cleanVal(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s.toUpperCase() === "NULL" ? null : s;
}

// Numéro civique : "0" signifie "aucune borne" -> traité comme absent.
function cleanCivic(v) {
  const s = cleanVal(v);
  return !s || s === "0" ? null : s;
}

// Mots indiquant une personne morale (entreprise, organisme) : on ne réordonne
// pas le nom dans ce cas.
const COMPANY_WORDS = /\b(INC|LT[EÉ]E|LTD|ENR|SENC|CIE|FERME|FERMES|GOUVERNEMENT|MUNICIPALIT[EÉ]|VILLE|SUCCESSION|CLUB|COOP|FIDUCIE|GESTION|IMMEUBLES?|IMMOBILIERE?|CONSTRUCTION|TRANSPORTS?|PLACEMENTS?|HYDRO|MRC|COMMISSION|FABRIQUE|PAROISSE|SOCI[EÉ]T[EÉ]|ENTREPRISES?|9\d{3})\b/i;

// Le rôle inscrit les noms "NOM Prénom". Pour un annuaire on veut "Prénom Nom".
function ownerToDirectoryName(owner) {
  if (!owner) return null;
  const clean = owner.replace(/\s+/g, " ").trim();
  if (COMPANY_WORDS.test(clean)) return clean; // entreprise -> tel quel
  const parts = clean.split(" ");
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`; // NOM Prénom -> Prénom Nom
  return clean;
}

// Nettoie la ville de correspondance ("ALMA (QUEBEC)", "ALMA, QC." -> "ALMA").
function cleanTown(v) {
  const s = cleanVal(v);
  if (!s) return null;
  const town = s.split(/[(,]/)[0].trim();
  return town || null;
}

// Normalise un nom de municipalité en identifiant d'URL (sans accents).
function normalizeMun(s) {
  if (!s) return null;
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['''’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Lien vers le rôle d'évaluation en ligne de la municipalité (si connue).
function rollUrl(source, mun) {
  const r = source.roll;
  if (!r) return null;
  const slug = normalizeMun(mun);
  if (!slug || !r.towns.includes(slug)) return null;
  return r.base + slug + (r.query || "");
}

// Construit un lien de recherche Canada411 pré-rempli (nom + ville).
function directoryUrl(owner, town) {
  const name = ownerToDirectoryName(owner);
  if (!name) return null;
  let where = cleanTown(town) || "QC";
  if (!/\bQC\b/i.test(where)) where += " QC";
  const p = new URLSearchParams({ stype: "si", what: name, where });
  return "https://www.canada411.ca/search/?" + p.toString();
}

// ---- GPS -------------------------------------------------------------------
function startGps() {
  if (!("geolocation" in navigator)) {
    toast("GPS non disponible sur cet appareil");
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    onPosition,
    onPositionError,
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
}

function onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  lastFix = { lat, lng, accuracy };

  const latlng = [lat, lng];
  if (!gpsMarker) {
    gpsMarker = L.marker(latlng, {
      icon: L.divIcon({ className: "", html: '<div class="gps-dot"></div>', iconSize: [18, 18] }),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(map);
    accuracyCircle = L.circle(latlng, {
      radius: accuracy,
      color: "#2fa4ff",
      weight: 1,
      fillColor: "#2fa4ff",
      fillOpacity: 0.12,
    }).addTo(map);
    map.setView(latlng, 17);
  } else {
    gpsMarker.setLatLng(latlng);
    accuracyCircle.setLatLng(latlng).setRadius(accuracy);
  }
  if (followMode) map.panTo(latlng, { animate: true });
}

function onPositionError(err) {
  const msgs = {
    1: "Accès au GPS refusé. Autorise la localisation dans les réglages.",
    2: "Position indisponible.",
    3: "Délai GPS dépassé.",
  };
  toast(msgs[err.code] || "Erreur GPS");
}

// ---- Recherche par lien Google Maps / coordonnées --------------------------
// Extrait une paire lat/lng d'un texte : coordonnées brutes, ou URL contenant
// des coordonnées (q=, @lat,lng, !3d!4d, ll=, etc.). Aucun réseau requis.
function extractCoords(input) {
  if (!input) return null;
  const s = input.trim();
  let decoded = s;
  try { decoded = decodeURIComponent(s); } catch (_) {}
  const pats = [
    /[?&](?:q|query|ll|sll|daddr|destination)=(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/i,
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
    /(-?\d{1,3}\.\d{3,})[,\s]+(-?\d{1,3}\.\d{3,})/, // paire générique (3+ déc.)
  ];
  for (const c of [s, decoded]) {
    for (const p of pats) {
      const m = c.match(p);
      if (m) {
        const lat = parseFloat(m[1]);
        const lng = parseFloat(m[2]);
        if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          return { lat, lng };
        }
      }
    }
  }
  return null;
}

// Développe un lien court (maps.app.goo.gl, goo.gl/maps…) via unshorten.me
// (CORS ouvert) puis extrait les coordonnées de l'URL résolue.
async function resolveShortLink(url) {
  const api = "https://unshorten.me/json/" + encodeURIComponent(url);
  const res = await fetch(api);
  if (!res.ok) throw new Error("service d'expansion indisponible");
  const data = await res.json();
  if (!data.success || !data.resolved_url) throw new Error("lien non reconnu");
  const c = extractCoords(data.resolved_url);
  if (!c) throw new Error("coordonnées introuvables dans le lien");
  return c;
}

// Géocodage inverse : transforme des coordonnées en adresse approximative
// (route + municipalité). Utilisé quand la parcelle n'a pas d'adresse au rôle.
const reverseCache = {};
async function reverseGeocode(lat, lng) {
  const key = lat.toFixed(5) + "," + lng.toFixed(5);
  if (key in reverseCache) return reverseCache[key];
  let result = null;
  // 1) Nominatim (OpenStreetMap)
  try {
    const u =
      "https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1" +
      "&accept-language=fr&zoom=18&lat=" + lat + "&lon=" + lng;
    const r = await fetch(u);
    if (r.ok) {
      const a = (await r.json()).address || {};
      const road = a.road || a.hamlet || a.neighbourhood;
      const town = a.town || a.village || a.municipality || a.city || a.county;
      const line = [[a.house_number, road].filter(Boolean).join(" "), town].filter(Boolean);
      if (line.length) result = line.join(", ");
    }
  } catch (_) {}
  // 2) Photon (Komoot) en secours
  if (!result) {
    try {
      const r = await fetch("https://photon.komoot.io/reverse?lang=fr&lat=" + lat + "&lon=" + lng);
      if (r.ok) {
        const p = (((await r.json()).features || [])[0] || {}).properties || {};
        const road = p.street || p.name;
        const line = [[p.housenumber, road].filter(Boolean).join(" "), p.city || p.county].filter(Boolean);
        if (line.length) result = line.join(", ");
      }
    } catch (_) {}
  }
  reverseCache[key] = result;
  return result;
}

let searchMarker = null;
let lookupToken = 0; // identifie l'affichage courant (garde-fou pour l'async)

function goToSearch(lat, lng) {
  followMode = false;
  followFab.classList.remove("follow-on");
  if (searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.marker([lat, lng], {
    icon: L.divIcon({ className: "", html: '<div class="search-dot"></div>', iconSize: [20, 20] }),
    interactive: false,
    zIndexOffset: 900,
  }).addTo(map);
  map.setView([lat, lng], 17, { animate: true });
  el("searchInput").blur();
  lookupAt(lat, lng, "search");
}

async function handleSearch() {
  const raw = el("searchInput").value.trim();
  if (!raw) { toast("Colle un lien Google Maps ou des coordonnées"); return; }
  let coords = extractCoords(raw);
  try {
    if (!coords && /^https?:\/\//i.test(raw)) {
      toast("Lecture du lien…");
      coords = await resolveShortLink(raw);
    }
    if (!coords) {
      toast("Lien non reconnu. Essaie un lien Google Maps complet ou des coordonnées (ex. 48.385, -71.676).");
      return;
    }
    goToSearch(coords.lat, coords.lng);
  } catch (e) {
    toast("Impossible de lire ce lien (" + e.message + "). Ouvre-le puis colle le lien complet ou les coordonnées.");
  }
}

// ---- Sources locales (données fournies avec l'app) -------------------------
const localCache = {}; // { [source.id]: { index, files: { file: featureColl } } }

// Point dans un anneau (algorithme pair-impair / ray casting).
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Pair-impair sur TOUS les anneaux : gère les trous et les multi-parties.
function pointInFeature(lng, lat, feature) {
  const g = feature.geometry;
  if (!g) return false;
  const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  let inside = false;
  for (const poly of polys) {
    for (const ring of poly) {
      if (pointInRing(lng, lat, ring)) inside = !inside;
    }
  }
  return inside;
}

async function queryLocal(source, lat, lng) {
  let cache = localCache[source.id];
  if (!cache) {
    const idx = await (await fetch(source.indexUrl)).json();
    cache = localCache[source.id] = { index: idx, files: {} };
  }
  const base = source.indexUrl.replace(/[^/]*$/, ""); // dossier de l'index
  const tol = 0.0008; // ~90 m de marge sur les bbox
  const candidates = cache.index.layers.filter((l) => {
    const [x0, y0, x1, y1] = l.bbox;
    return lng >= x0 - tol && lng <= x1 + tol && lat >= y0 - tol && lat <= y1 + tol;
  });
  for (const layer of candidates) {
    if (!cache.files[layer.file]) {
      cache.files[layer.file] = await (await fetch(base + layer.file)).json();
    }
    const fc = cache.files[layer.file];
    for (const feat of fc.features) {
      if (pointInFeature(lng, lat, feat)) {
        return { source, feature: feat };
      }
    }
  }
  return null;
}

// ---- Requête cadastre ------------------------------------------------------
// Interroge une source ArcGIS pour la parcelle sous le point (lng/lat WGS84).
async function queryArcgis(source, lat, lng) {
  const geometry = { x: lng, y: lat, spatialReference: { wkid: 4326 } };
  const params = new URLSearchParams({
    f: "geojson",
    geometry: JSON.stringify(geometry),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    distance: String(SEARCH_TOLERANCE_METERS),
    units: "esriSRUnit_Meter",
    resultRecordCount: "1",
  });
  const url = `${source.url}/query?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Erreur du service");
  if (!data.features || data.features.length === 0) return null;
  return { source, feature: data.features[0] };
}

function querySource(source, lat, lng) {
  return source.type === "local"
    ? queryLocal(source, lat, lng)
    : queryArcgis(source, lat, lng);
}

// Interroge toutes les sources activées ; retourne la première qui répond.
async function findParcel(lat, lng) {
  const sources = CADASTRE_SOURCES.filter(
    (s) => s.enabled && (s.url || s.type === "local")
  );
  if (sources.length === 0) {
    throw new Error("Aucune source cadastrale configurée");
  }
  const results = await Promise.allSettled(
    sources.map((s) => querySource(s, lat, lng))
  );
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  // Si toutes ont échoué (et non "aucun résultat"), remonter l'erreur.
  const firstErr = results.find((r) => r.status === "rejected");
  if (firstErr) throw firstErr.reason;
  return null;
}

// ---- Affichage du résultat -------------------------------------------------
function showParcel(result, queriedLatLng) {
  const { source, feature } = result;
  const a = feature.properties || {};
  const f = source.fields;
  const get = (key) => (f[key] ? cleanVal(a[f[key]]) : null);

  // Surligner la parcelle
  if (parcelLayer) map.removeLayer(parcelLayer);
  parcelLayer = L.geoJSON(feature, {
    style: { color: "#f4a300", weight: 3, fillColor: "#f4a300", fillOpacity: 0.18 },
  }).addTo(map);

  // Cadrer sur la parcelle (sans casser le zoom si minuscule)
  try {
    const b = parcelLayer.getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 18 });
  } catch (_) {}

  // Propriétaire
  const owner1 = get("owner1");
  const owner2 = get("owner2");
  const owners = [owner1, owner2].filter(Boolean);
  el("sheetOwner").innerHTML = owners.length
    ? owners[0] + (owners[1] ? `<span class="sub">et ${owners[1]}</span>` : "")
    : "Propriétaire non indiqué";

  // Adresse
  const low = f.civicLow ? cleanCivic(a[f.civicLow]) : null;
  const high = f.civicHigh ? cleanCivic(a[f.civicHigh]) : null;
  const street = get("street");
  let civic = null;
  if (low && high && low !== high) civic = `${low}–${high}`;
  else civic = low || high;
  const address = [civic, street].filter(Boolean).join(" ");

  // Adresse postale du propriétaire (utile pour le contacter), si disponible.
  const mailAddr = get("mailAddr");
  const mailCity = get("mailCity");
  const mailFull = [mailAddr, cleanTown(mailCity)].filter(Boolean).join(", ");

  // Lignes de détails
  const rows = [];
  if (address) rows.push(["Adresse", address]);
  const matr = get("matricule");
  if (matr) rows.push(["Matricule", matr]);
  const lot = get("lot");
  if (lot) rows.push(["Lot", lot]);
  const updated = get("updated");
  if (updated) rows.push(["Mise à jour", updated]);
  if (mailFull) rows.push(["Adresse postale", mailFull]);
  const vTot = get("valueTotal") && fmtMoney(get("valueTotal"));
  if (vTot) rows.push(["Valeur (immeuble)", vTot]);
  const vTer = get("valueLand") && fmtMoney(get("valueLand"));
  if (vTer) rows.push(["Valeur (terrain)", vTer]);
  const vBat = get("valueBuilding") && fmtMoney(get("valueBuilding"));
  if (vBat) rows.push(["Valeur (bâtiment)", vBat]);

  el("sheetRows").innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="row"><span class="k">${k}</span><span class="v">${escapeHtml(
          v
        )}</span></div>`
    )
    .join("");

  // Si la parcelle n'a pas d'adresse au rôle, on tente une adresse approximative
  // par géocodage inverse (route + municipalité), ajoutée en haut une fois prête.
  const myToken = ++lookupToken;
  if (!address) {
    const [glat, glng] = queriedLatLng;
    reverseGeocode(glat, glng).then((approx) => {
      if (approx && myToken === lookupToken && sheet.classList.contains("open")) {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML =
          '<span class="k">Adresse (approx.)</span><span class="v">' +
          escapeHtml(approx) + "</span>";
        el("sheetRows").insertBefore(row, el("sheetRows").firstChild);
      }
    });
  }

  // Source + fraîcheur des données
  let srcHtml = "Source : " + escapeHtml(source.name);
  if (source.dataDate) srcHtml += " · Données&nbsp;: " + escapeHtml(source.dataDate);
  if (source.stale) {
    srcHtml +=
      '<span class="stale-warn">⚠️ Données anciennes — le propriétaire ' +
      "peut avoir changé. À confirmer au rôle municipal.</span>";
  }
  el("sheetSource").innerHTML = srcHtml;

  // Lien Google Maps vers le point interrogé
  const [qlat, qlng] = queriedLatLng;
  el("sheetGmaps").href = `https://www.google.com/maps?q=${qlat},${qlng}`;

  // Recherche du numéro de téléphone (annuaire public Canada411)
  const phoneBtn = el("sheetPhone");
  const dirUrl = directoryUrl(owner1, mailCity || get("mun"));
  if (dirUrl) {
    phoneBtn.href = dirUrl;
    phoneBtn.style.display = "";
  } else {
    phoneBtn.style.display = "none";
  }

  // Rôle d'évaluation municipal en ligne (propriétaire à jour). Le bouton est
  // un simple lien (comme « Carte »/« Numéro ») pour s'ouvrir de façon fiable.
  // On copie le terme de recherche (adresse, sinon matricule) sur pointerdown,
  // AVANT la navigation, de façon non bloquante.
  const rollBtn = el("sheetRoll");
  const rUrl = rollUrl(source, get("mun"));
  if (rUrl) {
    const searchTerm =
      address && !/non codifi/i.test(address) ? address : matr || address || "";
    rollBtn.href = rUrl;
    rollBtn.style.display = "";
    rollBtn.onpointerdown = () => {
      try {
        if (searchTerm) navigator.clipboard?.writeText(searchTerm);
      } catch (_) {}
      if (searchTerm) toast("Adresse copiée : « " + searchTerm + " » — colle-la dans la recherche du rôle");
    };
  } else {
    rollBtn.style.display = "none";
    rollBtn.onpointerdown = null;
  }

  // Copier le nom du proprio
  el("sheetCopy").onclick = () => {
    const txt = [owners.join(" et "), address, matr ? "Matricule " + matr : ""]
      .filter(Boolean)
      .join(" — ");
    navigator.clipboard?.writeText(txt).then(
      () => toast("Copié ✔"),
      () => toast("Copie impossible")
    );
  };

  openSheet();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function openSheet() { sheet.classList.add("open"); }
function closeSheet() {
  sheet.classList.remove("open");
  if (parcelLayer) { map.removeLayer(parcelLayer); parcelLayer = null; }
}

// ---- Recherche déclenchée --------------------------------------------------
async function lookupAt(lat, lng, sourceLabel) {
  setBusy(true);
  try {
    const result = await findParcel(lat, lng);
    if (!result) {
      toast(
        sourceLabel === "gps"
          ? "Aucune parcelle trouvée sous ta position (hors couverture ?)"
          : "Aucune parcelle à cet endroit"
      );
      return;
    }
    showParcel(result, [lat, lng]);
  } catch (e) {
    console.error(e);
    toast("Erreur : " + e.message);
  } finally {
    setBusy(false);
  }
}

// ---- Événements UI ---------------------------------------------------------
primaryBtn.addEventListener("click", () => {
  if (!lastFix) {
    toast("Position GPS pas encore disponible…");
    return;
  }
  followMode = true;
  followFab.classList.add("follow-on");
  lookupAt(lastFix.lat, lastFix.lng, "gps");
});

// Taper sur la carte = interroger ce point précis
map.on("click", (e) => {
  followMode = false;
  followFab.classList.remove("follow-on");
  lookupAt(e.latlng.lat, e.latlng.lng, "tap");
});

// Bouton "suivre / recentrer"
followFab.addEventListener("click", () => {
  if (!lastFix) { toast("Position GPS pas encore disponible…"); return; }
  followMode = true;
  followFab.classList.add("follow-on");
  map.setView([lastFix.lat, lastFix.lng], Math.max(map.getZoom(), 17), { animate: true });
});

// Dès que l'utilisateur déplace la carte manuellement, on désactive le suivi
map.on("dragstart", () => {
  followMode = false;
  followFab.classList.remove("follow-on");
});

// Bascule de fond de carte
basemapChip.addEventListener("click", () => {
  map.removeLayer(basemaps[currentBasemap]);
  currentBasemap = currentBasemap === "satellite" ? "rue" : "satellite";
  basemaps[currentBasemap].addTo(map);
  basemapChip.textContent = currentBasemap === "satellite" ? "🛰️" : "🗺️";
});

// Recherche (lien Google Maps ou coordonnées)
el("searchBtn").addEventListener("click", handleSearch);
el("searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); handleSearch(); }
});

el("closeSheet").addEventListener("click", closeSheet);

// ---- Démarrage -------------------------------------------------------------
setBusy(false);
followFab.classList.add("follow-on");
startGps();

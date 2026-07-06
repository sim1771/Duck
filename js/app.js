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

  // Lignes de détails
  const rows = [];
  if (address) rows.push(["Adresse", address]);
  const matr = get("matricule");
  if (matr) rows.push(["Matricule", matr]);
  const lot = get("lot");
  if (lot) rows.push(["Lot", lot]);
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

  el("sheetSource").textContent = "Source : " + source.name;

  // Lien Google Maps vers le point interrogé
  const [qlat, qlng] = queriedLatLng;
  el("sheetGmaps").href = `https://www.google.com/maps?q=${qlat},${qlng}`;

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
  basemapChip.textContent = currentBasemap === "satellite" ? "🛰️ Satellite" : "🗺️ Rue";
});

el("closeSheet").addEventListener("click", closeSheet);

// ---- Démarrage -------------------------------------------------------------
setBusy(false);
followFab.classList.add("follow-on");
startGps();

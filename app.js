'use strict';

// ─── Data Sources ─────────────────────────────────────────────────────────────
const TIGER_QUERY    = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer/0/query';
const CENSUS_GEOCODE = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const NOMINATIM_URL  = 'https://nominatim.openstreetmap.org/search';

// ─── Supabase ─────────────────────────────────────────────────────────────────
// Fill in your project values from: Supabase Dashboard → Project Settings → API
//
// SECURITY: The anon key is SAFE to commit and ship in client-side code.
// Supabase's Row Level Security (RLS) policies — not key secrecy — control access.
// The RLS policy in supabase/schema.sql allows public reads only.
// Writes require the service_role key, which stays on your machine / Supabase dashboard.
//
// A Netlify serverless function is NOT needed here — RLS makes the anon key safe for reads.
const SUPABASE_URL      = 'https://oeavmtxbieirbhzfycae.supabase.co';   // e.g. 'https://xxxx.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9lYXZtdHhiaWVpcmJoemZ5Y2FlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MzU1NTUsImV4cCI6MjA4OTIxMTU1NX0.EClO4QOZAHRDbXBg1gTo1Hi_3wj1G8CHPvlCAP7q7rk';      // starts with 'eyJ...'

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── Lookup Tables ────────────────────────────────────────────────────────────
const FIPS_TO_STATE = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT',
  '10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL',
  '18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD',
  '25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE',
  '32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND',
  '39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD',
  '47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV',
  '55':'WI','56':'WY',
};

const STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
  CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',
  FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',
  IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
  ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',
  NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',
  NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',
  PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',
  TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
};

// ─── Map Init ─────────────────────────────────────────────────────────────────
const map = L.map('map', {
  center:      [38, -96],
  zoom:        4,
  minZoom:     3,
  maxZoom:     18,
  zoomControl: false,
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains:  'abcd',
  maxZoom:     19,
}).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

// ─── District Boundary Layer ──────────────────────────────────────────────────
// Style for ALL district boundaries — thick white outlines, no fill
const DISTRICT_STYLE = {
  color:       '#ffffff',
  weight:       1.5,
  opacity:      0.55,
  fill:         true,      // must be true so the interior is a click/hover target
  fillOpacity:  0,         // transparent — visually no fill, but fully clickable
};

let districtLayer  = null;
let highlightLayer = null;

// ─── Load All Districts on Init ───────────────────────────────────────────────
// Fetches all 435 congressional districts from the TIGER REST API with simplified
// geometry (maxAllowableOffset), then renders them as a Leaflet GeoJSON layer.
// We own the rendering so we control line color, weight, opacity exactly.
async function loadAllDistricts() {
  showLoading(true);

  try {
    const features = [];
    let offset = 0;

    // Paginate until we have everything (handles any server maxRecordCount cap)
    while (true) {
      const params = new URLSearchParams({
        where:               '1=1',
        outFields:           'STATE,CD119',
        returnGeometry:      'true',
        outSR:               '4326',
        f:                   'geojson',
        resultRecordCount:   '500',
        resultOffset:        String(offset),
        maxAllowableOffset:  '0.01',   // simplify geometry → smaller payload, fast render
      });

      const res  = await fetch(`${TIGER_QUERY}?${params}`);
      if (!res.ok) throw new Error(`TIGER ${res.status}`);
      const data = await res.json();

      if (!data.features?.length) break;
      features.push(...data.features);

      if (!data.exceededTransferLimit) break;
      offset += data.features.length;
    }

    if (!features.length) throw new Error('No district features returned');

    districtLayer = L.geoJSON(
      { type: 'FeatureCollection', features },
      {
        style:    DISTRICT_STYLE,
        onEachFeature: (feature, layer) => {
          layer.on({
            click:     e => onDistrictClick(e, feature),
            mouseover: e => onDistrictOver(e, feature),
            mouseout:  () => {
              if (layer !== highlightLayer) layer.setStyle(DISTRICT_STYLE);
              hideTooltip();
            },
          });
        },
      }
    ).addTo(map);

  } catch (err) {
    console.error('Failed to load district boundaries:', err);
    showError('Could not load district boundaries. Click any area to identify a district.');
  } finally {
    showLoading(false);
  }
}

// ─── District Hover ───────────────────────────────────────────────────────────
function onDistrictOver(e, feature) {
  const label = districtLabel(feature.properties);
  showTooltip(e.originalEvent, label);
}

// ─── District Click ───────────────────────────────────────────────────────────
async function onDistrictClick(e, feature) {
  L.DomEvent.stopPropagation(e);
  hideTooltip();

  // If we already have the geometry, use it directly for the highlight
  setHighlight(feature);
  showPanel(feature.properties);
}

// ─── Highlight ────────────────────────────────────────────────────────────────
function setHighlight(feature) {
  clearHighlight();

  highlightLayer = L.geoJSON(feature, {
    style: {
      color:       '#d29922',
      weight:       3,
      fillColor:   '#7d5e12',
      fillOpacity:  0.4,
      fill:         true,
    },
  }).addTo(map);

  document.getElementById('clear-btn').classList.remove('hidden');
}

function clearHighlight() {
  if (highlightLayer) {
    map.removeLayer(highlightLayer);
    highlightLayer = null;
  }
  document.getElementById('clear-btn').classList.add('hidden');
  hidePanel();
}

// ─── Panel ────────────────────────────────────────────────────────────────────
async function showPanel(props) {
  const fips      = String(props.STATE).padStart(2, '0');
  const abbr      = FIPS_TO_STATE[fips] || fips;
  const stateName = STATE_NAMES[abbr]   || abbr;
  const distNum   = parseInt(props.CD119, 10);
  const shortCode = districtLabel(props);
  const distName  = distNum === 0 ? 'At-Large District' : `District ${distNum}`;

  // Show static district info immediately; rep section shows a spinner.
  document.getElementById('panel-content').innerHTML = `
    <p class="panel-code">${shortCode}</p>
    <p class="panel-state">${stateName}</p>
    <h2 class="panel-district-name">${distName}</h2>
    <p class="panel-congress">119th Congress</p>
    <div class="panel-divider"></div>
    <div id="rep-section" class="rep-loading">
      <div class="rep-spinner"></div>
      <span>Loading representative…</span>
    </div>
  `;
  document.getElementById('panel').classList.remove('hidden');

  // Fetch rep from Supabase; bail gracefully if not configured.
  const rep        = await fetchRepresentative(abbr, distNum);
  const repSection = document.getElementById('rep-section');
  if (!repSection) return; // panel was closed while fetching

  if (!rep) {
    repSection.className = '';
    repSection.innerHTML = `<p class="rep-not-found">Representative data not yet available.</p>`;
    return;
  }

  const partyClass  = rep.party === 'Democrat'   ? 'party-dem'
                    : rep.party === 'Republican'  ? 'party-rep'
                    : 'party-ind';
  const pledgeHtml  = rep.no_cap_pledge
    ? `<div class="pledge-badge pledge-yes">&#10003; Signed the No Cap Pledge</div>`
    : `<div class="pledge-badge pledge-no">&#9675; Has Not Signed Pledge</div>`;
  const phoneHtml   = rep.phone
    ? `<a class="rep-contact" href="tel:${esc(rep.phone)}">${esc(rep.phone)}</a>`
    : '';
  const websiteHost = rep.website ? safeHostname(rep.website) : '';
  const websiteHtml = websiteHost
    ? `<a class="rep-contact" href="${esc(rep.website)}" target="_blank" rel="noopener noreferrer">${esc(websiteHost)}</a>`
    : '';
  const stanceHtml  = rep.stance_notes
    ? `<blockquote class="rep-stance">${esc(rep.stance_notes)}</blockquote>`
    : '';

  repSection.className = '';
  repSection.innerHTML = `
    <div class="rep-header">
      <span class="rep-name">${esc(rep.name)}</span>
      <span class="party-badge ${partyClass}">${esc(rep.party.charAt(0))}</span>
    </div>
    ${pledgeHtml}
    <div class="rep-links">
      ${phoneHtml}
      ${websiteHtml}
    </div>
    ${stanceHtml}
  `;
}

// ─── Supabase Lookup ──────────────────────────────────────────────────────────
async function fetchRepresentative(state, district) {
  if (!supabaseClient) return null;
  try {
    const { data, error } = await supabaseClient
      .from('representatives')
      .select('name, party, phone, website, no_cap_pledge, stance_notes')
      .eq('state', state)
      .eq('district', district)
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    // PGRST116 = "no rows returned" — normal for districts with no data yet.
    if (err.code !== 'PGRST116') console.warn('Supabase lookup failed:', err.message);
    return null;
  }
}

function hidePanel() {
  document.getElementById('panel').classList.add('hidden');
}

// ─── Search ───────────────────────────────────────────────────────────────────
async function onSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  showLoading(true);
  try {
    const coords = await geocode(query);
    if (!coords) { showError('Address not found. Try a zip code or full address.'); return; }

    const feature = await queryDistrictAtPoint(coords.lat, coords.lon);
    if (!feature) { showError('No congressional district found at that location.'); return; }

    setHighlight(feature);
    showPanel(feature.properties);
    map.fitBounds(highlightLayer.getBounds(), { maxZoom: 9, padding: [40, 40] });
  } catch (err) {
    console.error('Search failed:', err);
    showError('Search failed. Please try again.');
  } finally {
    showLoading(false);
  }
}

// ─── Point Query (for search — fetches full-res geometry of one district) ─────
async function queryDistrictAtPoint(lat, lon) {
  const params = new URLSearchParams({
    geometry:       `${lon},${lat}`,
    geometryType:   'esriGeometryPoint',
    inSR:           '4326',
    spatialRel:     'esriSpatialRelIntersects',
    outFields:      'STATE,CD119',
    returnGeometry: 'true',
    outSR:          '4326',
    f:              'geojson',
  });
  const res  = await fetch(`${TIGER_QUERY}?${params}`);
  if (!res.ok) throw new Error(`TIGER ${res.status}`);
  const data = await res.json();
  return data.features?.[0] || null;
}

// ─── Geocoding ────────────────────────────────────────────────────────────────
async function geocode(query) {
  try {
    const p   = new URLSearchParams({ address: query, benchmark: 'Public_AR_Current', format: 'json' });
    const res = await fetch(`${CENSUS_GEOCODE}?${p}`);
    const d   = await res.json();
    const m   = d.result?.addressMatches?.[0];
    if (m) return { lat: m.coordinates.y, lon: m.coordinates.x };
  } catch (e) { console.warn('Census geocoder failed:', e); }

  try {
    const p   = new URLSearchParams({ q: query, format: 'json', limit: '1', countrycodes: 'us' });
    const res = await fetch(`${NOMINATIM_URL}?${p}`, { headers: { 'Accept-Language': 'en' } });
    const d   = await res.json();
    if (d.length) return { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon) };
  } catch (e) { console.warn('Nominatim failed:', e); }

  return null;
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');

function showTooltip(event, text) {
  tooltip.textContent    = text;
  tooltip.style.display  = 'block';
  moveTooltip(event);
}

function moveTooltip(event) {
  const x    = event.clientX + 14;
  const y    = event.clientY - 32;
  const maxX = window.innerWidth  - tooltip.offsetWidth  - 8;
  const maxY = window.innerHeight - tooltip.offsetHeight - 8;
  tooltip.style.left = Math.min(x, maxX) + 'px';
  tooltip.style.top  = Math.max(8, Math.min(y, maxY)) + 'px';
}

function hideTooltip() {
  tooltip.style.display = 'none';
}

map.on('mousemove', e => {
  if (tooltip.style.display !== 'none') moveTooltip(e.originalEvent);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Short label for tooltip: "CO-07" or "WY-AL"
function districtLabel(props) {
  const fips = String(props.STATE).padStart(2, '0');
  const abbr = FIPS_TO_STATE[fips] || fips;
  const num  = parseInt(props.CD119, 10);
  return num === 0
    ? `${abbr}-AL`
    : `${abbr}-${String(num).padStart(2, '0')}`;
}

// Escape HTML entities to prevent XSS when inserting DB values into innerHTML.
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Extract hostname safely; returns '' on invalid URLs.
function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ─── Loading / Errors ─────────────────────────────────────────────────────────
function showLoading(visible) {
  document.getElementById('loading').classList.toggle('hidden', !visible);
}

function showError(msg) {
  const toast = document.createElement('div');
  toast.className   = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
document.getElementById('search-btn').addEventListener('click', onSearch);
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') onSearch();
});
document.getElementById('panel-close').addEventListener('click', clearHighlight);
document.getElementById('clear-btn').addEventListener('click', clearHighlight);

// ─── Embed Modal ─────────────────────────────────────────────────────────────
(function () {
  const overlay     = document.getElementById('embed-overlay');
  const widthInput  = document.getElementById('embed-width');
  const widthUnit   = document.getElementById('embed-width-unit');
  const widthSlider = document.getElementById('embed-width-slider');
  const heightInput = document.getElementById('embed-height');
  const heightSlider= document.getElementById('embed-height-slider');
  const codeArea    = document.getElementById('embed-code');
  const copyBtn     = document.getElementById('embed-copy');

  function embedUrl() {
    // Use current page URL stripped of hash/search so it stays clean as an iframe src
    return window.location.origin + window.location.pathname;
  }

  function buildCode() {
    const w  = widthInput.value  || '800';
    const wu = widthUnit.value   || 'px';
    const h  = heightInput.value || '600';
    return `<iframe\n  src="${embedUrl()}"\n  width="${w}${wu}"\n  height="${h}px"\n  style="border:0;border-radius:8px;"\n  title="No Cap Fund \u2013 Congressional District Map"\n  allowfullscreen\n></iframe>`;
  }

  function refresh() { codeArea.value = buildCode(); }

  // Sync sliders → inputs
  widthSlider.addEventListener('input',  () => { widthInput.value  = widthSlider.value;  refresh(); });
  heightSlider.addEventListener('input', () => { heightInput.value = heightSlider.value; refresh(); });

  // Sync inputs → sliders
  widthInput.addEventListener('input',  () => { widthSlider.value  = Math.min(Math.max(widthInput.value,  300), 1400); refresh(); });
  heightInput.addEventListener('input', () => { heightSlider.value = Math.min(Math.max(heightInput.value, 200), 900);  refresh(); });

  widthUnit.addEventListener('change', () => {
    // When switching to %, clamp sensible max
    if (widthUnit.value === '%') {
      widthInput.value  = Math.min(widthInput.value, 100);
      widthSlider.value = widthInput.value;
    }
    refresh();
  });

  // Presets
  document.querySelectorAll('.embed-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      widthInput.value  = btn.dataset.w;
      widthUnit.value   = btn.dataset.wu;
      heightInput.value = btn.dataset.h;
      widthSlider.value = Math.min(btn.dataset.w, 1400);
      heightSlider.value= Math.min(btn.dataset.h, 900);
      refresh();
    });
  });

  // Copy
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(codeArea.value).then(() => {
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 2000);
    });
  });

  // Open / Close
  document.getElementById('embed-btn').addEventListener('click', () => {
    refresh();
    overlay.classList.remove('hidden');
  });

  function closeModal() { overlay.classList.add('hidden'); }

  document.getElementById('embed-close').addEventListener('click', closeModal);

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal();
  });
})();

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadAllDistricts();

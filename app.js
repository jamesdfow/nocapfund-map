'use strict';

// ─── Data Source URLs ─────────────────────────────────────────────────────────
const STATES_TOPO_URL  = 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json';
const LEGISLATORS_URL  = 'https://unitedstates.github.io/congress-legislators/legislators-current.json';
const TIGER_BASE       = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer/54/query';
const CENSUS_GEOCODE   = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const NOMINATIM_URL    = 'https://nominatim.openstreetmap.org/search';

// ─── Lookup Tables ────────────────────────────────────────────────────────────
const FIPS_TO_STATE = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT',
  '10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL',
  '18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD',
  '25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE',
  '32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND',
  '39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD',
  '47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV',
  '55':'WI','56':'WY','72':'PR',
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
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',PR:'Puerto Rico',
};

// ─── Application State ────────────────────────────────────────────────────────
let pledgeSet       = new Set();
let legislatorMap   = {};   // "STATE-DISTRICT" → legislator object
let activeStateFips = null;
let stateFeatures   = null;
let stateGroup, districtGroup, borderGroup;

// ─── SVG / Projection Setup ───────────────────────────────────────────────────
const width  = window.innerWidth;
const height = window.innerHeight;

const svg = d3.select('#map')
  .attr('width',  width)
  .attr('height', height);

const g = svg.append('g');

const projection = d3.geoAlbersUsa()
  .scale(1300)
  .translate([width / 2, height / 2]);

const pathGen = d3.geoPath().projection(projection);

const zoom = d3.zoom()
  .scaleExtent([1, 20])
  .on('zoom', e => g.attr('transform', e.transform));

svg.call(zoom);

// Tooltip
const tooltip = document.getElementById('tooltip');

// ─── Initialise ───────────────────────────────────────────────────────────────
async function init() {
  showLoading(true);

  try {
    const [topoData, legislators, pledgeData] = await Promise.all([
      d3.json(STATES_TOPO_URL),
      fetch(LEGISLATORS_URL).then(r => { if (!r.ok) throw new Error('legislators'); return r.json(); }),
      fetch('pledge-data.json').then(r => { if (!r.ok) throw new Error('pledge-data'); return r.json(); }),
    ]);

    pledgeSet = new Set(pledgeData);

    // Build lookup: "CA-6" → legislator
    legislators.forEach(leg => {
      const term = leg.terms.at(-1);
      if (term.type === 'rep' || term.type === 'del') {
        legislatorMap[`${term.state}-${term.district}`] = Object.assign({}, leg, { currentTerm: term });
      }
    });

    renderStates(topoData);
  } catch (err) {
    console.error('Init failed:', err);
    showError('Failed to load map data. Please refresh.');
  } finally {
    showLoading(false);
  }
}

// ─── Render State Layer ───────────────────────────────────────────────────────
function renderStates(topoData) {
  stateGroup    = g.append('g').attr('id', 'states-layer');
  districtGroup = g.append('g').attr('id', 'districts-layer');
  borderGroup   = g.append('g').attr('id', 'borders-layer');

  stateFeatures = topojson.feature(topoData, topoData.objects.states);

  stateGroup.selectAll('.state')
    .data(stateFeatures.features)
    .join('path')
      .attr('class', 'state')
      .attr('d', pathGen)
      .attr('data-fips', d => fipsOf(d))
      .on('click',     onStateClick)
      .on('mouseover', onStateHover)
      .on('mousemove', onStateMove)
      .on('mouseout',  hideTooltip);

  // State mesh borders (drawn on top so they stay crisp)
  borderGroup.append('path')
    .datum(topojson.mesh(topoData, topoData.objects.states, (a, b) => a !== b))
    .attr('class', 'state-borders')
    .attr('d', pathGen);
}

// ─── State Interaction ────────────────────────────────────────────────────────
async function onStateClick(event, d) {
  event.stopPropagation();
  hideTooltip();

  const fips = fipsOf(d);
  if (activeStateFips === fips) return;   // already loaded
  activeStateFips = fips;

  zoomToFeature(d);
  document.getElementById('back-btn').classList.remove('hidden');
  hidePanel();
  clearDistricts();

  showLoading(true);
  try {
    const geojson = await fetchDistricts(fips);
    renderDistricts(geojson, fips);
  } catch (err) {
    console.error('District load error:', err);
    showError('Could not load district boundaries. Please try again.');
  } finally {
    showLoading(false);
  }
}

function onStateHover(event, d) {
  const abbr = FIPS_TO_STATE[fipsOf(d)] || '';
  showTooltip(event, STATE_NAMES[abbr] || abbr);
}

function onStateMove(event) {
  moveTooltip(event);
}

// ─── Fetch Districts from Census TIGER API ────────────────────────────────────
async function fetchDistricts(fips) {
  const params = new URLSearchParams({
    where:             `STATEFP='${fips}'`,
    outFields:         'STATEFP,CD118FP,NAMELSAD',
    outSR:             '4326',
    f:                 'geojson',
    resultRecordCount: '100',
  });

  const res = await fetch(`${TIGER_BASE}?${params}`);
  if (!res.ok) throw new Error(`TIGER API ${res.status}`);
  const data = await res.json();

  if (!data.features?.length) throw new Error('No district features returned');
  return data;
}

// ─── Render District Layer ────────────────────────────────────────────────────
function renderDistricts(geojson, stateFips) {
  clearDistricts();

  const stateAbbr = FIPS_TO_STATE[stateFips] || '';

  districtGroup.selectAll('.district')
    .data(geojson.features)
    .join('path')
      .attr('class', d => {
        const leg = getLegislator(stateAbbr, d.properties.CD118FP);
        return 'district' + (leg && pledgeSet.has(leg.id.bioguide) ? ' signed' : '');
      })
      .attr('d', pathGen)
      .on('click',     (e, d) => onDistrictClick(e, d, stateFips))
      .on('mouseover', (e, d) => onDistrictHover(e, d, stateAbbr))
      .on('mousemove', onDistrictMove)
      .on('mouseout',  hideTooltip);
}

function clearDistricts() {
  if (districtGroup) districtGroup.selectAll('.district').remove();
}

// ─── District Interaction ─────────────────────────────────────────────────────
function onDistrictClick(event, d, stateFips) {
  event.stopPropagation();
  hideTooltip();

  // Highlight
  districtGroup.selectAll('.district').classed('selected', false);
  d3.select(event.currentTarget).classed('selected', true);

  const stateAbbr  = FIPS_TO_STATE[stateFips] || '';
  const districtFp = d.properties.CD118FP;
  const leg        = getLegislator(stateAbbr, districtFp);

  showPanel(leg, d.properties, stateAbbr, districtFp);
}

function onDistrictHover(event, d, stateAbbr) {
  const districtFp  = d.properties.CD118FP;
  const leg         = getLegislator(stateAbbr, districtFp);
  const districtNum = parseInt(districtFp, 10);
  const label       = districtNum === 0
    ? `${stateAbbr} At-Large`
    : `${STATE_NAMES[stateAbbr] || stateAbbr} – District ${districtNum}`;
  const repName = leg ? (leg.name.official_full || `${leg.name.first} ${leg.name.last}`) : '';
  showTooltip(event, label + (repName ? `\n${repName}` : ''));
}

function onDistrictMove(event) {
  moveTooltip(event);
}

// ─── Rep Panel ────────────────────────────────────────────────────────────────
function showPanel(leg, props, stateAbbr, districtFp) {
  const panel   = document.getElementById('panel');
  const content = document.getElementById('panel-content');

  const districtNum  = parseInt(districtFp, 10);
  const districtLabel = districtNum === 0
    ? `${STATE_NAMES[stateAbbr] || stateAbbr} – At-Large`
    : `${STATE_NAMES[stateAbbr] || stateAbbr} – District ${districtNum}`;

  if (!leg) {
    content.innerHTML = `
      <p class="panel-district">${props.NAMELSAD || districtLabel}</p>
      <p class="no-rep">No representative data available for this district.</p>
    `;
  } else {
    const term    = leg.currentTerm;
    const signed  = pledgeSet.has(leg.id.bioguide);
    const name    = leg.name.official_full || `${leg.name.first} ${leg.name.last}`;
    const party   = term.party || 'Unknown';
    const pClass  = partyClass(party);
    const phone   = term.phone || '';
    const url     = term.url || '';

    content.innerHTML = `
      <div class="${signed ? 'pledge-badge' : 'no-pledge-badge'}">
        ${signed ? '✓ Signed No Cap Pledge' : '✗ Has Not Signed'}
      </div>
      <p class="panel-district">${districtLabel}</p>
      <h2 class="rep-name">${escHtml(name)}</h2>
      <span class="rep-party ${pClass}">${escHtml(party)}</span>
      <hr class="panel-divider" />
      ${phone ? `<a class="panel-action" href="tel:${escHtml(phone)}">
        <span class="action-icon">📞</span> ${escHtml(phone)}
      </a>` : ''}
      ${url ? `<a class="panel-action" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">
        <span class="action-icon">🌐</span> Official Website
      </a>` : ''}
    `;
  }

  panel.classList.remove('hidden');
}

function hidePanel() {
  document.getElementById('panel').classList.add('hidden');
  districtGroup?.selectAll('.district').classed('selected', false);
}

// ─── Back to Full Map ─────────────────────────────────────────────────────────
function onBack() {
  activeStateFips = null;
  resetZoom();
  clearDistricts();
  document.getElementById('back-btn').classList.add('hidden');
  hidePanel();
}

// ─── Search ───────────────────────────────────────────────────────────────────
async function onSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  showLoading(true);
  try {
    const coords = await geocode(query);
    if (!coords) { showError('Address not found. Please try a zip code or full address.'); return; }

    const info = await findDistrictAtPoint(coords.lat, coords.lon);
    if (!info) { showError('No congressional district found at that location.'); return; }

    const { fips, districtFp } = info;
    const stateFeature = stateFeatures.features.find(f => fipsOf(f) === fips);
    if (!stateFeature) { showError('State not found in map data.'); return; }

    // Load state if not already active
    if (activeStateFips !== fips) {
      activeStateFips = fips;
      zoomToFeature(stateFeature);
      document.getElementById('back-btn').classList.remove('hidden');
      hidePanel();
      clearDistricts();

      const geojson = await fetchDistricts(fips);
      renderDistricts(geojson, fips);
    }

    // Highlight the matched district
    const target = districtGroup.selectAll('.district')
      .filter(d => d.properties.CD118FP === districtFp);

    if (!target.empty()) {
      districtGroup.selectAll('.district').classed('selected', false);
      target.classed('selected', true);

      const stateAbbr = FIPS_TO_STATE[fips] || '';
      const leg = getLegislator(stateAbbr, districtFp);
      showPanel(leg, { NAMELSAD: '' }, stateAbbr, districtFp);
    }
  } catch (err) {
    console.error('Search error:', err);
    showError('Search failed. Please try again.');
  } finally {
    showLoading(false);
  }
}

// ─── Geocoding ────────────────────────────────────────────────────────────────
async function geocode(query) {
  // 1. Census geocoder
  try {
    const params = new URLSearchParams({ address: query, benchmark: '2020', format: 'json' });
    const res    = await fetch(`${CENSUS_GEOCODE}?${params}`);
    const data   = await res.json();
    const match  = data.result?.addressMatches?.[0];
    if (match) return { lat: match.coordinates.y, lon: match.coordinates.x };
  } catch (e) {
    console.warn('Census geocoder failed:', e);
  }

  // 2. Nominatim fallback
  try {
    const params = new URLSearchParams({ q: query, format: 'json', limit: '1', countrycodes: 'us' });
    const res    = await fetch(`${NOMINATIM_URL}?${params}`, { headers: { 'Accept-Language': 'en' } });
    const data   = await res.json();
    if (data.length > 0) return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  } catch (e) {
    console.warn('Nominatim failed:', e);
  }

  return null;
}

async function findDistrictAtPoint(lat, lon) {
  const params = new URLSearchParams({
    geometry:     `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR:         '4326',
    spatialRel:   'esriSpatialRelIntersects',
    outFields:    'STATEFP,CD118FP',
    outSR:        '4326',
    f:            'geojson',
  });

  const res  = await fetch(`${TIGER_BASE}?${params}`);
  const data = await res.json();

  const feat = data.features?.[0];
  if (!feat) return null;

  // GeoJSON puts attributes under .properties
  const props = feat.properties || feat.attributes || {};
  if (!props.STATEFP || props.CD118FP == null) return null;

  return { fips: String(props.STATEFP).padStart(2, '0'), districtFp: String(props.CD118FP).padStart(2, '0') };
}

// ─── Zoom Helpers ─────────────────────────────────────────────────────────────
function zoomToFeature(feature) {
  const [[x0, y0], [x1, y1]] = pathGen.bounds(feature);
  const dx    = x1 - x0 || 1;
  const dy    = y1 - y0 || 1;
  const cx    = (x0 + x1) / 2;
  const cy    = (y0 + y1) / 2;
  const scale = Math.min(8, 0.85 / Math.max(dx / width, dy / height));

  svg.transition().duration(750).call(
    zoom.transform,
    d3.zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-cx, -cy)
  );
}

function resetZoom() {
  svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
}

// ─── Utility Helpers ──────────────────────────────────────────────────────────

/** Get zero-padded FIPS from a TopoJSON feature (its numeric id). */
function fipsOf(feature) {
  return String(feature.id).padStart(2, '0');
}

/**
 * Look up a legislator by state abbreviation + TIGER CD118FP string.
 * Handles at-large districts where TIGER uses "00" and legislators use 0 (or 1).
 */
function getLegislator(stateAbbr, cdFp) {
  const num = parseInt(cdFp, 10);
  return (
    legislatorMap[`${stateAbbr}-${num}`] ||
    (num === 1 ? legislatorMap[`${stateAbbr}-0`] : null) ||
    (num === 0 ? legislatorMap[`${stateAbbr}-1`] : null)
  );
}

function partyClass(party) {
  const p = (party || '').toLowerCase();
  if (p.startsWith('r')) return 'republican';
  if (p.startsWith('d')) return 'democrat';
  return 'independent';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────
function showTooltip(event, text) {
  tooltip.textContent = text;
  tooltip.style.display = 'block';
  tooltip.setAttribute('aria-hidden', 'false');
  moveTooltip(event);
}

function moveTooltip(event) {
  const x = event.clientX + 14;
  const y = event.clientY - 32;
  const maxX = window.innerWidth  - tooltip.offsetWidth  - 8;
  const maxY = window.innerHeight - tooltip.offsetHeight - 8;
  tooltip.style.left = Math.min(x, maxX) + 'px';
  tooltip.style.top  = Math.max(8, Math.min(y, maxY)) + 'px';
}

function hideTooltip() {
  tooltip.style.display = 'none';
  tooltip.setAttribute('aria-hidden', 'true');
}

// ─── Loading / Errors ─────────────────────────────────────────────────────────
function showLoading(visible) {
  document.getElementById('loading').classList.toggle('hidden', !visible);
}

function showError(msg) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
document.getElementById('back-btn').addEventListener('click', onBack);
document.getElementById('search-btn').addEventListener('click', onSearch);
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') onSearch();
});
document.getElementById('panel-close').addEventListener('click', hidePanel);

// ─── Boot ─────────────────────────────────────────────────────────────────────
init().catch(console.error);

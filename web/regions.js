// Per-region game config: locations, map view, scoring, Street View snap radius.
// The region is the difficulty, a per-profile setting: Raleigh (default) < North Carolina < USA < World.
// ?region=raleigh|nc|usa|world overrides it (handy for testing).
import { LOCATIONS as WORLD_LOCATIONS } from "./locations.js";
import { LOCATIONS as NC_LOCATIONS } from "./locations-nc.js";
import { LOCATIONS as RALEIGH_LOCATIONS } from "./locations-raleigh.js";
import { LOCATIONS as USA_LOCATIONS } from "./locations-usa.js";
import { settings } from "./settings.js";

const METERS_PER_MILE = 1609.344;
const FEET_PER_MILE = 5280;

export function raleighScore(meters) {
  const miles = meters / METERS_PER_MILE;
  const points = Math.round(5000 * Math.exp(-miles / 0.75));
  const stars = miles < 0.1 ? 5 : miles < 0.3 ? 4 : miles < 0.75 ? 3 : miles < 1.5 ? 2 : 1;
  return { points, stars };
}

export function formatMiles(meters) {
  const miles = meters / METERS_PER_MILE;
  if (miles < 0.2) {
    const feet = miles * FEET_PER_MILE;
    return `${(feet < 100 ? Math.round(feet) : Math.round(feet / 10) * 10).toLocaleString()} feet`;
  }
  return `${miles.toFixed(1)} miles`;
}

/** Miles-based scoring: points fall off over `scaleMiles`; stars by distance thresholds (in miles). */
function milesScore(scaleMiles, starMiles) {
  return (meters) => {
    const miles = meters / METERS_PER_MILE;
    const points = Math.round(5000 * Math.exp(-miles / scaleMiles));
    const stars = 5 - starMiles.filter((limit) => miles >= limit).length;
    return { points, stars };
  };
}
export const ncScore = milesScore(20, [2, 5, 15, 40]);
export const usaScore = milesScore(400, [25, 100, 300, 800]);

export function worldScore(meters) {
  const km = meters / 1000;
  const points = Math.round(5000 * Math.exp(-km / 2000));
  const stars = km < 500 ? 5 : km < 1500 ? 4 : km < 3000 ? 3 : km < 6000 ? 2 : 1;
  return { points, stars };
}

export const formatKm = (meters) => `${Math.round(meters / 1000).toLocaleString()} km`;

export const REGIONS = {
  raleigh: {
    id: "raleigh",
    locations: RALEIGH_LOCATIONS,
    view: { center: [35.7796, -78.6382], zoom: 12 },
    // Bounds are Wake County-ish, centred on the view centre so the start view isn't pushed sideways
    // when the whole box fits on screen.
    mapOptions: { minZoom: 11, maxZoom: 18, maxBounds: [[35.66, -78.82], [35.90, -78.46]], maxBoundsViscosity: 1.0 },
    resultMaxZoom: 16, // don't zoom to street level when the guess is almost exact
    snapRadius: 150,
    score: raleighScore,
    formatDistance: formatMiles,
  },
  nc: {
    id: "nc",
    locations: NC_LOCATIONS,
    view: { center: [35.45, -79.4], zoom: 7 },
    mapOptions: { minZoom: 6, maxZoom: 18, maxBounds: [[33.6, -84.6], [36.8, -75.2]], maxBoundsViscosity: 1.0 },
    resultMaxZoom: 13,
    snapRadius: 300,
    score: ncScore,
    formatDistance: formatMiles,
  },
  usa: {
    id: "usa",
    locations: USA_LOCATIONS,
    view: { center: [39.5, -98.35], zoom: 4 },
    mapOptions: { minZoom: 3, maxZoom: 18, maxBounds: [[22, -128], [52, -64]], maxBoundsViscosity: 1.0 },
    resultMaxZoom: 10,
    snapRadius: 500,
    score: usaScore,
    formatDistance: formatMiles,
  },
  world: {
    id: "world",
    locations: WORLD_LOCATIONS,
    view: { center: [20, 0], zoom: 2 },
    mapOptions: { worldCopyJump: true, maxZoom: 18 },
    resultMaxZoom: 18,
    snapRadius: 1000,
    score: worldScore,
    formatDistance: formatKm,
  },
};

// Street View lookup: Google's own outdoor captures only. OUTDOOR alone still lets user-uploaded photo
// spheres through (e.g. a drone shot high above Raleigh), which isn't a street a kid can recognise.
export function panoRequest(loc, radius) {
  const { StreetViewSource, StreetViewPreference } = google.maps;
  const request = { location: { lat: loc.lat, lng: loc.lng }, radius, preference: StreetViewPreference.NEAREST };
  if (StreetViewSource.GOOGLE) request.sources = [StreetViewSource.GOOGLE, StreetViewSource.OUTDOOR]; // intersection
  else request.source = StreetViewSource.OUTDOOR; // older Maps JS versions
  return request;
}

export const REGION_ORDER = ["raleigh", "nc", "usa", "world"];

export function currentRegion(search = globalThis.location?.search ?? "", difficulty = settings.difficulty) {
  const id = new URLSearchParams(search).get("region");
  return REGIONS[id] ?? REGIONS[difficulty] ?? REGIONS.raleigh;
}

// Per-region game config: locations, map view, scoring, Street View snap radius.
// Default region is Raleigh; ?region=world keeps the original worldwide list.
import { LOCATIONS as WORLD_LOCATIONS } from "./locations.js";
import { LOCATIONS as RALEIGH_LOCATIONS } from "./locations-raleigh.js";

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
    finale: "You explored Raleigh! Play again?",
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
    finale: "You explored the whole world. Play again?",
  },
};

export function currentRegion(search = globalThis.location?.search ?? "") {
  const id = new URLSearchParams(search).get("region");
  return REGIONS[id] ?? REGIONS.raleigh;
}

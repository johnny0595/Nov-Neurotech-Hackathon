// Dev check (?checklocs=1): ask Street View for the nearest outdoor panorama around every location and
// print a console table. Uses the Maps JavaScript API only (our key can't call the Static metadata API).
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function haversineMeters(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function checkLocations(locations, radius = 150) {
  const sv = new google.maps.StreetViewService();
  const rows = [];
  for (const loc of locations) {
    try {
      const { data } = await sv.getPanorama({
        location: { lat: loc.lat, lng: loc.lng }, radius,
        source: google.maps.StreetViewSource.OUTDOOR,
        preference: google.maps.StreetViewPreference.NEAREST,
      });
      const p = data.location.latLng;
      const meters = Math.round(haversineMeters(loc, { lat: p.lat(), lng: p.lng() }));
      rows.push({ name: loc.name, found: "yes", distance_m: meters, ok: meters <= radius ? "ok" : "TOO FAR", pano: data.location.pano });
    } catch {
      rows.push({ name: loc.name, found: "no", distance_m: null, ok: "NO COVERAGE", pano: "" });
    }
  }
  console.table(rows);
  const bad = rows.filter((r) => r.ok !== "ok");
  console.log(bad.length
    ? `[checklocs] ${bad.length} location(s) need fixing: ${bad.map((r) => r.name).join(", ")}`
    : `[checklocs] all ${rows.length} locations have outdoor Street View within ${radius} m`);
  return rows;
}

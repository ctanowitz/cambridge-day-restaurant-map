// map.js — Cambridge Day restaurant map
document.addEventListener('DOMContentLoaded', async () => {
  const pymChild = new pym.Child();

  const CAMBRIDGE_CENTER = [-71.1097, 42.3736];

  const [restaurantsResp, neighborhoodsResp] = await Promise.all([
    fetch('data/restaurants.json'),
    fetch('data/neighborhoods.geojson'),
  ]);
  const rawRows = await restaurantsResp.json();
  const neighborhoodFeatures = (await neighborhoodsResp.json()).features;

  // Cambridge's 13 official CDD-designated neighborhoods, from the city's own
  // open GIS data (public domain): see
  // https://github.com/cambridgegis/cambridgegis_data/tree/main/Boundary/CDD_Neighborhoods
  // Point-in-polygon test (ray casting) so every restaurant can be tagged
  // with which one it falls in -- restaurants outside all 13 (e.g. in
  // Somerville or Boston, which Cambridge Day also covers) get no neighborhood.
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInPolygonGeometry(x, y, geometry) {
    if (geometry.type === 'Polygon') {
      const [exterior, ...holes] = geometry.coordinates;
      if (!pointInRing(x, y, exterior)) return false;
      return !holes.some(hole => pointInRing(x, y, hole));
    }
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.some(poly => pointInPolygonGeometry(x, y, { type: 'Polygon', coordinates: poly }));
    }
    return false;
  }

  function findNeighborhood(lng, lat) {
    const feature = neighborhoodFeatures.find(f => pointInPolygonGeometry(lng, lat, f.geometry));
    return feature ? feature.properties.NAME : null;
  }

  // Bounding box of a Polygon/MultiPolygon geometry, for zooming to it.
  function geometryBounds(geometry) {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    const visitRing = (ring) => {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    };
    const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
    for (const polygon of polygons) {
      for (const ring of polygon) visitRing(ring);
    }
    return [[minLng, minLat], [maxLng, maxLat]];
  }

  // The exported data has one row per (restaurant, article) mention -- the
  // same restaurant can appear many times across different articles written
  // over the years. Collapse those rows into one entity per restaurant
  // (matched by name), each holding every article about it, newest first.
  // NOTE: this matches by exact name text, so occasional inconsistent
  // spellings of the same real restaurant across articles (e.g. "Chocho's"
  // vs "Cho Cho's") won't be merged -- a data-cleaning problem, not a
  // mapping one.
  function buildRestaurantEntities(rows) {
    const byName = new Map();
    for (const r of rows) {
      const key = r.name.trim().toLowerCase();
      let entity = byName.get(key);
      if (!entity) {
        entity = { name: r.name, address: null, cuisine: null, lat: r.lat, lng: r.lng, articles: [] };
        byName.set(key, entity);
      }
      if (!entity.address && r.address) entity.address = r.address;
      if (!entity.cuisine && r.cuisine) entity.cuisine = r.cuisine;
      entity.articles.push({ date: r.date, excerpt: r.excerpt, url: r.url });
    }
    for (const entity of byName.values()) {
      entity.articles.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }
    return [...byName.values()];
  }

  const allEntities = buildRestaurantEntities(rawRows);
  allEntities.forEach((entity, i) => {
    entity._id = i;
    entity.neighborhood = findNeighborhood(entity.lng, entity.lat);
  });

  const neighborhoodSelect = document.getElementById('neighborhood-filter');
  const neighborhoodNames = [...neighborhoodFeatures.map(f => f.properties.NAME)].sort();
  for (const n of neighborhoodNames) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    neighborhoodSelect.appendChild(opt);
  }

  // Multiple distinct restaurants often share one exact address (food
  // courts, malls) -- points at an identical coordinate can never be split
  // apart by MapLibre's clustering no matter the zoom, so one "location"
  // becomes one map feature, carrying every restaurant entity at that spot.
  // `currentGroups` is the lookup from a feature's groupIndex back to its
  // full list of restaurant entities (kept out of the GeoJSON itself, which
  // only needs simple property values).
  let currentGroups = [];

  function toGeoJSON(entities) {
    const byLocation = new Map();
    for (const entity of entities) {
      const key = `${entity.lat.toFixed(5)},${entity.lng.toFixed(5)}`;
      if (!byLocation.has(key)) byLocation.set(key, []);
      byLocation.get(key).push(entity);
    }
    currentGroups = [...byLocation.values()];

    return {
      type: 'FeatureCollection',
      features: currentGroups.map((group, groupIndex) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [group[0].lng, group[0].lat] },
        properties: { groupIndex, count: group.length, name: group[0].name },
      })),
    };
  }

  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: CAMBRIDGE_CENTER,
    zoom: 12.5,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  let popup = null;

  map.on('load', () => {
    // Highlighting the selected neighborhood's boundary -- filter starts
    // matching nothing (no neighborhood picked yet); applyFilters() below
    // updates it to the chosen NAME.
    map.addSource('neighborhoods', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: neighborhoodFeatures },
    });
    map.addLayer({
      id: 'neighborhood-highlight-fill',
      type: 'fill',
      source: 'neighborhoods',
      filter: ['==', ['get', 'NAME'], ''],
      paint: { 'fill-color': '#efbe25', 'fill-opacity': 0.08 },
    });
    map.addLayer({
      id: 'neighborhood-highlight-outline',
      type: 'line',
      source: 'neighborhoods',
      filter: ['==', ['get', 'NAME'], ''],
      paint: { 'line-color': '#9a6b00', 'line-width': 2 },
    });

    map.addSource('restaurants', {
      type: 'geojson',
      data: toGeoJSON(allEntities),
      cluster: true,
      clusterMaxZoom: 15,
      clusterRadius: 45,
    });

    map.addLayer({
      id: 'clusters',
      type: 'circle',
      source: 'restaurants',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': [
          'step', ['get', 'point_count'],
          '#6ea8fe', 10,
          '#4785f4', 30,
          '#1a56db',
        ],
        'circle-radius': [
          'step', ['get', 'point_count'],
          15, 10,
          20, 30,
          26,
        ],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    });

    map.addLayer({
      id: 'cluster-count',
      type: 'symbol',
      source: 'restaurants',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': '{point_count_abbreviated}',
        'text-font': ['Noto Sans Bold'],
        'text-size': 12,
      },
      paint: { 'text-color': '#fff' },
    });

    map.addLayer({
      id: 'unclustered-point',
      type: 'circle',
      source: 'restaurants',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': '#efbe25',
        'circle-radius': ['step', ['get', 'count'], 7, 2, 9, 5, 11, 15, 14],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    });

    map.addLayer({
      id: 'unclustered-point-count',
      type: 'symbol',
      source: 'restaurants',
      filter: ['all', ['!', ['has', 'point_count']], ['>', ['get', 'count'], 1]],
      layout: {
        'text-field': '{count}',
        'text-font': ['Noto Sans Bold'],
        'text-size': 11,
      },
      paint: { 'text-color': '#4a3800' },
    });

    map.on('click', 'clusters', (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
      if (!features.length) return;
      // A fixed zoom step computed synchronously, rather than asking the
      // clustering engine for the exact "this cluster just broke apart" zoom
      // level (GeoJSONSource#getClusterExpansionZoom) -- that call requires a
      // round trip to a background worker, and in some environments its
      // callback never resolves (no error, just silence), leaving clicks
      // dead with no fallback. This way a click always does something.
      map.easeTo({
        center: features[0].geometry.coordinates,
        zoom: Math.min(map.getZoom() + 2, 18),
      });
    });

    map.on('click', 'unclustered-point', (e) => {
      const group = currentGroups[e.features[0].properties.groupIndex];
      showGroupPopup(group, e.features[0].geometry.coordinates);
    });

    map.on('mouseenter', 'clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'clusters', () => { map.getCanvas().style.cursor = ''; });
    map.on('mouseenter', 'unclustered-point', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'unclustered-point', () => { map.getCanvas().style.cursor = ''; });

    renderList(allEntities);
    setTimeout(() => pymChild.sendHeight(), 300);
  });

  function entityHtml(entity) {
    const articlesHtml = entity.articles.map(a => `
      <div class="popup-article">
        ${a.date ? `<div class="popup-article-date">${escapeHtml(a.date)}</div>` : ''}
        ${a.excerpt ? `<p class="popup-excerpt">${escapeHtml(a.excerpt)}</p>` : ''}
        ${a.url ? `<a class="popup-link" href="${a.url}" target="_blank" rel="noopener">Read the article →</a>` : ''}
      </div>
    `).join('');
    return `
      <div class="popup-name">${escapeHtml(entity.name)}</div>
      ${entity.cuisine ? `<div class="popup-cuisine">${escapeHtml(entity.cuisine)}</div>` : ''}
      ${entity.address ? `<div class="popup-address">${escapeHtml(entity.address)}</div>` : ''}
      ${entity.neighborhood ? `<div class="popup-neighborhood">${escapeHtml(entity.neighborhood)}</div>` : ''}
      ${entity.articles.length > 1 ? `<div class="popup-article-count">${entity.articles.length} articles, newest first</div>` : ''}
      ${articlesHtml}
    `;
  }

  // Shows every distinct restaurant at one location in a single (scrollable,
  // if several) popup -- see the `currentGroups` comment above for why a map
  // point can represent more than one restaurant.
  function showGroupPopup(group, coordinates) {
    if (popup) popup.remove();
    const el = document.createElement('div');
    if (group.length > 1) {
      el.innerHTML = `<div class="popup-group-count">${group.length} restaurants at this spot</div>` +
        group.map(entity => `<div class="popup-group-entry">${entityHtml(entity)}</div>`).join('');
    } else {
      el.innerHTML = entityHtml(group[0]);
    }
    popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
      .setLngLat(coordinates)
      .setDOMContent(el)
      .addTo(map);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderList(entities) {
    const list = document.getElementById('story-list');
    const countEl = document.getElementById('result-count');
    countEl.textContent = `${entities.length} restaurant${entities.length === 1 ? '' : 's'}`;

    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    // Cap the rendered list for performance; the map always reflects the full filtered set.
    const toRender = entities.slice(0, 300);
    for (const entity of toRender) {
      const newest = entity.articles[0];
      const li = document.createElement('li');
      li.dataset.id = entity._id;
      const meta = [entity.cuisine, entity.neighborhood, newest.date].filter(Boolean).join(' · ');
      const articleCount = entity.articles.length > 1 ? ` · ${entity.articles.length} articles` : '';
      li.innerHTML = `
        <p class="story-name">${escapeHtml(entity.name)}</p>
        <p class="story-meta">${meta}${articleCount}</p>
        ${newest.excerpt ? `<p class="story-excerpt">${escapeHtml(newest.excerpt)}</p>` : ''}
      `;
      li.addEventListener('click', () => {
        map.flyTo({ center: [entity.lng, entity.lat], zoom: 16 });
        // Show just the restaurant that was clicked in the list, not every
        // other one that happens to share its location -- the searcher
        // already knows which one they're after.
        showGroupPopup([entity], [entity.lng, entity.lat]);
      });
      frag.appendChild(li);
    }
    list.appendChild(frag);
    if (entities.length > toRender.length) {
      const note = document.createElement('li');
      note.className = 'story-note';
      note.textContent = `+ ${entities.length - toRender.length} more -- refine your search to narrow the list.`;
      list.appendChild(note);
    }
  }

  function applyFilters() {
    const q = document.getElementById('search').value.trim().toLowerCase();
    const neighborhood = neighborhoodSelect.value;

    // A search term always searches every restaurant regardless of the
    // neighborhood filter -- so searching while zoomed into one neighborhood
    // still finds a match anywhere else in the city. The neighborhood
    // filter only narrows things down when the search box is empty.
    const filtered = allEntities.filter((entity) => {
      if (!q) {
        return !neighborhood || entity.neighborhood === neighborhood;
      }
      return (
        (entity.name && entity.name.toLowerCase().includes(q)) ||
        (entity.cuisine && entity.cuisine.toLowerCase().includes(q)) ||
        (entity.address && entity.address.toLowerCase().includes(q))
      );
    });

    if (map.getSource('restaurants')) {
      map.getSource('restaurants').setData(toGeoJSON(filtered));
    }
    highlightNeighborhood(neighborhood);
    renderList(filtered);
    pymChild.sendHeight();
  }

  // Outlines the chosen neighborhood and zooms to it; clearing the filter
  // (empty value) removes the outline and returns to the full-city view.
  function highlightNeighborhood(name) {
    if (!map.getLayer('neighborhood-highlight-outline')) return;
    const filterExpr = ['==', ['get', 'NAME'], name || ''];
    map.setFilter('neighborhood-highlight-fill', filterExpr);
    map.setFilter('neighborhood-highlight-outline', filterExpr);

    if (name) {
      const feature = neighborhoodFeatures.find(f => f.properties.NAME === name);
      if (feature) map.fitBounds(geometryBounds(feature.geometry), { padding: 40 });
    } else {
      map.easeTo({ center: CAMBRIDGE_CENTER, zoom: 12.5 });
    }
  }

  document.getElementById('search').addEventListener('input', debounce(applyFilters, 150));
  neighborhoodSelect.addEventListener('change', applyFilters);

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  window.addEventListener('resize', () => {
    map.resize();
    pymChild.sendHeight();
  });
});

// map.js — Cambridge Day restaurant map
document.addEventListener('DOMContentLoaded', async () => {
  const pymChild = new pym.Child();

  const CAMBRIDGE_CENTER = [-71.1097, 42.3736];

  const resp = await fetch('data/restaurants.json');
  const rawRows = await resp.json();

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
  allEntities.forEach((entity, i) => { entity._id = i; });

  const cuisineSelect = document.getElementById('cuisine-filter');
  const cuisines = [...new Set(allEntities.map(r => r.cuisine).filter(Boolean))].sort();
  for (const c of cuisines) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    cuisineSelect.appendChild(opt);
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
      const meta = [entity.cuisine, newest.date].filter(Boolean).join(' · ');
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
    const cuisine = cuisineSelect.value;

    const filtered = allEntities.filter((entity) => {
      if (cuisine && entity.cuisine !== cuisine) return false;
      if (!q) return true;
      return (
        (entity.name && entity.name.toLowerCase().includes(q)) ||
        (entity.cuisine && entity.cuisine.toLowerCase().includes(q)) ||
        (entity.address && entity.address.toLowerCase().includes(q))
      );
    });

    if (map.getSource('restaurants')) {
      map.getSource('restaurants').setData(toGeoJSON(filtered));
    }
    renderList(filtered);
    pymChild.sendHeight();
  }

  document.getElementById('search').addEventListener('input', debounce(applyFilters, 150));
  cuisineSelect.addEventListener('change', applyFilters);

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

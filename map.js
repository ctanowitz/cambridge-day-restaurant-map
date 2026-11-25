// map.js — Cambridge Day restaurant map
document.addEventListener('DOMContentLoaded', async () => {
  const pymChild = new pym.Child();

  const CAMBRIDGE_CENTER = [-71.1097, 42.3736];

  const resp = await fetch('data/restaurants.json');
  const allRestaurants = await resp.json();

  // Stable id per restaurant so popups/list selection can refer back to a feature.
  allRestaurants.forEach((r, i) => { r._id = i; });

  const cuisineSelect = document.getElementById('cuisine-filter');
  const cuisines = [...new Set(allRestaurants.map(r => r.cuisine).filter(Boolean))].sort();
  for (const c of cuisines) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    cuisineSelect.appendChild(opt);
  }

  function toGeoJSON(restaurants) {
    return {
      type: 'FeatureCollection',
      features: restaurants.map(r => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
        properties: r,
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
      data: toGeoJSON(allRestaurants),
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
        'circle-radius': 7,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    });

    map.on('click', 'clusters', (e) => {
      console.warn('DEBUG cluster click fired, point=', e.point);
      const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
      console.warn('DEBUG features found:', features.length);
      const clusterId = features[0].properties.cluster_id;
      console.warn('DEBUG clusterId=', clusterId, typeof clusterId);
      map.getSource('restaurants').getClusterExpansionZoom(clusterId, (err, zoom) => {
        console.warn('DEBUG getClusterExpansionZoom callback: err=', err, 'zoom=', zoom);
        if (err) return;
        map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });
    });

    map.on('click', 'unclustered-point', (e) => {
      showPopup(e.features[0]);
    });

    map.on('mouseenter', 'clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'clusters', () => { map.getCanvas().style.cursor = ''; });
    map.on('mouseenter', 'unclustered-point', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'unclustered-point', () => { map.getCanvas().style.cursor = ''; });

    renderList(allRestaurants);
    setTimeout(() => pymChild.sendHeight(), 300);
  });

  function showPopup(feature) {
    const r = feature.properties;
    if (popup) popup.remove();
    const el = document.createElement('div');
    el.innerHTML = `
      <div class="popup-name">${escapeHtml(r.name)}</div>
      ${r.cuisine ? `<div class="popup-cuisine">${escapeHtml(r.cuisine)}</div>` : ''}
      ${r.address ? `<div class="popup-address">${escapeHtml(r.address)}</div>` : ''}
      ${r.excerpt ? `<p class="popup-excerpt">${escapeHtml(r.excerpt)}</p>` : ''}
      ${r.url ? `<a class="popup-link" href="${r.url}" target="_blank" rel="noopener">Read the article →</a>` : ''}
    `;
    popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
      .setLngLat(feature.geometry.coordinates)
      .setDOMContent(el)
      .addTo(map);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderList(restaurants) {
    const list = document.getElementById('story-list');
    const countEl = document.getElementById('result-count');
    countEl.textContent = `${restaurants.length} restaurant${restaurants.length === 1 ? '' : 's'}`;

    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    // Cap the rendered list for performance; the map always reflects the full filtered set.
    const toRender = restaurants.slice(0, 300);
    for (const r of toRender) {
      const li = document.createElement('li');
      li.dataset.id = r._id;
      li.innerHTML = `
        <p class="story-name">${escapeHtml(r.name)}</p>
        <p class="story-meta">${[r.cuisine, r.date].filter(Boolean).join(' · ')}</p>
        ${r.excerpt ? `<p class="story-excerpt">${escapeHtml(r.excerpt)}</p>` : ''}
      `;
      li.addEventListener('click', () => {
        map.flyTo({ center: [r.lng, r.lat], zoom: 16 });
        showPopup({ properties: r, geometry: { coordinates: [r.lng, r.lat] } });
      });
      frag.appendChild(li);
    }
    list.appendChild(frag);
    if (restaurants.length > toRender.length) {
      const note = document.createElement('li');
      note.className = 'story-note';
      note.textContent = `+ ${restaurants.length - toRender.length} more -- refine your search to narrow the list.`;
      list.appendChild(note);
    }
  }

  function applyFilters() {
    const q = document.getElementById('search').value.trim().toLowerCase();
    const cuisine = cuisineSelect.value;

    const filtered = allRestaurants.filter((r) => {
      if (cuisine && r.cuisine !== cuisine) return false;
      if (!q) return true;
      return (
        (r.name && r.name.toLowerCase().includes(q)) ||
        (r.cuisine && r.cuisine.toLowerCase().includes(q)) ||
        (r.address && r.address.toLowerCase().includes(q))
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

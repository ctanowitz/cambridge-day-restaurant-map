# Cambridge Day Restaurant Map

An interactive map of every restaurant mentioned in Cambridge Day's Food + Drink
coverage, with clustering, search, a cuisine filter, and a synced story list —
built the same way Mission Local's neighborhood story maps work (MapLibre GL +
clustering + Pym.js for responsive iframe embedding), but using free, no-API-key
basemap tiles (OpenFreeMap) instead of Mapbox.

**Live:** `https://<your-username>.github.io/cambridge-day-restaurant-map/`
(enabled via GitHub Pages — see below)

## How it's built

- `index.html` / `map.js` / `styles.css` — a plain static page, no build step.
  MapLibre GL JS renders the map; `data/restaurants.json` is loaded client-side
  and added as a clustered GeoJSON source.
- `data/restaurants.json` — the dataset. Committed to the repo so the page has
  no backend to call.
- `export_data.py` — a **local-only** tool (not part of the deployed site) that
  regenerates `data/restaurants.json` from the Cambridge Day restaurant Google
  Sheet (the one built by the separate `Cambridge Day Restaurants` scraper
  project). It reuses that project's existing Google OAuth credentials rather
  than needing its own.

## Updating the data

Whenever the scraper finds new restaurants and you want the map to reflect them:

```bash
python3 export_data.py   # regenerates data/restaurants.json
git add data/restaurants.json
git commit -m "Update restaurant data"
git push
```

(Run this with a Python that has `google-auth`, `google-auth-oauthlib` and
`google-api-python-client` installed — the scraper project's venv already does.)

## Embedding in Cambridge Day's WordPress site

Add a **Custom HTML** block with:

```html
<div id="cambridgeday-map"></div>
<script src="https://pym.nprapps.org/pym.v1.min.js"></script>
<script>
  new pym.Parent('cambridgeday-map', 'https://<your-username>.github.io/cambridge-day-restaurant-map/', {});
</script>
```

Pym.js keeps the iframe's height in sync with the map's content automatically.

## Enabling GitHub Pages (one-time)

In the repo's Settings → Pages, set **Source** to "Deploy from a branch",
branch `main`, folder `/ (root)`.

# Frontend structure

The frontend keeps route-level orchestration in `pages/` and reusable UI in `components/`.

## Main folders

- `pages/`: route screens. These should coordinate state, permissions, API calls, and route composition.
- `components/`: reusable visual pieces. Domain-specific components live in a matching subfolder, for example `components/adminMunicipal/` or `components/map/`.
- `lib/`: shared client helpers, API wrappers, routing, context, and pure utility functions.
- `styles.css`: stylesheet entrypoint only. Actual rules are split under `styles/` and imported in cascade order.
- `styles/`: global CSS modules grouped by surface. Keep imports ordered in `styles.css` when adding a new module.
- `lib/googleMapTiles.js`: shared Google Map Tiles API setup for Leaflet base maps, with OpenStreetMap fallback.
- `lib/googleIdentity.js`: Google Identity Services loader for the Sign in with Google button.

## Refactor convention

Prefer this shape for large React files:

1. Keep business state and effects in the route/container file.
2. Move repeated JSX into a component file.
3. Move pure calculations and labels into `lib/`.
4. Keep backend contracts and route boundaries unchanged.

For this project, keep the citizen potholes flow, municipal admin flow, and internal developer panel separated.

## Maps

The main map components keep Leaflet for overlays, markers, routes, and controls. Base tiles are provided by Google Maps Platform Map Tiles API through `lib/googleMapTiles.js`.

Use `VITE_GOOGLE_MAPS_API_KEY` for local/dev keys. If Google is unavailable or the key is missing, the helper falls back to OpenStreetMap so the app does not render a blank map.

## Auth

`components/auth/LoginModal.jsx` owns the user-facing login and registration flow. Google Sign-In requires `VITE_GOOGLE_CLIENT_ID`; email registration creates only `difusor` users.

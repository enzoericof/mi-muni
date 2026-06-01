# Mi Muni - Agent Context

This file is the working reference for agents editing this repository.

## 1. Project purpose

Mi Muni is an academic civic web platform for Asuncion. The product is organized around 4 major capabilities:

1. municipal procedures and project information
2. Munita, the AI + RAG assistant for municipal questions
3. real-time collection tracking
4. pothole reporting, confirmation, and prioritization

Keep those 4 capabilities visible in any major architectural or product decision.

## 2. Current route model

Public routes:

- `/` landing
- `/munita`
- `/recoleccion`
- `/baches`
- `/perfil` role-specific user profile

Internal routes:

- `/desarrollador`
- `/admin-muni`

Legacy aliases:

- `/ciudad` -> `/`
- `/mapa` -> `/recoleccion`
- `/mapa-basura` -> `/recoleccion`
- `/admin-interno` -> `/desarrollador`
- `/admin` -> `/desarrollador`
- `/admin-recoleccion` -> `/desarrollador`

Important separation rule:

- `/baches` is only for the common citizen
- `/desarrollador` is the developer panel for technical controls: collection simulation, RAG runtime, manual spider runs, and technical scripts
- `/admin-muni` is the administrator panel for municipal pothole operations

Do not merge those roles again.
Admin and developer users may navigate back to normal public surfaces from their headers.
Do not surface admin controls inside the public citizen flow.

## 3. Stack

- frontend: React 18 + Vite
- maps: Leaflet overlays + Google Maps Platform Map Tiles API base tiles, with OpenStreetMap fallback
- backend: Node.js + Express
- database: PostgreSQL
- optional LLM layer: OpenAI
- frontend animation layer: Framer Motion for small, purposeful hero/UI animations
- image storage: Vercel Blob
- deployment: Vercel + Neon

The project uses ES modules.

## 4. Key directories

```text
api/                 Vercel serverless entry
server/
  app.js             Express app factory and routes
  index.js           local backend entry point
  db/                schema init and seed logic
  lib/               domain logic: rag, collection, potholes, text, env
  data/              geojson, service plan, corpus data
  scripts/           corpus and collection asset builders
  spider/            Playwright RAG spider worker for explicit manual crawls
src/
  README.md          frontend structure and refactor conventions
  App.jsx            pathname-based route switch
  pages/             route-level screens
  components/        reusable UI components grouped by surface/domain
    adminMunicipal/  presentational pieces for `/admin-muni`
    map/             Leaflet maps plus shared map UI helpers
  lib/               router, api, app context, helpers, pure utilities, Google tile setup
  styles.css         global stylesheet entrypoint only
  styles/            split CSS modules imported by `styles.css`
PLAN_RAG_SPIDER.md   implemented academic RAG architecture: manual spider, pgvector hybrid search, source health, and municipal catalog
```

## 5. Core product surfaces

### 5.1 Munita + Info

The AI assistant is named Munita. In prompts, UI, docs, and fallback responses, call it Munita.
Do not present it as "asistente municipal" or any other generic assistant name.

Main files:

- `server/lib/rag.js`
- `server/lib/openai.js`
- `server/db/rag-seed.js`
- `src/pages/MunitaPage.jsx`
- `src/pages/TramitesPage.jsx`
- `src/components/info/InfoSections.jsx`
- `src/components/search/*`
- `src/components/search/MunitaAvatar.jsx`
- `src/components/home/HeroChat.jsx`

Behavior:

- works without OpenAI when `OPENAI_ENABLED=false`; in that mode it is mostly lexical retrieval over the stored corpus
- uses the manual structured procedures corpus as the stable fallback base, while connected spider content can take priority when available
- should prefer official municipal sources
- `/munita` is only the Munita assistant surface
- `/tramites` and `/info` share the same page; navigation should say "Info", not "Trámites & Info"
- `/tramites`/`/info` combines procedure access first and project information below it
- the home hero can send a prefilled query to Munita; keep that flow functional
- Munita conversation state must persist while navigating around the app
- assistant bubbles should show the current logged-in user's name for user messages
- chat messages should show a minimal date/time
- Munita's mascot/avatar is shared through `MunitaAvatar.jsx`; reuse it instead of duplicating inline SVG or plain "M" badges

RAG reality check:

- the current system is an academic-solid RAG, not a production-heavy managed vector platform
- manual documents in `server/data/manual/asuncionManualDocs.js` seed `rag_procedures` and `rag_chunks`
- `server/scripts/fetchSources.js` scrapes only the fixed URLs in `server/data/sources/asuncionSources.js`; it is not a recursive crawler
- `RAG_SYNC_ON_BOOT=true` can seed snapshot chunks from `server/data/raw/asuncion-snapshots.json`
- embeddings are generated only when `OPENAI_ENABLED=true` and `OPENAI_API_KEY` is present
- embeddings are stored as JSON text for compatibility and as `embedding_vector vector(1536)` when pgvector is available
- retrieval is hybrid: PostgreSQL full-text search via `search_vector`, pgvector cosine similarity when available, and in-memory lexical/JSON fallback
- this is Postgres + pgvector; it is still not Pinecone/Qdrant/Chroma
- the manual RAG spider lives in `server/spider/index.js` and is documented in `PLAN_RAG_SPIDER.md`
- it adds configurable seed URLs, same-hostname recursive crawling, artifact storage, raw page records, assets, index items, and publication records used to connect sources to Munita
- it extracts real PDF text with `pdf-parse` when possible, stores raw HTML/text snapshots, tracks hashes, versions, previous content, source health, and suggested recrawl status
- spider-approved content is chunked into existing `rag_chunks` and embeddings are optional with OpenAI
- the spider must never crawl automatically on a timer or polling interval; it runs only after an explicit developer action
- crawled content is separated by municipality, source type, catalog item, and publication state so Munita can connect only the selected sources to its public index
- `npm run rag:evaluate` runs a small academic retrieval/fallback quality dataset from `server/data/eval/ragQuestions.js`

RAG pipeline current state (as of May 2026):

- the real pipeline is: spider crawl → `rag_crawled_pages` → `rag_index_items` → `rag_info_publication` visibility toggle → index rebuild → `rag_chunks` → Munita
- `rag_procedures` is still seeded from manual documents in `server/db/rag-seed.js`; the spider does not write new rows there by default
- the rebuild step now derives `categoria` and `tipo` from each `rag_index_items` source instead of flattening everything to `institucional` / `informacion`
- the spider strips repeated municipal boilerplate/navigation text before indexing and chunking, so topbar chrome does not keep polluting summaries or semantic retrieval
- `/desarrollador` is the operational surface for Munita RAG: source health, crawl jobs, source connection/disconnection, bulk connect/disconnect, index rebuild, runtime reload, embedding rebuild, paginated embedding detail inspection, and connected-embedding cleanup
- Munita now prefers connected spider chunks first; if spider evidence is absent or weak, it falls back to the manual procedures corpus
- the municipality selector in the topbar is dynamic: it reads `/api/rag/active-municipalities` and shows municipalities that already have spider seeds and/or imported civic geography in DB; falls back to the static list if the endpoint is unreachable
- the chunk limit input in `/desarrollador` uses `ragRuntime?.counts?.chunks` as its `max` attribute so it tracks the real connected chunk count at runtime

Pending step — semantic embeddings:

Munita works today via lexical FTS. To activate semantic (vector) search:

1. Edit `.env.local`:
   ```
   OPENAI_ENABLED=true
   OPENAI_API_KEY=sk-...   # obtain at platform.openai.com
   ```
2. Restart the backend container: `docker restart municipal-rag-backend`
3. In `/desarrollador`, click **"Regenerar busqueda"** — calls `POST /api/admin/rag/embeddings/rebuild`; generates `text-embedding-3-small` vectors for all connected/public chunks; activates the `vectorSimilarity * 16` and in-memory `embeddingScore (cosine * 20)` scoring paths
4. Confirm in the developer panel status strip that the "Embeddings" counter rises above 0

No code changes are needed; only the env var and the one-click rebuild.

### 5.2 Collection module

Main files:

- `server/lib/collectionCore.js`
- `server/lib/collectionSimulation.js`
- `server/lib/collectionInsights.js`
- `server/lib/collectionRuntime.js`
- `server/db/collection-seed.js`
- `src/pages/MapaPage.jsx`
- `src/components/map/TrashMap.jsx`
- `src/components/map/TrashMapControls.jsx`
- `src/components/map/TrashNotificationSheet.jsx`
- `src/components/map/MapIcons.jsx`
- `src/lib/googleMapTiles.js`

Behavior:

- simulated collection model is the source of truth
- GTFS and GTFS-RT are compatibility and export layers
- simulation can be turned on or off
- public map is separate from the internal control panel
- the public map must center on the municipality selected in the topbar
- barrios for the active municipality must be selectable from the list and by clicking the map whenever polygon geometry exists
- Recolección may run in two modes: full simulated coverage for Asuncion, or geo-only coverage for municipalities that already have `municipal_barrios` but not route assets yet
- geo-only municipalities should still expose municipality center/bbox and barrio selection; they should not fake routes or vehicle simulation
- map base tiles should load through `src/lib/googleMapTiles.js`
- UI copy should say "Recolección", not "Basura", except in legacy aliases or historical compatibility notes
- the notification bell belongs with the other top-right map controls and should be ordered consistently
- the "Ir a mi ubicación" control should work like the Baches location control

Important:

- `zone_id` in public endpoints now maps to barrio slug or id
- collection simulation may be intentionally off in production to reduce cost

### 5.3 Potholes module

Main files:

- `server/lib/potholes.js`
- `server/lib/text.js`
- `server/app.js`
- `src/pages/BachesPage.jsx`
- `src/components/map/PotholesMap.jsx`
- `src/components/map/MapIcons.jsx`
- `src/lib/googleMapTiles.js`

Behavior:

- `/baches` is map-first and citizen-facing
- login is required to use the public potholes module
- reports are consolidated by spatial proximity into incidents
- users can confirm an incident once
- photos are optional
- location selection uses the fixed-center pin flow
- map base tiles should load through `src/lib/googleMapTiles.js`
- location picking should keep the mobile bottom sheet ergonomic; action buttons must not overlap on narrow screens
- the fixed-center pin flow should show a context pill "Baches" above the secondary kicker text such as "Elegí el punto"
- the report form should show a context pill "Baches" above the secondary kicker text "Nuevo reporte"

Public pothole experience should stay simple:

- view potholes
- report pothole
- confirm pothole

Do not surface municipal admin controls in the public potholes UI.

## 6. Admin surfaces

### 6.1 `/desarrollador`

Purpose:

- developer-only panel for technical operations: collection simulation, Munita RAG runtime, manual spider jobs, source connection, and script-like maintenance actions

Must include:

- app auth session with `desarrollador` role
- current technical runtime state
- collection simulation toggle
- manual RAG spider controls
- the visible "Prender/Apagar spider" operation toggle before manual crawl execution
- compact municipal workflow: municipality/domain first, then one or more seed URLs, then execution queue
- Paraguay municipalities seeded from INE/Datos.gov.py CNPV 2022 district GeoJSON, with seed counts visible
- municipality bootstrap for official barrios from INE plus manual barrio import from `GeoJSON` / `JSON` / `CSV` without needing OpenAI
- a manual municipality creation path for exceptional cases where a city is not already in the seeded Paraguay catalog
- technical RAG actions such as approved-index rebuild/reload
- visibility controls for spider sources that will or will not connect to Munita
- bulk connect/disconnect actions per municipality for Munita's consultable index
- runtime visibility over spider items, connected chunks, and spider embeddings
- a separate embeddings detail view for connected chunks, including JSON/vector coverage
- a developer action to clear connected embeddings without removing the connected chunks themselves
- source-health checks and manual embedding reindexing
- normal navigation to the public app surfaces
- visual language should stay consistent with `/admin-muni`

Must not include:

- municipal dashboards
- pothole admin lists
- citizen-facing Munita UI controls

### 6.2 `/admin-muni`

Purpose:

- administrator-only panel for municipal pothole operations

Expected scope:

- see incidents
- inspect evidence
- view report and confirmation counts
- change status
- prioritize repair work
- keep the General view as the operational home for Baches: analytics on top, then queue + map + detail
- keep the queue ordered from most severe to least severe, with abiertos before reparados and a single active ordering dimension: prioridad, impacto, or riesgo
- keep the incident timeline consolidated across grouped reports, including report creation, status changes, and confirmations
- normal navigation to the public app surfaces
- modern operational dashboard layout with analytics, map, and editable queue
- visual language should stay consistent with `/desarrollador`

Must not include:

- collection simulation controls
- Munita RAG source connection controls
- Docker or script controls
- technical RAG runtime toggles

Frontend files:

- `src/pages/AdminMunicipalPage.jsx` coordinates auth/session state, API calls, filters, and page composition
- `src/components/adminMunicipal/*` contains presentational sections for heading, login gate, analytics, and editable queue
- `src/lib/adminMunicipalUtils.js` contains pure labels, summaries, incident clustering, distributions, and sorting helpers

### 6.3 `/perfil`

Purpose:

- role-specific profile for authenticated users

Roles:

- `difusor`: can report potholes, configure route-start notifications for a barrio, and see own report counts plus solved reports
- `recolector`: can choose barrio and route, start/end a shift, and send browser geolocation periodically while online
- `admin`: uses `/admin-muni`; can manage potholes and municipal repair workflow
- `desarrollador`: uses `/desarrollador`; can control collection simulation, Munita RAG runtime, manual RAG spider jobs, source-health checks, source connection, embedding reindexing, and technical rebuild/reload actions

Current auth roles:

- `admin`
- `desarrollador`
- `difusor`
- `recolector`

## 7. Environment variables

Main env vars:

- `DATABASE_URL`
- `JWT_SECRET`
- `APP_ORIGIN`
- `CORS_ORIGINS`
- `VITE_API_BASE_URL`
- `OPENAI_ENABLED`
- `OPENAI_API_KEY`
- `OPENAI_CHAT_MODEL`
- `OPENAI_EMBEDDING_MODEL`
- `RAG_SYNC_ON_BOOT`
- `RAG_SPIDER_ENABLED`
- `RAG_SPIDER_INTERNAL_URL`
- `RAG_ARTIFACT_DIR`
- `RAG_PUBLIC_INDEX_ENABLED`
- `GTFS_FORCE_RESEED`
- `COLLECTION_ADMIN_TOKEN`
- `COLLECTION_ADMIN_USERNAME`
- `COLLECTION_ADMIN_PASSWORD`
- `BLOB_READ_WRITE_TOKEN`
- `VITE_GOOGLE_MAPS_API_KEY`
- `VITE_GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_IDS`

Google Sign-In notes:

- Google auth requires OAuth Web Client IDs; `VITE_GOOGLE_MAPS_API_KEY` is only for map tiles.
- Local client ID: `45586226543-1ajql78s9m47un5svfk1ltlmbp02sh6m.apps.googleusercontent.com`.
- Vercel client ID: `45586226543-p1oeh805ik5ej7upcgdulleqvq0idele.apps.googleusercontent.com`.
- Google Cloud authorized origins should include `http://127.0.0.1:4173`, `http://localhost:4173`, and `https://proyecto-municipalidad.vercel.app` when those environments are used.
- On Vercel, set `VITE_GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_ID` to the Vercel client ID, then redeploy because Vite reads `VITE_...` at build time.
- `GOOGLE_CLIENT_IDS` is an optional comma-separated backend allowlist when more than one OAuth client must be accepted.
- `POST /api/auth/google` accepts `mode: "login" | "register"`; login must reject unknown Google users, while register may create/link a `difusor` account.
- Production auth also needs `JWT_SECRET` plus `APP_ORIGIN` and/or `CORS_ORIGINS` including `https://proyecto-municipalidad.vercel.app`; otherwise writes can fail with `origin-forbidden`.

Safe defaults for local development:

```env
OPENAI_ENABLED=false
RAG_SYNC_ON_BOOT=false
RAG_SPIDER_ENABLED=false
RAG_SPIDER_INTERNAL_URL=
RAG_ARTIFACT_DIR=server/data/rag-artifacts
RAG_PUBLIC_INDEX_ENABLED=false
GTFS_FORCE_RESEED=false
VITE_GOOGLE_MAPS_API_KEY=
VITE_GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_IDS=
```

## 8. Important backend endpoints

Health:

- `GET /api/health`

Auth and profiles:

- `POST /api/auth/login`
- `POST /api/auth/register-difusor`
- `POST /api/auth/google`
- `GET /api/auth/session`
- `DELETE /api/auth/session`
- `GET /api/profile/difusor`
- `GET /api/profile/recolector`
- `POST /api/recolector/shifts`
- `POST /api/recolector/shifts/:id/positions`
- `DELETE /api/recolector/shifts/:id`

RAG:

- `GET /api/rag/catalog`
- `GET /api/rag/procedure/:id`
- `GET /api/rag/procedure/:id/section/:section`
- `GET /api/rag/search`
- `POST /api/rag/ask`

RAG Spider admin endpoints:

- developer-facing endpoints under `/api/admin/rag/*` create municipalities, seed URLs, check source health, start/cancel manual crawl jobs, control runtime, connect or disconnect spider sources to Munita, rebuild/reload indexes, and reindex embeddings
- current developer technical endpoints include `POST /api/admin/rag/seed-urls/:id/check`, `GET /api/admin/rag/source-health`, `GET /api/admin/rag/catalog`, `PATCH /api/admin/rag/info-publication/:id`, `POST /api/admin/rag/info-publication/bulk`, `POST /api/admin/rag/index/rebuild`, `POST /api/admin/rag/embeddings/rebuild`, `GET /api/admin/rag/embeddings`, and `DELETE /api/admin/rag/embeddings`
- backend permissions must keep developer spider/runtime controls separate from municipal pothole operations

Collection:

- `GET /api/collection/zones`
- `GET /api/collection/map`
- `GET /api/collection/overview`
- `GET /api/gtfs-rt/vehicle-positions`
- `GET /api/gtfs-rt/trip-updates`

Potholes public:

- `GET /api/potholes/map`
- `GET /api/potholes/reports`
- `GET /api/potholes/reports/:id`
- `POST /api/potholes/reports`
- `POST /api/potholes/reports/:id/confirmations`

Potholes municipal admin:

- `GET /api/admin/potholes/dashboard`
- `GET /api/admin/potholes/reports`
- `PATCH /api/admin/potholes/reports/:id`

## 9. Frontend architecture notes

- `src/App.jsx` is the pathname-based route switch
- `src/lib/router.js` normalizes aliases and query params
- `src/lib/AppContext.jsx` stores user, municipality, guest quota, and login modal state
- `src/components/auth/LoginModal.jsx` handles login, Google Sign-In, and difusor email registration
- `src/components/layout/Header.jsx` contains the main nav and mobile drawer
- `src/styles.css` is only the global styling entrypoint
- `src/styles/` contains the actual CSS split by surface; keep imports in `src/styles.css` ordered to preserve cascade
- `src/README.md` explains the frontend folder structure and refactor convention
- route pages in `src/pages/` should coordinate state, effects, permissions, API calls, and composition
- repeated JSX should live in `src/components/`, grouped by domain or shared surface
- pure calculations, labels, and sorting helpers should live in `src/lib/`
- do not move React JSX into external `.html` templates; split large `return` blocks into smaller React components instead
- shared map controls/icons should reuse `src/components/map/MapIcons.jsx` and nearby map UI helpers
- Google map base tiles are centralized in `src/lib/googleMapTiles.js`; do not duplicate Google session/token logic inside map components
- if Google Map Tiles API is unavailable or `VITE_GOOGLE_MAPS_API_KEY` is missing, maps should keep the OpenStreetMap fallback instead of rendering blank
- Google Sign-In uses Google Identity Services with `VITE_GOOGLE_CLIENT_ID` on the frontend and `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_IDS` on the backend; a Maps API key is not enough for auth
- public self-registration is only for `difusor` users
- `src/pages/AdminInternalPage.jsx` now keeps the main Munita card focused on summary actions/metrics, and uses a separate paginated detail view for connected chunks and embeddings
- `src/pages/AdminMunicipalPage.jsx` should stay as the admin-muni orchestrator; keep analytics, heading, login, and queue markup in `src/components/adminMunicipal/`
- `src/components/home/SplitHero.jsx` uses Framer Motion; keep hero animation subtle and avoid layout shifts or transient scrollbars
- map select controls use custom CSS arrows; keep arrow padding with enough right-side space so chevrons do not touch borders
- avoid one-off pills in Baches sheet subtitles; use the page/context pill for "Baches" and plain uppercase kicker text for the local step
- labels should be accent-correct Spanish; prefer "Recolección", "Ubicación", "Elegí", "Nuevo reporte", and "Info"

When editing routes, update both:

- `src/App.jsx`
- `src/lib/navigation.js` if the route is public

Do not add internal admin routes to the public navigation.

## 10. Data and simulation notes


Collection:

- source assets live in `server/data/`
- route geometry and barrio boundaries should not be recomputed per request
- live truck positions are interpolated, not GPS-backed
- `municipal_barrios` is the shared civic geography source for Baches and for municipality-aware centering/selection in Recolección
- only Asuncion is currently full-simulation-ready by default; additional municipalities become geo-ready first, and need separate route assets before they can show simulated collection routes
- production may use Google Maps tiles when `VITE_GOOGLE_MAPS_API_KEY` is configured; local/dev may fall back to OpenStreetMap
- generated route geometry comes from `server/scripts/buildCollectionAssets.py`
- the street graph builder must respect shapefile multipart boundaries (`shape.parts`); if it chains separate parts as one line, simulated trucks can appear to cross blocks unrealistically
- after changing `server/data/collection-service-plan.json` or `server/data/calles-asu.graph.json`, force a collection reseed so `collection_route_shapes`, `collection_runs`, and GTFS compatibility tables pick up the new geometry

Potholes:

- incidents are deduplicated by proximity
- confirmations are social proof and should influence prioritization
- priority should reflect both impact and risk
- keep text normalization centralized in `server/lib/text.js`

RAG:

- `npm run corpus:fetch` fetches only configured sources, not the whole municipal site
- `npm run corpus:build` updates embeddings for existing DB chunks when OpenAI is enabled
- `npm run rag:evaluate` runs the small academic RAG quality dataset
- municipality seed data comes from `server/data/municipalities/paraguayMunicipalities.js`, generated from the INE/Datos.gov.py CNPV 2022 `DISTRITOS_PY_CNPV2022.geojson` resource
- describe the current RAG as academic Postgres + pgvector hybrid retrieval with manual Playwright spider, not as production-heavy managed vector infrastructure
- recursive crawling belongs to the manual Playwright spider described in `PLAN_RAG_SPIDER.md`
- spider jobs are explicit developer-triggered runs; do not add interval polling, cron-like auto-crawls, or "run every N seconds" behavior
- RAG spider data must stay separated by municipality and source type: HTML pages, PDFs, images, normalized index items, and publication records that control which sources connect to Munita

## 11. Development workflow

Local:

```powershell
npm install
npm run dev:front
npm run dev:back
```

Convenience scripts:

```powershell
npm run local:start
npm run local:stop
npm run build
npm run rag:evaluate
```

Useful health URL:

- `http://127.0.0.1:8787/api/health`

## 12. Guardrails for agents

- prefer updating docs when routes, env vars, or product surfaces change
- keep citizen, municipal, and internal admin roles separated
- avoid reintroducing noisy dashboard text into public citizen flows
- keep Baches map-first
- keep Collection simulation controllable and cost-aware
- keep Munita history persistent across route changes
- keep Munita retrieval ordered as connected spider sources first, manual fallback second unless a deliberate product change says otherwise
- preserve the admin visual consistency between internal/developer and municipal panels
- do not assume production is using the latest deploy without checking
- if mojibake appears, fix both the visible UI string and the shared normalization helper if needed
- after frontend visual changes, run `npm run build` and inspect the affected local route when practical
- commits should keep the local project author (`FedericoAB <federi.al77@hotmail.com>`) and add `Co-authored-by: CODEX <codex@openai.com>` in the commit message trailer

## 13. Team

Project team:

- Enzo Erico
- Horacio Aranda
- Federico Alonso

Context:

- academic project for Ingenieria del Software
- Universidad Catolica "Nuestra Señora de la Asuncion"
- professor: PhD Luca Cernuzzi

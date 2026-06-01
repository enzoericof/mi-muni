# Mi Muni

Mi Muni es una plataforma académica para centralizar servicios municipales de Asunción en una sola experiencia web. Hoy el proyecto gira alrededor de 4 funcionalidades principales:

- trámites e información municipal
- consultas frecuentes con Munita, la asistente virtual + RAG
- seguimiento de recolección de residuos
- reporte y confirmación de baches

## Estado actual

El sistema hoy está separado en 5 superficies claras:

- `/` inicio público
- `/munita` asistente virtual Munita
- `/recoleccion` mapa público de recolección
- `/baches` mapa público de baches

Y 2 paneles especializados:

- `/desarrollador` panel del desarrollador para simulación, RAG, spider manual y scripts
- `/admin-muni` panel municipal para gestión de baches

Alias vigentes actualmente.

- `/ciudad` -> `/`
- `/mapa` -> `/recoleccion`
- `/mapa-basura` -> `/recoleccion`
- `/admin-interno` -> `/desarrollador`
- `/admin` -> `/desarrollador`
- `/admin-recoleccion` -> `/desarrollador`

## Módulos

### 1. Trámites, Info + Munita

- buscador de procedimientos municipales
- página combinada de trámites e información del proyecto
- Munita como superficie separada para consultas y acceso rápido desde Inicio
- conversación persistente al navegar por la app
- nombre del usuario y fecha/hora en los mensajes
- respuestas estructuradas por secciones
- asistente RAG académico con documentos manuales, snapshots fijos, spider manual, pgvector opcional y búsqueda híbrida
- OpenAI opcional

El RAG actual ya usa `Postgres + pgvector` cuando la extensión está disponible, mantiene fallback textual/JSON para entornos simples, extrae texto de PDFs descargados y opera con un flujo manual documentado en [`PLAN_RAG_SPIDER.md`](./PLAN_RAG_SPIDER.md). Los crawls se ejecutan solo por acción explícita del rol `desarrollador`; no hay cron, polling ni recrawls automáticos.

El catálogo de municipalidades del panel desarrollador se inicializa desde `server/data/municipalities/paraguayMunicipalities.js`, generado a partir del recurso oficial INE/Datos.gov.py `DISTRITOS_PY_CNPV2022.geojson` del dataset CNPV 2022.

#### Pipeline RAG — estado actual

El flujo vigente de Munita es:

- `rag_procedures` sigue siendo la base manual sembrada desde `server/db/rag-seed.js`
- el spider guarda contenido normalizado en `rag_index_items`
- desde `/desarrollador` se puede ver qué fuentes spider están conectadas a Munita, conectarlas o desconectarlas de forma individual o masiva, y reconstruir el índice
- `/desarrollador` deja el bloque principal de Munita como resumen operativo de acciones + métricas, y mueve el detalle paginado de chunks/embeddings a una vista separada
- la reconstrucción pasa lo visible a `rag_chunks` y ahora deriva `categoria` y `tipo` reales por fuente en vez de forzar todo a `institucional / informacion`
- el spider limpia boilerplate repetido del sitio municipal antes de resumir, indexar y chunkear contenido, para no contaminar el índice con navegación repetida como `Inicio`, `Intendencia` o `Trámites`
- Munita intenta responder primero con chunks conectados del spider y, solo si no encuentra evidencia suficiente, cae al corpus manual
- el selector de municipalidad en el topbar es dinámico: lee de `/api/rag/active-municipalities` y muestra solo municipalidades con seeds activos en DB
- el límite de chunks en `/desarrollador` es dinámico: se ajusta al total real de chunks conectados en runtime

Con esto, el panel técnico que controla el RAG consultable de Munita es `/desarrollador`. `/admin-muni` queda centrado en la operación de baches.

#### Activar embeddings semánticos (paso pendiente)

Sin embeddings, Munita funciona correctamente vía FTS lexical. Los embeddings mejoran las consultas semánticas donde las palabras exactas no aparecen en el chunk relevante.

**Cuando se tenga la API key:**

1. Editar `.env.local`:
   ```env
   OPENAI_ENABLED=true
   OPENAI_API_KEY=sk-...
   ```
   Obtener la key en [platform.openai.com](https://platform.openai.com).

2. Reiniciar el backend para que tome la nueva config:
   ```powershell
   docker restart municipal-rag-backend
   ```

3. En `/desarrollador` → clic en **"Regenerar búsqueda"**.
   Esto llama `POST /api/admin/rag/embeddings/rebuild`, genera vectores `text-embedding-3-small` para todos los chunks conectados/publicados y activa el scoring vectorial (`cosine × 20`) en cada request de Munita.

4. Verificar en el panel que el contador de embeddings suba de 0 a N en la tarjeta "Embeddings".

Si hace falta depurar el índice semántico, el mismo panel ahora permite:

- abrir una vista separada con el detalle de chunks conectados y su cobertura `JSON` / `vector`
- revisar ese detalle en una tabla paginada para inspeccionar mejor fuentes y previews largos
- borrar embeddings conectados por municipalidad sin desconectar las fuentes ni borrar los chunks

### 2. Recolección

- barrios reales de Asunción
- simulación de camiones sobre recorridos
- overview por barrio
- capa GTFS / GTFS-RT compatible
- switch de encendido y apagado desde el panel del desarrollador
- avisos de recolección desde el mapa
- el mapa público ahora se centra según la ciudad elegida en el topbar
- las municipalidades con barrios cargados pueden seleccionar barrio desde la lista y, si tienen polígonos, también con click directo en el mapa
- Asunción sigue siendo la única ciudad con simulación/rutas completas por defecto; las demás pueden quedar en modo `geo-only` hasta que se carguen assets propios de recolección

### 3. Baches

- mapa público orientado a reportar y confirmar
- login demo obligatorio para usar el módulo
- selección de ubicación tipo pin fijo al centro
- soporte geográfico por municipalidad activa en el selector superior
- fotos opcionales
- consolidación de incidentes por cercanía
- confirmación social: un usuario puede confirmar un incidente una vez
- panel municipal con vista general unificada para analítica, cola operativa, mapa y detalle del incidente
- cola operativa ordenada de más grave a menos grave: abiertos antes que reparados, con orden dinámico por prioridad, impacto o riesgo
- historial consolidado por incidente con creación de reportes, cambios de estado y confirmaciones

## Stack

- React 18 + Vite
- Node.js + Express
- PostgreSQL + pgvector para RAG híbrido
- Framer Motion para animaciones puntuales del frontend
- Leaflet + Google Maps Tiles API, con OpenStreetMap como fallback
- OpenAI opcional
- Vercel Blob para imágenes de baches
- Vercel para frontend + API
- Neon Postgres recomendado para base externa

## Estructura

```text
api/                 Entrada serverless para Vercel
server/              Backend, DB, seeds, RAG, recolección y baches
src/                 Frontend React
public/              Assets estáticos
scripts/             Scripts locales de arranque y parada
vercel.json          Configuración de despliegue
docker-compose.yml   Entorno alternativo con Docker
PLAN_RAG_SPIDER.md   Arquitectura RAG académica con spider manual
```

## Scripts

```powershell
npm install
npm run dev:front
npm run dev:back
npm run build
npm run rag:evaluate
```

URLs locales esperadas:

- frontend: `http://127.0.0.1:4173`
- backend: `http://127.0.0.1:8787`
- health: `http://127.0.0.1:8787/api/health`

## Variables de entorno

Copiar primero:

```powershell
Copy-Item .env.local.example .env.local
```

Variables importantes:

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

Nota sobre mapas:

- Si `VITE_GOOGLE_MAPS_API_KEY` está configurada, el frontend usa Google Maps Tiles API.
- Si la variable no existe, está vacía o Google responde con error, el mapa cae automáticamente a OpenStreetMap.
- En local, después de cambiar una variable `VITE_...`, hay que reiniciar `npm run dev:front` porque Vite las inyecta al arrancar.
- En Vercel, mantener `VITE_GOOGLE_MAPS_API_KEY` configurada para que producción siga mostrando Google Maps.

Nota sobre Google Sign-In:

- Google Sign-In usa OAuth Web Client IDs, no la API key de Maps.
- Local usa `45586226543-1ajql78s9m47un5svfk1ltlmbp02sh6m.apps.googleusercontent.com`.
- Vercel usa `45586226543-p1oeh805ik5ej7upcgdulleqvq0idele.apps.googleusercontent.com`.
- En Google Cloud, agregar estos origins autorizados según corresponda: `http://127.0.0.1:4173`, `http://localhost:4173`, `https://proyecto-municipalidad.vercel.app`.
- Si abrís el front local en `http://localhost:4173`, la app lo normaliza a `http://127.0.0.1:4173` para evitar `origin_mismatch` en Google Sign-In.
- En local, configurar `VITE_GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_ID`; después reiniciar frontend y backend.
- En Vercel, configurar `VITE_GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_ID` con el client ID de Vercel; redeployar porque `VITE_...` se inyecta durante build.
- Si el backend debe aceptar más de un OAuth client, usar `GOOGLE_CLIENT_IDS` con IDs separados por coma.
- El botón de iniciar sesión con Google rechaza cuentas no registradas; el registro con Google crea una cuenta `difusor`.

Nota sobre auth y origins en producción:

- `JWT_SECRET` es obligatorio en producción y debe tener al menos 32 caracteres.
- `APP_ORIGIN` y/o `CORS_ORIGINS` deben incluir `https://proyecto-municipalidad.vercel.app` para permitir login y otros writes desde el frontend desplegado.
- si usas `VITE_API_BASE_URL` hacia otro host, ese origin también debe estar contemplado por la allowlist del backend.

Defaults seguros para desarrollo:

```env
OPENAI_ENABLED=false
RAG_SYNC_ON_BOOT=false
RAG_SPIDER_ENABLED=false
RAG_SPIDER_INTERNAL_URL=
RAG_ARTIFACT_DIR=server/data/rag-artifacts
RAG_PUBLIC_INDEX_ENABLED=false
GTFS_FORCE_RESEED=false
```

### Trayectos simulados y cartografía vial

- los recorridos simulados salen de `server/data/collection-service-plan.json` y de la red vial `server/data/calles-asu.graph.json`
- la fuente vial principal es `CALLES_VERS_30_01_2026`
- `server/scripts/buildCollectionAssets.py` debe respetar los `parts` del shapefile; si une partes distintas como una sola polilínea, aparecen trayectos que cruzan por el medio de las cuadras
- después de regenerar assets, hay que volver a sembrar `collection_route_shapes`, `collection_runs` y `gtfs_shapes`; cambiar solo los JSON no alcanza para la simulación en runtime
- para regenerar localmente:

```powershell
python server/scripts/buildCollectionAssets.py

## Ciudades y barrios

El alta de ciudades y barrios ya no depende de ChatGPT ni de OpenAI.

El flujo operativo vive en `/desarrollador` y hoy soporta:

- una vista separada de `Ciudades para Baches`, accesible desde la tarjeta homónima del panel
- registrar una municipalidad manual si no existe todavía en el catálogo
- cargar barrios oficiales desde INE para la municipalidad seleccionada
- importar barrios desde archivo `GeoJSON`, `JSON` o `CSV`
- dejar lista la geografía para `/baches`, `/admin-muni` y el centrado/selección por ciudad en `/recoleccion`

Regla práctica:

- `GeoJSON` es el formato recomendado si querés experiencia “tipo Asunción”, con click directo sobre cada barrio en el mapa
- `CSV` sirve para centros, bbox y metadatos; también puede traer una columna `geometry_geojson` si querés conservar polígonos sin usar un `.geojson` separado
- que una ciudad quede “geo-ready” no significa que ya tenga simulación completa de Recolección; para eso siguen haciendo falta assets viales y plan de rutas propios

La guía paso a paso quedó en [`HOW_ADD_CITIES.md`](./HOW_ADD_CITIES.md).
```

- para forzar el reseed de rutas y GTFS:

```powershell
$env:GTFS_FORCE_RESEED='true'
npm run dev:back
```

### Docker Compose y RAG Spider

El Compose levanta `backend`, `rag-spider`, `postgres` y `frontend`. `postgres` usa `pgvector/pgvector:pg16`; `backend` y `rag-spider` usan una imagen común basada en Playwright (`Dockerfile.playwright`) para compartir dependencias, pero son contenedores separados.

`rag-spider` queda disponible como servicio interno y ocioso. No inicia crawls por polling, cron o intervalo; cada crawl empieza solo por una acción explícita del rol `desarrollador` desde `/desarrollador`. Si el servicio está apagado, el backend informa `spider-offline` y no intenta prender Docker desde la aplicación.

### Arranque local

Abrí la carpeta [`scripts`](C:/Users/enzoe/Documents/Universidad/9no%20Semestre/Ingeniería%20del%20Software/Proyecto%20Municipalidad/proyecto-municipalidad/scripts) y ejecutá `start-docker.ps1`.

Ese archivo es la entrada principal del proyecto y detecta `DATABASE_URL` en `.env.local`:

- si `DATABASE_URL` esta vacio, arranca el stack completo con `postgres` local
- si `DATABASE_URL` tiene valor (por ejemplo Neon con `?sslmode=require`), arranca `backend`, `worker` y `frontend` en modo BD externa y evita levantar el `postgres` local innecesariamente

## Login demo

### Login público

El login general del sitio sigue siendo demo/local y se guarda en el navegador. Se usa para:

- habilitar acciones bloqueadas
- abrir el módulo público de baches
- identificar quién confirma un incidente

### Desarrollador

`/desarrollador` es el panel del rol `desarrollador`. Sirve para controlar la simulación de recolección, prender/apagar la operación manual del spider, configurar municipalidades y dominios desde la base INE/Datos.gov.py, gestionar una o más seeds por municipalidad, revisar salud de fuentes, enviar seeds a cola de ejecución, cancelar jobs, conectar o desconectar fuentes spider al índice consultable de Munita, hacer rebuild/reload del índice, reindexar embeddings, importar barrios oficiales para nuevas ciudades desde INE y abrir una pantalla separada para auditar o borrar embeddings conectados. Es el centro operativo del RAG de Munita y de la preparación geográfica de Baches.

### Admin muni

`/admin-muni` es para el rol `admin`. Gestiona baches con una vista general unificada: dashboard superior, cola operativa priorizada, mapa, detalle e historial del incidente. No ejecuta spider, scripts, Docker ni toggles técnicos de Munita.

## Endpoints útiles

### Salud

- `GET /api/health`

### RAG

- `GET /api/rag/catalog`
- `GET /api/rag/procedure/:id`
- `GET /api/rag/procedure/:id/section/:section`
- `GET /api/rag/search?q=...`
- `POST /api/rag/ask`

### RAG admin

- `GET /api/admin/rag/runtime`
- `PATCH /api/admin/rag/runtime`
- `GET /api/admin/rag/municipalities`
- `POST /api/admin/rag/municipalities`
- `PATCH /api/admin/rag/municipalities/:id`
- `GET /api/admin/rag/seed-urls`
- `POST /api/admin/rag/seed-urls`
- `POST /api/admin/rag/seed-urls/:id/check`
- `GET /api/admin/rag/source-health`
- `POST /api/admin/rag/crawl-jobs`
- `POST /api/admin/rag/crawl-jobs/:id/cancel`
- `POST /api/admin/rag/index/rebuild`
- `POST /api/admin/rag/embeddings/rebuild`
- `GET /api/admin/rag/embeddings`
- `DELETE /api/admin/rag/embeddings`
- `POST /api/admin/rag/reload`
- `GET /api/admin/rag/catalog`
- `GET /api/admin/rag/catalog/:id`
- `PATCH /api/admin/rag/info-publication/:id`
- `POST /api/admin/rag/info-publication/bulk`

### Recolección

- `GET /api/collection/zones`
- `GET /api/collection/map`
- `GET /api/collection/overview?zone_id=...`
- `GET /api/gtfs-rt/vehicle-positions`
- `GET /api/gtfs-rt/trip-updates`

### Baches

- `GET /api/potholes/map`
- `GET /api/potholes/reports`
- `GET /api/potholes/reports/:id`
- `POST /api/potholes/reports`
- `POST /api/potholes/reports/:id/confirmations`
- `GET /api/admin/potholes/dashboard`
- `GET /api/admin/potholes/reports`
- `PATCH /api/admin/potholes/reports/:id`

## Deploy

El proyecto está preparado para deployar en Vercel desde `main`.

Flujo recomendado:

1. probar localmente
2. correr `npm run build`
3. hacer commit
4. push a `main`
5. verificar el deployment en Vercel

Si hace falta forzar producción manualmente:

```powershell
npx vercel --prod --yes
```

## Notas de arquitectura

- `/baches` es solo experiencia ciudadana
- `/desarrollador` es control del desarrollador: simulación, runtime RAG, crawls manuales y scripts
- `/admin-muni` es gestión municipal: baches
- no deben mezclarse roles ni poner botones desde admins hacia la URL pública
- el spider RAG nunca debe correr automáticamente por intervalo; solo por acción explícita del desarrollador
- la simulación de recolección puede apagarse para ahorrar consumo en Vercel y Neon
- las fotos de baches son opcionales

## Créditos

Proyecto desarrollado para la cátedra Ingeniería del Software, Universidad Católica de Asunción.

Equipo:

- Enzo Erico
- Horacio Aranda
- Federico Alonso

Mentoría:

- Ing. Raúl Gutiérrez
- Ing. Erik Wasmosy

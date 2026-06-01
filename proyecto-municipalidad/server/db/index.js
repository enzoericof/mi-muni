import pg from 'pg'
import paraguayMunicipalities, { PARAGUAY_MUNICIPALITIES_SOURCE } from '../data/municipalities/paraguayMunicipalities.js'

const { Pool } = pg

let pool = null

function isTransientConnectionError(error) {
  const message = String(error?.message || '').toLowerCase()
  return (
    error?.code === 'ECONNRESET' ||
    error?.code === 'EPIPE' ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === '57P01' ||
    error?.code === '57P02' ||
    error?.code === '57P03' ||
    message.includes('connection terminated unexpectedly') ||
    message.includes('terminating connection') ||
    message.includes('socket hang up')
  )
}

function buildDatabaseConfig() {
  if (process.env.DATABASE_URL) {
    const connectionString = process.env.DATABASE_URL
    const sslMode = String(process.env.PGSSLMODE || '').toLowerCase()
    const shouldUseSsl =
      sslMode === 'require' ||
      /sslmode=require/i.test(connectionString) ||
      /neon\.tech|supabase\.co|render\.com|railway/i.test(connectionString)

    return {
      connectionString,
      ssl: shouldUseSsl ? { rejectUnauthorized: false } : undefined,
      keepAlive: true,
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
    }
  }

  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'municipal',
    password: process.env.PGPASSWORD || 'municipal',
    database: process.env.PGDATABASE || 'municipal_db',
    keepAlive: true,
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
  }
}

export function getPool() {
  if (!pool) {
    pool = new Pool(buildDatabaseConfig())
    pool.on('error', (error) => {
      console.error('[db] Idle client error:', error.code || error.name, error.message)
    })
  }
  return pool
}

export async function connectWithRetry(maxAttempts = 15, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await getPool().connect()
      client.release()
      console.log('[db] Connected to PostgreSQL')
      return
    } catch (error) {
      console.log(`[db] Attempt ${attempt}/${maxAttempts} failed: ${error.message}`)
      if (attempt === maxAttempts) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

export async function query(sql, params = []) {
  try {
    return await getPool().query(sql, params)
  } catch (error) {
    if (!isTransientConnectionError(error)) throw error

    console.warn(`[db] Query failed due to transient connection issue (${error.code || error.name}). Retrying once...`)
    return getPool().query(sql, params)
  }
}

export async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS gtfs_agency (
      agency_id       VARCHAR(50)  PRIMARY KEY,
      agency_name     VARCHAR(200) NOT NULL,
      agency_url      VARCHAR(300),
      agency_timezone VARCHAR(100) DEFAULT 'America/Asuncion',
      agency_lang     VARCHAR(10)  DEFAULT 'es'
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS gtfs_calendar (
      service_id  VARCHAR(50) PRIMARY KEY,
      monday      BOOLEAN NOT NULL DEFAULT TRUE,
      tuesday     BOOLEAN NOT NULL DEFAULT TRUE,
      wednesday   BOOLEAN NOT NULL DEFAULT TRUE,
      thursday    BOOLEAN NOT NULL DEFAULT TRUE,
      friday      BOOLEAN NOT NULL DEFAULT TRUE,
      saturday    BOOLEAN NOT NULL DEFAULT FALSE,
      sunday      BOOLEAN NOT NULL DEFAULT FALSE,
      start_date  DATE NOT NULL,
      end_date    DATE NOT NULL
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS gtfs_routes (
      route_id         VARCHAR(50)  PRIMARY KEY,
      agency_id        VARCHAR(50)  NOT NULL REFERENCES gtfs_agency(agency_id),
      route_short_name VARCHAR(20),
      route_long_name  VARCHAR(200),
      route_type       SMALLINT     NOT NULL DEFAULT 3,
      route_color      VARCHAR(6),
      route_text_color VARCHAR(6)   DEFAULT 'FFFFFF',
      route_desc       TEXT,
      report_count     INTEGER      NOT NULL DEFAULT 0
    )
  `)
  await query(`ALTER TABLE gtfs_routes ADD COLUMN IF NOT EXISTS report_count INTEGER NOT NULL DEFAULT 0`)
  await query(`ALTER TABLE gtfs_routes ADD COLUMN IF NOT EXISTS route_desc TEXT`)
  await query(`ALTER TABLE gtfs_routes ADD COLUMN IF NOT EXISTS route_text_color VARCHAR(6) DEFAULT 'FFFFFF'`)

  await query(`
    CREATE TABLE IF NOT EXISTS gtfs_shapes (
      shape_id          VARCHAR(50)      NOT NULL,
      shape_pt_lat      DOUBLE PRECISION NOT NULL,
      shape_pt_lon      DOUBLE PRECISION NOT NULL,
      shape_pt_sequence INTEGER          NOT NULL,
      PRIMARY KEY (shape_id, shape_pt_sequence)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS gtfs_stops (
      stop_id   VARCHAR(50)      PRIMARY KEY,
      stop_name VARCHAR(200)     NOT NULL,
      stop_lat  DOUBLE PRECISION NOT NULL,
      stop_lon  DOUBLE PRECISION NOT NULL,
      stop_desc TEXT,
      zone_id   VARCHAR(50)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS gtfs_trips (
      trip_id       VARCHAR(50)  PRIMARY KEY,
      route_id      VARCHAR(50)  NOT NULL REFERENCES gtfs_routes(route_id),
      service_id    VARCHAR(50)  NOT NULL REFERENCES gtfs_calendar(service_id),
      trip_headsign VARCHAR(200),
      shape_id      VARCHAR(50),
      direction_id  SMALLINT     DEFAULT 0
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS gtfs_stop_times (
      trip_id        VARCHAR(50) NOT NULL REFERENCES gtfs_trips(trip_id),
      stop_id        VARCHAR(50) NOT NULL REFERENCES gtfs_stops(stop_id),
      arrival_time   VARCHAR(8)  NOT NULL,
      departure_time VARCHAR(8)  NOT NULL,
      stop_sequence  INTEGER     NOT NULL,
      PRIMARY KEY (trip_id, stop_sequence)
    )
  `)

  console.log('[db] GTFS schema ready')

  let pgVectorAvailable = false
  try {
    await query(`CREATE EXTENSION IF NOT EXISTS vector`)
    pgVectorAvailable = true
  } catch (error) {
    console.warn(`[db] pgvector no disponible; RAG queda con busqueda textual + embeddings JSON. ${error.message}`)
  }

  await query(`
    CREATE TABLE IF NOT EXISTS rag_procedures (
      id            TEXT PRIMARY KEY,
      titulo        TEXT NOT NULL,
      descripcion   TEXT,
      resumen       TEXT,
      categoria     TEXT,
      tipo          TEXT,
      fuente_titulo TEXT,
      fuente_url    TEXT,
      fecha         TEXT,
      secciones     JSONB        DEFAULT '{}',
      section_order JSONB        DEFAULT '[]',
      created_at    TIMESTAMPTZ  DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS rag_chunks (
      id            TEXT PRIMARY KEY,
      procedure_id  TEXT REFERENCES rag_procedures(id) ON DELETE CASCADE,
      titulo        TEXT,
      text          TEXT NOT NULL,
      seccion       TEXT,
      categoria     TEXT,
      tipo          TEXT,
      fuente_titulo TEXT,
      fuente_url    TEXT,
      fecha         TEXT,
      embedding     TEXT
    )
  `)

  await query(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS municipality_id BIGINT`)
  await query(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS source_type TEXT`)
  await query(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS source_item_id BIGINT`)
  await query(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT`)
  await query(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT`)
  await query(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await query(`
    ALTER TABLE rag_chunks
    ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      to_tsvector('spanish', coalesce(titulo, '') || ' ' || coalesce(text, '') || ' ' || coalesce(fuente_titulo, ''))
    ) STORED
  `)
  if (pgVectorAvailable) {
    await query(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding_vector vector(1536)`)
  }

  await query(`
    CREATE TABLE IF NOT EXISTS rag_runtime_settings (
      settings_id          SMALLINT PRIMARY KEY DEFAULT 1,
      public_index_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      spider_operations_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      assistant_use_embeddings BOOLEAN NOT NULL DEFAULT TRUE,
      assistant_chunk_limit INTEGER NOT NULL DEFAULT 10,
      assistant_min_relevance_score DOUBLE PRECISION NOT NULL DEFAULT 5,
      assistant_strict_municipality_scope BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by           TEXT,
      CHECK (settings_id = 1)
    )
  `)
  await query(`ALTER TABLE rag_runtime_settings ADD COLUMN IF NOT EXISTS spider_operations_enabled BOOLEAN NOT NULL DEFAULT FALSE`)
  await query(`ALTER TABLE rag_runtime_settings ADD COLUMN IF NOT EXISTS assistant_use_embeddings BOOLEAN NOT NULL DEFAULT TRUE`)
  await query(`ALTER TABLE rag_runtime_settings ADD COLUMN IF NOT EXISTS assistant_chunk_limit INTEGER NOT NULL DEFAULT 10`)
  await query(`ALTER TABLE rag_runtime_settings ADD COLUMN IF NOT EXISTS assistant_min_relevance_score DOUBLE PRECISION NOT NULL DEFAULT 5`)
  await query(`ALTER TABLE rag_runtime_settings ADD COLUMN IF NOT EXISTS assistant_strict_municipality_scope BOOLEAN NOT NULL DEFAULT TRUE`)

  await query(`
    INSERT INTO rag_runtime_settings (
      settings_id,
      public_index_enabled,
      spider_operations_enabled,
      assistant_use_embeddings,
      assistant_chunk_limit,
      assistant_min_relevance_score,
      assistant_strict_municipality_scope,
      updated_by
    )
    VALUES (1, COALESCE(NULLIF($1, '')::boolean, FALSE), FALSE, TRUE, 10, 5, TRUE, 'system-init')
    ON CONFLICT (settings_id) DO NOTHING
  `, [process.env.RAG_PUBLIC_INDEX_ENABLED || 'false'])

  await query(`
    CREATE TABLE IF NOT EXISTS rag_municipalities (
      id             BIGSERIAL PRIMARY KEY,
      slug           TEXT NOT NULL UNIQUE,
      name           TEXT NOT NULL,
      primary_domain TEXT,
      department     TEXT,
      ine_code       TEXT,
      center_lat     DOUBLE PRECISION,
      center_lon     DOUBLE PRECISION,
      bbox           JSONB NOT NULL DEFAULT '{}'::jsonb,
      geometry       JSONB NOT NULL DEFAULT '{}'::jsonb,
      geo_source_name TEXT,
      geo_source_url  TEXT,
      geo_imported_at TIMESTAMPTZ,
      source_name    TEXT,
      source_url     TEXT,
      active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`ALTER TABLE rag_municipalities ADD COLUMN IF NOT EXISTS department TEXT`)
  await query(`ALTER TABLE rag_municipalities ADD COLUMN IF NOT EXISTS ine_code TEXT`)
  await query(`ALTER TABLE rag_municipalities ADD COLUMN IF NOT EXISTS center_lat DOUBLE PRECISION`)
  await query(`ALTER TABLE rag_municipalities ADD COLUMN IF NOT EXISTS center_lon DOUBLE PRECISION`)
  await query(`ALTER TABLE rag_municipalities ADD COLUMN IF NOT EXISTS bbox JSONB NOT NULL DEFAULT '{}'::jsonb`)
  await query(`ALTER TABLE rag_municipalities ADD COLUMN IF NOT EXISTS geometry JSONB NOT NULL DEFAULT '{}'::jsonb`)
  await query(`ALTER TABLE rag_municipalities ADD COLUMN IF NOT EXISTS geo_source_name TEXT`)
  await query(`ALTER TABLE rag_municipalities ADD COLUMN IF NOT EXISTS geo_source_url TEXT`)
  await query(`ALTER TABLE rag_municipalities ADD COLUMN IF NOT EXISTS geo_imported_at TIMESTAMPTZ`)
  await query(`ALTER TABLE rag_municipalities ADD COLUMN IF NOT EXISTS source_name TEXT`)
  await query(`ALTER TABLE rag_municipalities ADD COLUMN IF NOT EXISTS source_url TEXT`)

  await query(`
    CREATE TABLE IF NOT EXISTS rag_seed_urls (
      id                 BIGSERIAL PRIMARY KEY,
      municipality_id    BIGINT NOT NULL REFERENCES rag_municipalities(id) ON DELETE CASCADE,
      url                TEXT NOT NULL,
      allowed_hostname   TEXT NOT NULL,
      max_depth          INTEGER NOT NULL DEFAULT 3,
      max_pages          INTEGER NOT NULL DEFAULT 500,
      max_pdfs           INTEGER NOT NULL DEFAULT 200,
      max_images         INTEGER NOT NULL DEFAULT 500,
      max_file_bytes     INTEGER NOT NULL DEFAULT 26214400,
      concurrency        INTEGER NOT NULL DEFAULT 2,
      page_timeout_ms    INTEGER NOT NULL DEFAULT 30000,
      status             TEXT NOT NULL DEFAULT 'active',
      created_by         TEXT,
      last_checked_at    TIMESTAMPTZ,
      last_changed_at    TIMESTAMPTZ,
      stale_after_days   INTEGER NOT NULL DEFAULT 30,
      change_status      TEXT NOT NULL DEFAULT 'unknown',
      last_content_hash  TEXT,
      check_error        TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (municipality_id, url)
    )
  `)
  await query(`ALTER TABLE rag_seed_urls ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ`)
  await query(`ALTER TABLE rag_seed_urls ADD COLUMN IF NOT EXISTS last_changed_at TIMESTAMPTZ`)
  await query(`ALTER TABLE rag_seed_urls ADD COLUMN IF NOT EXISTS stale_after_days INTEGER NOT NULL DEFAULT 30`)
  await query(`ALTER TABLE rag_seed_urls ADD COLUMN IF NOT EXISTS change_status TEXT NOT NULL DEFAULT 'unknown'`)
  await query(`ALTER TABLE rag_seed_urls ADD COLUMN IF NOT EXISTS last_content_hash TEXT`)
  await query(`ALTER TABLE rag_seed_urls ADD COLUMN IF NOT EXISTS check_error TEXT`)

  await query(`
    CREATE TABLE IF NOT EXISTS rag_crawl_jobs (
      id              BIGSERIAL PRIMARY KEY,
      municipality_id BIGINT NOT NULL REFERENCES rag_municipalities(id) ON DELETE CASCADE,
      seed_url_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
      status          TEXT NOT NULL DEFAULT 'queued',
      requested_by    TEXT,
      started_at      TIMESTAMPTZ,
      finished_at     TIMESTAMPTZ,
      stats           JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_code      TEXT,
      error_message   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS rag_crawled_pages (
      id              BIGSERIAL PRIMARY KEY,
      job_id          BIGINT NOT NULL REFERENCES rag_crawl_jobs(id) ON DELETE CASCADE,
      municipality_id BIGINT NOT NULL REFERENCES rag_municipalities(id) ON DELETE CASCADE,
      seed_url_id     BIGINT NOT NULL REFERENCES rag_seed_urls(id) ON DELETE CASCADE,
      url             TEXT NOT NULL,
      canonical_url   TEXT,
      title           TEXT,
      status_code     INTEGER,
      depth           INTEGER NOT NULL DEFAULT 0,
      content_hash    TEXT,
      raw_path        TEXT,
      text_path       TEXT,
      metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
      fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`ALTER TABLE rag_crawled_pages ADD COLUMN IF NOT EXISTS raw_path TEXT`)

  await query(`
    CREATE TABLE IF NOT EXISTS rag_assets (
      id              BIGSERIAL PRIMARY KEY,
      job_id          BIGINT NOT NULL REFERENCES rag_crawl_jobs(id) ON DELETE CASCADE,
      municipality_id BIGINT NOT NULL REFERENCES rag_municipalities(id) ON DELETE CASCADE,
      page_id         BIGINT REFERENCES rag_crawled_pages(id) ON DELETE SET NULL,
      url             TEXT NOT NULL,
      asset_type      TEXT NOT NULL,
      content_type    TEXT,
      file_path       TEXT,
      sha256          TEXT,
      size_bytes      INTEGER NOT NULL DEFAULT 0,
      text_status     TEXT,
      extracted_text  TEXT,
      text_extracted_at TIMESTAMPTZ,
      metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`ALTER TABLE rag_assets ADD COLUMN IF NOT EXISTS extracted_text TEXT`)
  await query(`ALTER TABLE rag_assets ADD COLUMN IF NOT EXISTS text_extracted_at TIMESTAMPTZ`)

  await query(`
    CREATE TABLE IF NOT EXISTS rag_index_items (
      id              BIGSERIAL PRIMARY KEY,
      municipality_id BIGINT NOT NULL REFERENCES rag_municipalities(id) ON DELETE CASCADE,
      source_type     TEXT NOT NULL,
      source_id       BIGINT,
      title           TEXT,
      source_url      TEXT,
      text            TEXT,
      summary         TEXT,
      content_hash    TEXT,
      version         INTEGER NOT NULL DEFAULT 1,
      previous_content_hash TEXT,
      previous_text   TEXT,
      changed_at      TIMESTAMPTZ,
      metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
      indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`ALTER TABLE rag_index_items ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`)
  await query(`ALTER TABLE rag_index_items ADD COLUMN IF NOT EXISTS previous_content_hash TEXT`)
  await query(`ALTER TABLE rag_index_items ADD COLUMN IF NOT EXISTS previous_text TEXT`)
  await query(`ALTER TABLE rag_index_items ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ`)

  await query(`
    CREATE TABLE IF NOT EXISTS rag_info_publication (
      id              BIGSERIAL PRIMARY KEY,
      municipality_id BIGINT NOT NULL REFERENCES rag_municipalities(id) ON DELETE CASCADE,
      index_item_id   BIGINT NOT NULL UNIQUE REFERENCES rag_index_items(id) ON DELETE CASCADE,
      visible         BOOLEAN NOT NULL DEFAULT FALSE,
      selected_by     TEXT,
      selected_at     TIMESTAMPTZ,
      notes           TEXT
    )
  `)

  for (const municipality of paraguayMunicipalities) {
    await query(
      `
        INSERT INTO rag_municipalities
          (slug, name, primary_domain, department, ine_code, source_name, source_url, active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
        ON CONFLICT (slug) DO UPDATE
          SET name = EXCLUDED.name,
              primary_domain = COALESCE(NULLIF(rag_municipalities.primary_domain, ''), EXCLUDED.primary_domain),
              department = EXCLUDED.department,
              ine_code = EXCLUDED.ine_code,
              source_name = EXCLUDED.source_name,
              source_url = EXCLUDED.source_url,
              active = TRUE,
              updated_at = NOW()
      `,
      [
        municipality.slug,
        municipality.name,
        municipality.primaryDomain || null,
        municipality.department,
        municipality.ineCode,
        PARAGUAY_MUNICIPALITIES_SOURCE.name,
        PARAGUAY_MUNICIPALITIES_SOURCE.datasetUrl,
      ],
    )
  }

  await query(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_procedure ON rag_chunks(procedure_id)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_categoria ON rag_chunks(categoria)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_source_item ON rag_chunks(source_item_id, source_type)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_search_vector ON rag_chunks USING GIN (search_vector)`)
  if (pgVectorAvailable) {
    try {
      await query(`CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding_hnsw ON rag_chunks USING hnsw (embedding_vector vector_cosine_ops)`)
    } catch (error) {
      console.warn(`[db] No se pudo crear indice HNSW de pgvector; se usara scan vectorial cuando aplique. ${error.message}`)
    }
  }
  await query(`CREATE INDEX IF NOT EXISTS idx_rag_seed_urls_municipality ON rag_seed_urls(municipality_id, status)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rag_seed_urls_health ON rag_seed_urls(change_status, last_checked_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rag_crawl_jobs_municipality ON rag_crawl_jobs(municipality_id, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rag_crawl_jobs_status ON rag_crawl_jobs(status, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rag_pages_job ON rag_crawled_pages(job_id, fetched_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rag_assets_job ON rag_assets(job_id, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rag_index_items_municipality ON rag_index_items(municipality_id, indexed_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_rag_publication_visible ON rag_info_publication(visible, selected_at DESC)`)

  console.log('[db] RAG schema ready')

  await query(`
    CREATE TABLE IF NOT EXISTS collection_barrios (
      barrio_id    VARCHAR(80) PRIMARY KEY,
      barrio_label VARCHAR(160) NOT NULL,
      zone_number  INTEGER,
      center_lat   DOUBLE PRECISION NOT NULL,
      center_lon   DOUBLE PRECISION NOT NULL,
      bbox         JSONB NOT NULL DEFAULT '{}'::jsonb,
      geometry     JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_depots (
      depot_id     VARCHAR(40) PRIMARY KEY,
      depot_label  VARCHAR(120) NOT NULL,
      center_lat   DOUBLE PRECISION NOT NULL,
      center_lon   DOUBLE PRECISION NOT NULL
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_routes (
      route_id           VARCHAR(40) PRIMARY KEY,
      route_short_name   VARCHAR(40) NOT NULL,
      route_long_name    VARCHAR(200) NOT NULL,
      route_color        VARCHAR(6) NOT NULL,
      depot_id           VARCHAR(40) NOT NULL REFERENCES collection_depots(depot_id),
      shape_id           VARCHAR(80) NOT NULL UNIQUE,
      total_distance_m   DOUBLE PRECISION NOT NULL DEFAULT 0,
      travel_minutes     INTEGER NOT NULL DEFAULT 0,
      duration_minutes   INTEGER NOT NULL DEFAULT 0
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_route_shapes (
      route_id               VARCHAR(40) NOT NULL REFERENCES collection_routes(route_id) ON DELETE CASCADE,
      shape_id               VARCHAR(80) NOT NULL,
      point_sequence         INTEGER NOT NULL,
      point_lat              DOUBLE PRECISION NOT NULL,
      point_lon              DOUBLE PRECISION NOT NULL,
      cumulative_distance_m  DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (route_id, point_sequence)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_trucks (
      truck_id      VARCHAR(40) PRIMARY KEY,
      truck_label   VARCHAR(120) NOT NULL,
      depot_id      VARCHAR(40) NOT NULL REFERENCES collection_depots(depot_id),
      active        BOOLEAN NOT NULL DEFAULT TRUE
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_service_patterns (
      service_pattern_id VARCHAR(80) PRIMARY KEY,
      route_id           VARCHAR(40) NOT NULL REFERENCES collection_routes(route_id) ON DELETE CASCADE,
      truck_id           VARCHAR(40) NOT NULL REFERENCES collection_trucks(truck_id),
      pattern_label      VARCHAR(120) NOT NULL,
      service_days       JSONB NOT NULL DEFAULT '[]'::jsonb,
      start_time         VARCHAR(8) NOT NULL
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_route_barrio_coverage (
      route_id                 VARCHAR(40) NOT NULL REFERENCES collection_routes(route_id) ON DELETE CASCADE,
      barrio_id                VARCHAR(80) NOT NULL REFERENCES collection_barrios(barrio_id) ON DELETE CASCADE,
      stop_sequence            INTEGER NOT NULL,
      stop_lat                 DOUBLE PRECISION NOT NULL,
      stop_lon                 DOUBLE PRECISION NOT NULL,
      anchor_point_index       INTEGER NOT NULL,
      arrival_offset_minutes   INTEGER NOT NULL,
      exit_offset_minutes      INTEGER NOT NULL,
      is_primary               BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (route_id, barrio_id, stop_sequence)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_runs (
      run_id               BIGSERIAL PRIMARY KEY,
      run_key              TEXT NOT NULL UNIQUE,
      route_id             VARCHAR(40) NOT NULL REFERENCES collection_routes(route_id) ON DELETE CASCADE,
      service_pattern_id   VARCHAR(80) NOT NULL REFERENCES collection_service_patterns(service_pattern_id) ON DELETE CASCADE,
      truck_id             VARCHAR(40) NOT NULL REFERENCES collection_trucks(truck_id),
      service_date         DATE NOT NULL,
      starts_at            TIMESTAMPTZ NOT NULL,
      ends_at              TIMESTAMPTZ NOT NULL
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_run_barrio_events (
      run_id           BIGINT NOT NULL REFERENCES collection_runs(run_id) ON DELETE CASCADE,
      route_id         VARCHAR(40) NOT NULL REFERENCES collection_routes(route_id) ON DELETE CASCADE,
      truck_id         VARCHAR(40) NOT NULL REFERENCES collection_trucks(truck_id),
      barrio_id        VARCHAR(80) NOT NULL REFERENCES collection_barrios(barrio_id) ON DELETE CASCADE,
      barrio_label     VARCHAR(160) NOT NULL,
      stop_sequence    INTEGER NOT NULL,
      enters_at        TIMESTAMPTZ NOT NULL,
      exits_at         TIMESTAMPTZ NOT NULL,
      stop_lat         DOUBLE PRECISION NOT NULL,
      stop_lon         DOUBLE PRECISION NOT NULL,
      is_primary       BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (run_id, barrio_id, stop_sequence)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_manual_reports (
      id              BIGSERIAL PRIMARY KEY,
      zone_id         VARCHAR(80) NOT NULL,
      route_id        VARCHAR(50) REFERENCES gtfs_routes(route_id),
      address_label   TEXT,
      notes           TEXT,
      reported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_route_validations (
      id                BIGSERIAL PRIMARY KEY,
      zone_id           VARCHAR(80) NOT NULL,
      route_id          VARCHAR(50) REFERENCES gtfs_routes(route_id),
      validation_status VARCHAR(40) NOT NULL,
      notes             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_notifications (
      id                BIGSERIAL PRIMARY KEY,
      zone_id           VARCHAR(80) NOT NULL,
      event_type        VARCHAR(40) NOT NULL,
      channel           VARCHAR(40) NOT NULL,
      lead_minutes      INTEGER NOT NULL DEFAULT 15,
      preferred_days    JSONB NOT NULL DEFAULT '[]',
      time_window_start VARCHAR(5),
      time_window_end   VARCHAR(5),
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_runtime_settings (
      settings_id         SMALLINT PRIMARY KEY DEFAULT 1,
      simulation_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by          TEXT,
      CHECK (settings_id = 1)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_admin_sessions (
      session_id    VARCHAR(96) PRIMARY KEY,
      expires_at    TIMESTAMPTZ NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by    TEXT
    )
  `)

  await query(`ALTER TABLE collection_notifications ADD COLUMN IF NOT EXISTS preferred_days JSONB NOT NULL DEFAULT '[]'`)
  await query(`ALTER TABLE collection_notifications ADD COLUMN IF NOT EXISTS time_window_start VARCHAR(5)`)
  await query(`ALTER TABLE collection_notifications ADD COLUMN IF NOT EXISTS time_window_end VARCHAR(5)`)
  await query(`ALTER TABLE collection_notifications ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`)
  await query(`ALTER TABLE collection_runtime_settings ADD COLUMN IF NOT EXISTS simulation_enabled BOOLEAN NOT NULL DEFAULT TRUE`)
  await query(`ALTER TABLE collection_runtime_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await query(`ALTER TABLE collection_runtime_settings ADD COLUMN IF NOT EXISTS updated_by TEXT`)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_runtime_environments (
      environment_key     TEXT PRIMARY KEY,
      simulation_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by          TEXT
    )
  `)

  await query(`
    INSERT INTO collection_runtime_settings (settings_id, simulation_enabled, updated_by)
    VALUES (1, TRUE, 'system-init')
    ON CONFLICT (settings_id) DO NOTHING
  `)

  await query(`
    INSERT INTO collection_runtime_environments (environment_key, simulation_enabled, updated_by)
    SELECT 'production', simulation_enabled, COALESCE(updated_by, 'legacy-migration')
    FROM collection_runtime_settings
    WHERE settings_id = 1
    ON CONFLICT (environment_key) DO NOTHING
  `)

  await query(`
    INSERT INTO collection_runtime_environments (environment_key, simulation_enabled, updated_by)
    VALUES ('development', TRUE, 'system-init')
    ON CONFLICT (environment_key) DO NOTHING
  `)

  await query(`CREATE INDEX IF NOT EXISTS idx_collection_reports_zone ON collection_manual_reports(zone_id, reported_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_validations_zone ON collection_route_validations(zone_id, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_notifications_zone ON collection_notifications(zone_id, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_barrios_zone ON collection_barrios(zone_number, barrio_label)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_shapes_route ON collection_route_shapes(route_id, point_sequence)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_patterns_route ON collection_service_patterns(route_id)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_coverage_barrio ON collection_route_barrio_coverage(barrio_id, route_id)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_runs_service_date ON collection_runs(service_date, route_id, truck_id)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_runs_active ON collection_runs(starts_at, ends_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_events_barrio_time ON collection_run_barrio_events(barrio_id, enters_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_events_route_time ON collection_run_barrio_events(route_id, enters_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_admin_sessions_expires ON collection_admin_sessions(expires_at)`)

  console.log('[db] Collection schema ready')

  await query(`
    CREATE TABLE IF NOT EXISTS municipal_barrios (
      id               BIGSERIAL PRIMARY KEY,
      municipality_id  BIGINT NOT NULL REFERENCES rag_municipalities(id) ON DELETE CASCADE,
      barrio_slug      VARCHAR(80) NOT NULL,
      barrio_label     VARCHAR(160) NOT NULL,
      barrio_code      VARCHAR(40),
      center_lat       DOUBLE PRECISION NOT NULL,
      center_lon       DOUBLE PRECISION NOT NULL,
      bbox             JSONB NOT NULL DEFAULT '{}'::jsonb,
      geometry         JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_name      TEXT,
      source_url       TEXT,
      imported_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (municipality_id, barrio_slug)
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_municipal_barrios_municipality ON municipal_barrios(municipality_id, barrio_label)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_municipal_barrios_code ON municipal_barrios(municipality_id, barrio_code)`)

  console.log('[db] Municipal geography schema ready')

  await query(`
    CREATE TABLE IF NOT EXISTS pothole_reports (
      id                  BIGSERIAL PRIMARY KEY,
      municipality_id     BIGINT REFERENCES rag_municipalities(id) ON DELETE RESTRICT,
      lat                 DOUBLE PRECISION NOT NULL,
      lon                 DOUBLE PRECISION NOT NULL,
      barrio_slug         VARCHAR(80) NOT NULL,
      barrio_label        VARCHAR(160) NOT NULL,
      pothole_type        VARCHAR(40) NOT NULL DEFAULT 'bache_aislado',
      reference_text      TEXT,
      description         TEXT NOT NULL,
      reported_severity   VARCHAR(20) NOT NULL,
      priority_band       VARCHAR(20) NOT NULL,
      priority_score      INTEGER NOT NULL DEFAULT 0,
      priority_overridden BOOLEAN NOT NULL DEFAULT FALSE,
      status              VARCHAR(30) NOT NULL DEFAULT 'nuevo',
      reporter_name       VARCHAR(160) NOT NULL,
      reporter_email      VARCHAR(200) NOT NULL,
      latest_status_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`ALTER TABLE pothole_reports ADD COLUMN IF NOT EXISTS municipality_id BIGINT REFERENCES rag_municipalities(id) ON DELETE RESTRICT`)
  await query(`
    UPDATE pothole_reports
    SET municipality_id = m.id
    FROM rag_municipalities m
    WHERE pothole_reports.municipality_id IS NULL
      AND m.slug = 'asuncion'
  `)
  await query(`ALTER TABLE pothole_reports ADD COLUMN IF NOT EXISTS pothole_type VARCHAR(40) NOT NULL DEFAULT 'bache_aislado'`)

  await query(`
    CREATE TABLE IF NOT EXISTS pothole_report_images (
      id          BIGSERIAL PRIMARY KEY,
      report_id   BIGINT NOT NULL REFERENCES pothole_reports(id) ON DELETE CASCADE,
      blob_path   TEXT NOT NULL,
      blob_url    TEXT NOT NULL,
      file_name   TEXT,
      mime_type   VARCHAR(120),
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS pothole_confirmations (
      id               BIGSERIAL PRIMARY KEY,
      report_id        BIGINT NOT NULL REFERENCES pothole_reports(id) ON DELETE CASCADE,
      confirmer_name   VARCHAR(160) NOT NULL,
      confirmer_email  VARCHAR(200) NOT NULL,
      note             TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (report_id, confirmer_email)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS pothole_status_history (
      id           BIGSERIAL PRIMARY KEY,
      report_id    BIGINT NOT NULL REFERENCES pothole_reports(id) ON DELETE CASCADE,
      from_status  VARCHAR(30),
      to_status    VARCHAR(30) NOT NULL,
      changed_by   TEXT NOT NULL,
      note         TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await query(`CREATE INDEX IF NOT EXISTS idx_pothole_reports_status ON pothole_reports(status, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_pothole_reports_priority ON pothole_reports(priority_band, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_pothole_reports_municipality ON pothole_reports(municipality_id, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_pothole_reports_barrio ON pothole_reports(barrio_slug, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_pothole_reports_coords ON pothole_reports(lat, lon)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_pothole_reports_type ON pothole_reports(pothole_type, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_pothole_images_report ON pothole_report_images(report_id, sort_order, id)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_pothole_history_report ON pothole_status_history(report_id, created_at DESC)`)

  console.log('[db] Potholes schema ready')

  await query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id            BIGSERIAL PRIMARY KEY,
      email         VARCHAR(200) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name          VARCHAR(160) NOT NULL,
      role          VARCHAR(20) NOT NULL,
      google_sub    VARCHAR(255),
      auth_provider VARCHAR(40) NOT NULL DEFAULT 'email',
      barrio_slug   VARCHAR(80),
      barrio_label  VARCHAR(160),
      address       TEXT,
      phone         VARCHAR(40),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_app_users_role ON app_users(role)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_app_users_barrio ON app_users(barrio_slug)`)
  await query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255)`)
  await query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(40) NOT NULL DEFAULT 'email'`)
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_google_sub ON app_users(google_sub) WHERE google_sub IS NOT NULL`)
  await query(`ALTER TABLE collection_notifications ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES app_users(id) ON DELETE CASCADE`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_notifications_user ON collection_notifications(user_id, created_at DESC)`)

  await query(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      session_id   VARCHAR(96) PRIMARY KEY,
      user_id      BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      expires_at   TIMESTAMPTZ NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(user_id)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON app_sessions(expires_at)`)

  await query(`
    CREATE TABLE IF NOT EXISTS app_user_action_usage (
      user_id      BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      action_key   VARCHAR(80) NOT NULL,
      usage_date   DATE NOT NULL,
      used_count   INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, action_key, usage_date)
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_app_user_action_usage_user ON app_user_action_usage(user_id, usage_date DESC)`)

  await query(`
    CREATE TABLE IF NOT EXISTS recolector_shifts (
      id            BIGSERIAL PRIMARY KEY,
      environment_key TEXT NOT NULL DEFAULT 'production',
      user_id       BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      route_id      VARCHAR(40) NOT NULL,
      route_label   VARCHAR(200) NOT NULL,
      barrio_slug   VARCHAR(80) NOT NULL,
      barrio_label  VARCHAR(160) NOT NULL,
      status        VARCHAR(20) NOT NULL DEFAULT 'online',
      started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at      TIMESTAMPTZ,
      last_lat      DOUBLE PRECISION,
      last_lon      DOUBLE PRECISION,
      last_seen_at  TIMESTAMPTZ
    )
  `)
  await query(`ALTER TABLE recolector_shifts ADD COLUMN IF NOT EXISTS environment_key TEXT NOT NULL DEFAULT 'production'`)
  await query(`CREATE INDEX IF NOT EXISTS idx_recolector_shifts_user ON recolector_shifts(user_id, started_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_recolector_shifts_active ON recolector_shifts(status, started_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_recolector_shifts_barrio ON recolector_shifts(barrio_slug, status)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_recolector_shifts_environment ON recolector_shifts(environment_key, status, started_at DESC)`)

  await query(`
    CREATE TABLE IF NOT EXISTS recolector_positions (
      id           BIGSERIAL PRIMARY KEY,
      environment_key TEXT NOT NULL DEFAULT 'production',
      shift_id     BIGINT NOT NULL REFERENCES recolector_shifts(id) ON DELETE CASCADE,
      lat          DOUBLE PRECISION NOT NULL,
      lon          DOUBLE PRECISION NOT NULL,
      recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`ALTER TABLE recolector_positions ADD COLUMN IF NOT EXISTS environment_key TEXT NOT NULL DEFAULT 'production'`)
  await query(`CREATE INDEX IF NOT EXISTS idx_recolector_positions_shift ON recolector_positions(shift_id, recorded_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_recolector_positions_environment ON recolector_positions(environment_key, recorded_at DESC)`)

  await query(`
    CREATE TABLE IF NOT EXISTS collection_notification_events (
      id               BIGSERIAL PRIMARY KEY,
      environment_key  TEXT NOT NULL DEFAULT 'production',
      notification_id  BIGINT NOT NULL REFERENCES collection_notifications(id) ON DELETE CASCADE,
      user_id          BIGINT REFERENCES app_users(id) ON DELETE CASCADE,
      shift_id         BIGINT REFERENCES recolector_shifts(id) ON DELETE CASCADE,
      route_id         VARCHAR(40),
      barrio_slug      VARCHAR(80) NOT NULL,
      channel          VARCHAR(40) NOT NULL,
      message          TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`ALTER TABLE collection_notification_events ADD COLUMN IF NOT EXISTS environment_key TEXT NOT NULL DEFAULT 'production'`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_notification_events_user ON collection_notification_events(user_id, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_notification_events_shift ON collection_notification_events(shift_id, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_collection_notification_events_environment ON collection_notification_events(environment_key, created_at DESC)`)

  console.log('[db] Auth + recolector schema ready')
}

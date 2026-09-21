/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  // Node
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),

  // App
  APP_KEY: Env.schema.secret(),
  APP_URL: Env.schema.string({ format: 'url', tld: false }),

  // Session
  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory', 'database'] as const),

  /*
  |----------------------------------------------------------
  | Variables for configuring database connection
  |----------------------------------------------------------
  */
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),

  /*
  |----------------------------------------------------------
  | Variables for the @outloud/adonis-scheduler package
  |----------------------------------------------------------
  | SCHEDULER_HTTP_SERVER=true runs the scheduler inside the HTTP server
  | (single process model). Set to false only when running it as a
  | standalone process via `node ace scheduler:run`.
  */
  SCHEDULER_HTTP_SERVER: Env.schema.boolean.optional(),

  /*
  |----------------------------------------------------------
  | Tiered bucket retention (app/tasks/prune_buckets.task.ts)
  |----------------------------------------------------------
  | Rows are pruned daily per tier:
  |   BUCKET_RETENTION_DAYS         native (~5 s) tables   — default 30
  |   BUCKET_5M_RETENTION_DAYS      5-minute rollups       — default 730 (2 yr)
  |   BUCKET_HOURLY_RETENTION_DAYS  hourly rollups         — default 730 (2 yr)
  | Each coarser tier is clamped to live at least as long as the finer one
  | below it. Set BUCKET_RETENTION_DAYS to 0 (or below 1) to disable the whole
  | sweep. The coarser horizons default to a 2-year wall so the database stops
  | growing once steady state is reached.
  */
  BUCKET_RETENTION_DAYS: Env.schema.number.optional(),
  BUCKET_5M_RETENTION_DAYS: Env.schema.number.optional(),
  BUCKET_HOURLY_RETENTION_DAYS: Env.schema.number.optional(),
  BUCKET_DAILY_RETENTION_DAYS: Env.schema.number.optional(),
  WIFI_SNAPSHOT_RETENTION_DAYS: Env.schema.number.optional(),
  WIFI_EVENT_RETENTION_DAYS: Env.schema.number.optional(),
  PEER_HOURLY_RETENTION_DAYS: Env.schema.number.optional(),
  SERVICE_HOURLY_RETENTION_DAYS: Env.schema.number.optional(),
  DESTINATION_HOURLY_RETENTION_DAYS: Env.schema.number.optional(),
  SERVICE_5M_RETENTION_DAYS: Env.schema.number.optional(),
  ROUTER_SAMPLE_RETENTION_DAYS: Env.schema.number.optional(),

  /*
  |----------------------------------------------------------
  | MariaDB runtime tuning (app/tasks/tune_database.task.ts)
  |----------------------------------------------------------
  | The host has no passwordless sudo, so the app applies the two InnoDB
  | settings that matter most for this workload at boot (and re-checks
  | hourly) via SET GLOBAL when the DB user is allowed to. The durable fix is
  | the config snippet in docs/ops/mariadb-perch.cnf; these are the
  | belt-and-braces. 0 / unset disables each one.
  */
  DB_TUNE_BUFFER_POOL_BYTES: Env.schema.number.optional(),
  DB_TUNE_FLUSH_LOG_AT_TRX_COMMIT: Env.schema.number.optional(),

  /*
  |----------------------------------------------------------
  | Counter-reset glitch guard (app/services/bucket_writer.ts)
  |----------------------------------------------------------
  | A single per-bucket delta whose in/out bytes exceed this many bytes is
  | dropped (and logged) instead of written. A device counter reset can make
  | the collector record an entire cumulative counter as one bucket ("1.1 TB
  | in 15 minutes"). Default 5 GB (~8 Gbps over a 5 s bucket; observed real
  | peak ~1.8 GB). Lower to catch ramps sooner, raise for 10GbE+ links, set 0
  | to disable.
  */
  BUCKET_MAX_DELTA_BYTES: Env.schema.number.optional(),

  /*
  |----------------------------------------------------------
  | Variables for the @adonisjs/lock package
  |----------------------------------------------------------
  | We default to in-process `memory` because the architecture is
  | single-process. Switch to `database` if a future split deployment
  | needs cross-process coordination.
  */
  LOCK_STORE: Env.schema.enum(['memory'] as const),

  /*
  |----------------------------------------------------------
  | CORS allowlist (consumed by config/cors.ts in production)
  |----------------------------------------------------------
  | Comma-separated origins; e.g. "https://metrics.example.com,https://dash.example.com".
  | Ignored in development (config/cors.ts allows all origins in dev).
  */
  CORS_ORIGIN: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Trusted reverse proxies (config/app.ts -> http.trustProxy)
  |----------------------------------------------------------
  | `proxy-addr` list syntax: a comma-separated set of addresses, CIDR
  | ranges or the presets `loopback` / `linklocal` / `uniquelocal`. Only
  | requests arriving FROM one of these are allowed to set the client
  | address via X-Forwarded-For, which is what `request.ip()` returns and
  | therefore what the collector announce endpoint derives `base_url` from
  | (docs/collector-management.md section 2.3).
  |
  | Default `loopback` = today's Adonis behaviour (an Apache vhost on the
  | same box). The Docker stack publishes the server on the host, so a
  | reverse proxy in front of it reaches the container from the stack's
  | gateway address and that subnet has to be trusted too — see the
  | TRUST_PROXY value docker-compose.yml sets on the server service.
  */
  TRUST_PROXY: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Default collector (providers/default_collector_provider.ts)
  |----------------------------------------------------------
  | When set and no collector row exists yet, the server registers this
  | collector at boot so the setup wizard can skip that step. The Docker
  | compose file points it at the collector container on the host network.
  */
  COLLECTOR_URL: Env.schema.string.optional(),
  COLLECTOR_API_KEY: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Perch AP Daemon install commands (docs/ap-controller.md section 4.2)
  |----------------------------------------------------------
  | AP_AGENT_RELEASE_URL     where the dashboard's install commands download
  |                          the daemon from (default: the GitHub releases of
  |                          capthndsme/perch-apd; set for a mirror).
  | AP_AGENT_CONTROLLER_URL  the server URL the commands tell agents to use.
  |                          Default: derived from the admin's request (the
  |                          address the dashboard is reached at).
  */
  AP_AGENT_RELEASE_URL: Env.schema.string.optional({ format: 'url', tld: false }),
  AP_AGENT_CONTROLLER_URL: Env.schema.string.optional({ format: 'url', tld: false }),
})

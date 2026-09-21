# Perch dashboard

The dashboard of Perch Network Controller: Vite, React 19, TypeScript, Tailwind v4,
TanStack Query, Recharts and Phosphor icons. It lives inside the server
repository and is built into `../public/`, which the API serves with an SPA
fallback, so in production there is one origin and no separate web server.
It talks only to the REST API with a bearer token.

## Run

```bash
npm install                   # or, from the server root: npm run install:dashboard
npm run dev                   # http://localhost:5173, /api proxied to the API on :3333
npm run lint
npm run build                 # tsc -b && vite build → ../public/
```

`VITE_API_URL` stays empty (same origin) unless the dashboard is hosted on a
different origin than the API; `.env.example` explains both.

## Pages

| Route | What it shows |
|---|---|
| `/setup`, `/login` | First-run wizard (admin, site, collector), sign in. |
| `/` | Dashboard: totals and live rate, Sites / Networks, month-to-date usage, Wi-Fi clients now and over time, gateway health, top talkers. |
| `/traffic` | Network-wide bandwidth with LAN overlay and period comparison, protocol and application mix, Destinations (domains and networks), Gateway panel. |
| `/usage` | vnstat-style daily / weekly / monthly table with per-protocol and per-application splits, hourly breakdown chart, connected-device averages. |
| `/devices`, `/devices/:mac` | Device list with filters (search, connection, device type, tag) and sorting, top talkers over time; per-device card with traffic, protocols, peers, sites served and destinations, Wi-Fi context, and the name / type / tags / notes editor. |
| `/servers` | Bytes served per TLS/HTTP name by your own hosts, with a rate overlay. |
| `/wifi`, `/wifi/ssids/:ssid`, `/wifi/aps/:id`, `/wifi/clients/:mac` | Client distribution by band or AP, throughput per AP, SSIDs, active clients, APs; SSID throughput and clients; AP health; client signal history and roaming. |
| `/settings`, `/settings/users`, `/settings/wifi-sources`, `/settings/hostname-enrichment` | Profile and password; users and roles; access points (probe, two-way commands); hostname sources. |

## Conventions

- Time window, resolution mode and refresh interval live in the URL
  (`src/hooks/use-dashboard-time.ts`), so every chart on a page shares them
  and links are reproducible. Charts zoom by drag and reset to the page
  default.
- API types are in `src/types/api.ts`, fetch hooks per area in `src/hooks/`,
  pure shaping helpers in `src/lib/`. Hooks keep the previous window's data on
  screen while a new one loads.
- Colours: download is red, upload is green (`--chart-download`,
  `--chart-upload`); multi-series charts use the `--series-N` palette and
  `--series-other` for "everything else". Tokens are defined in
  `src/index.css` for light and dark.
- Wi-Fi SSID endpoints report AP-side counters: `bytesIn` there is client
  *upload*. Device-side `bytesIn` is download. The per-AP throughput endpoint
  already speaks client terms.
- A device has two names: `hostname` (from DHCP) and `customName` (what the
  operator called it, from `device_labels`). Never pick between them by hand —
  `deviceDisplayName()` in `src/lib/device-labels.ts` is the one place that
  decides, and `deviceTypeMeta()` maps a device type to its icon. Filtering
  over a device uses `deviceSearchText()`, which also matches tags and notes.
- UI patterns (loading states, panels, tables, empty states) are in
  [`STYLEGUIDE.md`](STYLEGUIDE.md).

## Publishing

There is nothing to publish separately: `npm run build` (from the server root,
`npm run build` or `../deploy.sh`) writes the bundle into `../public/`, and
`node ace build` copies it into `build/public`, where the API serves it with
immutable caching for the hashed assets and `no-cache` for `index.html`. The
Docker image does the same. A separate static docroot on its own hostname
still works ([`../docs/ops/apache-dashboard-docroot.conf`](../docs/ops/apache-dashboard-docroot.conf))
but needs `VITE_API_URL` set to the API origin at build time.

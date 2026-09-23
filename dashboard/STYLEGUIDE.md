# Dashboard style guide

Conventions for building UI in this app. Keep new code consistent with what's
here; when you establish a new shared pattern, document it.

## Loading states

We distinguish four loading moments and treat them differently:

| Moment | Condition | Treatment |
| --- | --- | --- |
| **Page code or page-level data** (nothing of the page to show yet) | a route's chunk loading; a page (or gate) that renders nothing until one query answers | `PageSpinner` (below). |
| **First paint** (no data yet) | `query.isPending` | The panel's own placeholder — a short muted line (`"Loading …"`) or empty-state copy. |
| **Switching window/scope** (showing previous data) | `query.isPlaceholderData` | A `PanelOverlay` scrim + spinner over the existing content. |
| **Auto-refresh poll** (same window, periodic) | `query.isFetching` only | **Nothing** — the data updates in place; no overlay. |

The overlay keys on `isPlaceholderData`, **not** `isFetching`. With
`placeholderData: keepPreviousData` (see below), `isPlaceholderData` is true
only while a *different* query key loads — i.e. the user changed the time
range, scope, resolution, or dragged the mini-map, and we're still showing the
old data. A same-key auto-refresh poll keeps `isPlaceholderData` false, so the
periodic refresh never flashes the overlay.

### `PanelOverlay`

A drop-in, non-blocking loading scrim (`src/components/ui/panel-overlay.tsx`).

- Render it as the **last child** of a `relative` container — the `<section>`
  or `<Card>` that holds the chart/table/stat.
- It is `pointer-events-none` and fades (`transition-opacity`), so it never
  blocks interaction or flashes on fast refetches.
- Pass `show={query.isPlaceholderData}` and an optional `label="Updating…"`.

```tsx
<section className="relative space-y-3 rounded-lg border border-border bg-card p-4">
  {/* …chart / table / stats… */}
  <PanelOverlay show={traffic.isPlaceholderData} label="Updating…" />
</section>
```

> The container **must** be `relative` (the overlay is `absolute inset-0`).
> Forgetting it is the one easy mistake — the scrim will cover the whole page.

Every data panel should carry one. Components that wrap their own panel
(e.g. `ProtocolsSection`) take an `isPlaceholderData` prop and render the
overlay internally, so callers just forward `query.isPlaceholderData`.

### `Spinner`

The single spinning glyph (`src/components/ui/spinner.tsx`) — Phosphor
`CircleNotch` with our spin animation and muted colour. Size via `className`
(`size-4` default). Use it anywhere a loading affordance is needed; don't
hand-roll `animate-spin` on other icons. With reduced motion it stands still.

### `PageSpinner`

The page-level loading state, from the same file: a page whose chunk is still
downloading (every route's Suspense fallback), and a page or gate that shows
nothing until its one query answers (the setup and session checks, the
Presence, Hostname enrichment and Users settings pages, the network map).
Panels keep their own muted line.

- It fills the content area (`fullScreen` fills the viewport for sign-in,
  setup and the gates), so nothing shifts when the page arrives.
- It stays invisible for the first 150 ms (`.page-spinner-reveal` in
  `index.css`), so fast loads don't flash it. One that replaces a visible one
  shows at once instead of blinking.
- Pass `label` ("Loading presence settings"): screen readers get it, and with
  reduced motion it is shown next to a still glyph.

```tsx
if (query.isPending) return <PageSpinner label="Loading presence settings" />
```

## Data fetching

- Query hooks live in `src/hooks/` and return TanStack Query results directly.
- Window-driven queries set `placeholderData: keepPreviousData` so changing the
  range / dragging the mini-map doesn't blank the charts. New chart-backing
  queries should do the same.

## Charts

- Disable animation on every series (`isAnimationActive={false}`) and on the
  tooltip (defaulted off in `ChartTooltip`) — animation stutters on the dense
  (up to ~2k-point) series.
- Wide windows are LTTB-downsampled to ~2k points (`downsampleTimeSeries`)
  before rendering.
- The Infrastructure page does not load Recharts (a 387 kB chunk). Its device
  summary (`components/infra/device-summary.tsx`) draws inline-SVG sparklines:
  a viewBox stretched to the panel with `preserveAspectRatio="none"` and
  `vector-effect: non-scaling-stroke` on every stroke, the same colour tokens
  (`--chart-download` / `--chart-upload`, the signal-quality palette), and a
  readout under the chart for the point under the pointer, a tap, or the
  arrow keys.

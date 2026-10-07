import { defineAlertTypes } from '#services/alerts/registry'
import {
  conditionRender,
  forSpan,
  hhmm,
  listNames,
  plural,
  pNum,
  pStr,
  pTime,
} from '#services/alerts/render'
import type { RenderInput } from '#services/alerts/model'

const UNCLAIMED_REASONS: Record<string, string> = {
  late: 'late coin',
  full: 'terminal full',
  below_minimum: 'below the minimum',
}

function amountText(payload: Record<string, unknown>): string {
  const text = pStr(payload, 'amountText')
  if (text) return text
  const amount = pNum(payload, 'amount')
  const currency = pStr(payload, 'currency')
  return amount !== null ? `${currency ? `${currency} ` : ''}${amount.toFixed(2)}` : 'An amount'
}

function sumAmounts(alerts: RenderInput[]): string {
  const currency = pStr(alerts[0].payload, 'currency')
  const total = alerts.reduce((sum, a) => sum + (pNum(a.payload, 'amount') ?? 0), 0)
  return `${currency ? `${currency} ` : ''}${total.toFixed(2)}`
}

/**
 * Guest portal and Paid Hotspot (events.md §3.6, §3.7). Guest privacy
 * (README §6): no payload here carries a guest's MAC, IP or host name.
 */
export default defineAlertTypes([
  {
    type: 'portal.not_enforcing',
    category: 'portal',
    kind: 'condition',
    severity: 'critical',
    subjects: ['portal'],
    owner: 'alerts',
    label: 'Guest portal not enforcing',
    description: 'The router reports a guest portal that does not enforce sign-in.',
    render: conditionRender({
      state: 'not enforcing',
      opened: (a) => {
        const issues = Array.isArray(a.payload.issues)
          ? (a.payload.issues as unknown[]).filter((i): i is string => typeof i === 'string')
          : []
        const state = pStr(a.payload, 'state', 'error')
        const detail = issues[0] ?? pStr(a.payload, 'deliveryError')
        return {
          title: `Guest portal "${pStr(a.payload, 'name', a.label)}" is not enforcing`,
          body: `Router reports ${state}${detail ? `: ${detail}` : ''}. Guests may be blocked or let through without signing in.`,
        }
      },
      resolved: (a, c) => ({
        title: `Guest portal "${pStr(a.payload, 'name', a.label)}" is enforcing again`,
        body: forSpan(a, c, 'Not enforcing'),
      }),
    }),
  },
  {
    type: 'portal.quota_exhausted',
    category: 'portal',
    kind: 'notice',
    severity: 'info',
    subjects: ['portal', 'gateway'],
    owner: 'alerts',
    label: 'Guests used up their data',
    description: 'Guest grants reached their data quota.',
    defaults: { enabled: false, groupSeconds: 600 },
    render: (a) => ({
      title: 'A guest used up their data',
      body: `On "${pStr(a.payload, 'portalName', a.label)}".`,
    }),
    renderGroup: (alerts) => ({
      title: `${plural(
        alerts.reduce((n, a) => n + Math.max(1, a.eventCount), 0),
        'guest',
        'guests'
      )} used up their data`,
      body: `On "${pStr(alerts[0].payload, 'portalName', alerts[0].label)}" in the last 10 min.`,
    }),
  },
  {
    type: 'portal.external_auth',
    category: 'portal',
    kind: 'notice',
    severity: 'info',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Device authorised on the router by hand',
    description: 'Someone authorised a device on the router outside Perch; Perch undid it.',
    defaults: { groupSeconds: 300 },
    render: (a) => ({
      title: 'Someone authorised a device on the router by hand',
      body: `Perch undid it (${plural(Math.max(1, a.eventCount), 'time', 'times')}). Perch always decides who is signed in.`,
    }),
  },
  {
    type: 'hotspot.terminal_offline',
    category: 'portal',
    kind: 'condition',
    severity: 'warning',
    subjects: ['terminal'],
    owner: 'alerts',
    label: 'Coin terminal offline',
    description: 'A Paid Hotspot terminal stopped reporting.',
    defaults: { holdSeconds: 120, groupSeconds: 60 },
    render: conditionRender({
      state: 'offline',
      opened: (a, c) => {
        const since = pTime(a.payload, 'lastSeenAt') ?? a.raisedAt
        return {
          title: `Coin terminal ${pStr(a.payload, 'name', a.label)} is offline`,
          body: `No report since ${hhmm(since, c.zone)}.`,
          path: '/portal/terminals',
        }
      },
      resolved: (a, c) => ({
        title: `Coin terminal ${pStr(a.payload, 'name', a.label)} is back`,
        body: forSpan(a, c, 'Offline'),
        path: '/portal/terminals',
      }),
    }),
    renderGroup: (alerts) => ({
      title: `${alerts.length} coin terminals are offline`,
      body: listNames(alerts.map((a) => pStr(a.payload, 'name', a.label))),
    }),
  },
  {
    type: 'hotspot.terminal_error',
    category: 'portal',
    kind: 'condition',
    severity: 'warning',
    subjects: ['terminal'],
    owner: 'alerts',
    label: 'Coin terminal reports a problem',
    description: 'A Paid Hotspot terminal reports an error (acceptor, firmware).',
    defaults: { holdSeconds: 30 },
    render: conditionRender({
      state: 'failing',
      opened: (a) => ({
        title: `Coin terminal ${pStr(a.payload, 'name', a.label)} reports a problem`,
        body: pStr(a.payload, 'error', 'The terminal reports an error.'),
        path: '/portal/terminals',
      }),
      resolved: (a) => ({
        title: `Coin terminal ${pStr(a.payload, 'name', a.label)} is fine again`,
        body: 'It no longer reports an error.',
        path: '/portal/terminals',
      }),
    }),
  },
  {
    type: 'hotspot.unclaimed',
    category: 'portal',
    kind: 'notice',
    severity: 'warning',
    subjects: ['terminal', 'portal'],
    owner: 'alerts',
    label: 'Unclaimed coins',
    description: 'A terminal recorded money no guest was credited for; credit or dismiss it.',
    defaults: { groupSeconds: 300 },
    render: (a) => {
      const reason = pStr(a.payload, 'reason')
      return {
        title: `Unclaimed coins on ${pStr(a.payload, 'terminalName', a.label)}`,
        body: `${amountText(a.payload)}${reason ? ` (${UNCLAIMED_REASONS[reason] ?? reason})` : ''}. Credit or dismiss it in Payments.`,
        path: '/portal/payments',
      }
    },
    renderGroup: (alerts) => ({
      title: `${alerts.length} unclaimed payments`,
      body: `${sumAmounts(alerts)} in total. Credit or dismiss them in Payments.`,
    }),
  },
  {
    type: 'hotspot.checkout_rejected',
    category: 'portal',
    kind: 'notice',
    severity: 'warning',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Payment record rejected',
    description:
      'A payment record failed its checks (bad signature, unknown portal): possible tampering.',
    defaults: { groupSeconds: 300 },
    render: (a) => ({
      title: 'A payment record was rejected',
      body: `Reason: ${pStr(a.payload, 'reason', 'unknown')}. Check the terminal and the router.`,
      path: '/portal/payments',
    }),
    renderGroup: (alerts) => ({
      title: `${alerts.length} payment records were rejected`,
      body: `Reasons: ${listNames([...new Set(alerts.map((a) => pStr(a.payload, 'reason', 'unknown')))])}. Check the terminal and the router.`,
    }),
  },
  {
    type: 'hotspot.payment',
    category: 'portal',
    kind: 'notice',
    severity: 'info',
    subjects: ['portal'],
    owner: 'alerts',
    label: 'Payment received',
    description: 'A guest paid at a coin terminal, or a code was sold at the desk.',
    defaults: { enabled: false, groupSeconds: 600 },
    render: (a) => ({
      title: `Payment on "${pStr(a.payload, 'portalName', a.label)}"`,
      body:
        pStr(a.payload, 'channel') === 'desk'
          ? `${amountText(a.payload)} at the desk${pStr(a.payload, 'sellerName') ? ` (${pStr(a.payload, 'sellerName')})` : ''}.`
          : `${amountText(a.payload)}${pStr(a.payload, 'terminalName') ? ` at ${pStr(a.payload, 'terminalName')}` : ''}.`,
      path: '/portal/payments',
    }),
    renderGroup: (alerts) => ({
      title: `${alerts.length} payments on "${pStr(alerts[0].payload, 'portalName', alerts[0].label)}"`,
      body: `${sumAmounts(alerts)} in the last 10 min.`,
    }),
  },
])

import { useId, useState, type ReactNode } from 'react'
import { Warning } from '@phosphor-icons/react'
import { FiltersEditor } from '@/components/alerts/filters-editor'
import { Segmented } from '@/components/ui/segmented'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import {
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useCreateWebhook, useUpdateWebhook } from '@/hooks/use-webhooks'
import { apiErrorCode, fieldErrorsFromApi } from '@/lib/api'
import { WEBHOOK_PRESET_LABEL } from '@/lib/alerts'
import { cn } from '@/lib/utils'
import type {
  Filters,
  WebhookAuthInput,
  WebhookAuthType,
  WebhookFormat,
  WebhookInput,
  WebhookPreset,
  WebhookView,
} from '@/types/alerts'

type PresetMeta = {
  format: WebhookFormat
  blurb: string
  /** Where the URL comes from; null = the preset builds it (Telegram, Home Assistant). */
  urlLabel: string | null
  urlPlaceholder: string
  urlHelp?: string
  auth: WebhookAuthType[]
  /** A cloud service sees the content: say so next to Detail. */
  cloud: boolean
}

const PRESETS: Record<WebhookPreset, PresetMeta> = {
  ntfy: {
    format: 'ntfy',
    blurb: 'Phone notifications through the ntfy app, from ntfy.sh or your own server (works during a WAN outage).',
    urlLabel: 'Topic URL',
    urlPlaceholder: 'https://ntfy.sh/perch-x7k2m9q4',
    urlHelp: 'The topic’s full URL, as the ntfy app shows it. ntfy.sh topics are public by name: keep the random name, or use your own server with a token.',
    auth: ['none', 'bearer', 'basic'],
    cloud: true,
  },
  homeassistant: {
    format: 'standard',
    blurb: 'A webhook trigger in Home Assistant; an automation sends it to your phone (or flashes a light).',
    urlLabel: null,
    urlPlaceholder: 'http://homeassistant.local:8123',
    auth: ['none'],
    cloud: false,
  },
  gotify: {
    format: 'gotify',
    blurb: 'Your own Gotify server and its Android app.',
    urlLabel: 'Server URL',
    urlPlaceholder: 'https://gotify.example.com',
    auth: ['gotify'],
    cloud: false,
  },
  telegram: {
    format: 'telegram',
    blurb: 'A Telegram bot posts to a chat, group or channel.',
    urlLabel: null,
    urlPlaceholder: '',
    auth: ['telegram'],
    cloud: true,
  },
  discord: {
    format: 'discord',
    blurb: 'A message in a Discord channel.',
    urlLabel: 'Webhook URL',
    urlPlaceholder: 'https://discord.com/api/webhooks/…',
    urlHelp: 'Channel settings → Integrations → Webhooks → Copy Webhook URL.',
    auth: ['none'],
    cloud: true,
  },
  slack: {
    format: 'slack',
    blurb: 'A message in Slack, Mattermost or Rocket.Chat (incoming webhooks).',
    urlLabel: 'Webhook URL',
    urlPlaceholder: 'https://hooks.slack.com/services/…',
    auth: ['none'],
    cloud: true,
  },
  generic: {
    format: 'standard',
    blurb: 'A signed JSON POST (Standard Webhooks) for scripts, n8n, Node-RED, Uptime Kuma.',
    urlLabel: 'Receiver URL',
    urlPlaceholder: 'https://hooks.example.com/perch',
    urlHelp: 'Receivers verify the signature with a Standard Webhooks library; the secret is shown once after saving.',
    auth: ['none', 'bearer', 'basic', 'header'],
    cloud: false,
  },
}

const PRESET_ORDER: WebhookPreset[] = ['ntfy', 'homeassistant', 'gotify', 'telegram', 'discord', 'slack', 'generic']

const AUTH_LABEL: Record<WebhookAuthType, string> = {
  none: 'None',
  bearer: 'Bearer token',
  basic: 'User and password',
  header: 'Custom header',
  gotify: 'App token',
  telegram: 'Bot token',
}

function randomName(length: number): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

function defaultFilters(preset: WebhookPreset): Filters {
  return {
    minSeverity: 'info',
    categories: null,
    types: null,
    quietHours: preset === 'generic' || preset === 'homeassistant' ? 'ignore' : 'inherit',
  }
}

/** A LAN target: private or loopback address, or a name only a home network resolves. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host.includes('.') && !host.includes(':')) return true
  if (/\.(local|lan|home|internal|home\.arpa|localhost)$/.test(host)) return true
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  return host === '::1' || host.startsWith('fd') || host.startsWith('fe80')
}

function urlProblem(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Use an http:// or https:// URL.'
    if (url.username || url.password) return 'Put credentials under Authentication, not in the URL.'
    return null
  } catch {
    return 'Not a URL.'
  }
}

function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

const inputClass = 'h-9 rounded-md'

type Created = { webhook: WebhookView; secret: string | null; haUrl: string | null }

/**
 * Add or edit a webhook (design README §5, api.md §3.6, delivery.md §2). New ones start from a preset
 * (ntfy, Home Assistant, Gotify, Telegram, Discord, Slack, generic JSON) with its own fields and help; the
 * signing secret of a generic JSON webhook, and Home Assistant's automation, are shown once after saving.
 * Secrets and URLs are never sent back by the controller: when editing, empty fields keep what is stored.
 */
export function WebhookDialog({ webhook, onDone }: { webhook: WebhookView | null; onDone: () => void }) {
  const [preset, setPreset] = useState<WebhookPreset | null>(webhook?.preset ?? null)
  const [created, setCreated] = useState<Created | null>(null)

  if (created) return <CreatedStep created={created} onDone={onDone} />
  if (!preset) return <PresetStep onPick={setPreset} />
  return (
    <WebhookForm
      preset={preset}
      webhook={webhook}
      onBack={webhook ? null : () => setPreset(null)}
      onCreated={setCreated}
      onDone={onDone}
    />
  )
}

function PresetStep({ onPick }: { onPick: (preset: WebhookPreset) => void }) {
  return (
    <DialogContent wide>
      <DialogHeader>
        <DialogTitle>Add a webhook</DialogTitle>
        <DialogDescription>Where should alerts go?</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <ul className="grid gap-2 sm:grid-cols-2">
          {PRESET_ORDER.map((key) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => onPick(key)}
                className="flex h-full w-full flex-col items-start gap-1 rounded-lg border border-border px-3 py-2.5 text-left transition-colors duration-base hover:bg-muted/50 active:bg-muted active:duration-0"
              >
                <span className="text-[13px] font-medium">{WEBHOOK_PRESET_LABEL[key]}</span>
                <span className="text-xs text-muted-foreground">{PRESETS[key].blurb}</span>
              </button>
            </li>
          ))}
        </ul>
      </DialogBody>
    </DialogContent>
  )
}

function WebhookForm({
  preset,
  webhook,
  onBack,
  onCreated,
  onDone,
}: {
  preset: WebhookPreset
  webhook: WebhookView | null
  onBack: (() => void) | null
  onCreated: (created: Created) => void
  onDone: () => void
}) {
  const meta = PRESETS[preset]
  const editing = webhook !== null
  const create = useCreateWebhook()
  const update = useUpdateWebhook()
  const mutation = editing ? update : create
  const id = useId()

  const [name, setName] = useState(webhook?.name ?? WEBHOOK_PRESET_LABEL[preset])
  const [url, setUrl] = useState(editing ? '' : preset === 'ntfy' ? `https://ntfy.sh/perch-${randomName(10)}` : '')
  const [haBase, setHaBase] = useState('http://homeassistant.local:8123')
  const [haId] = useState(() => `perch-${randomName(16)}`)
  const [authType, setAuthType] = useState<WebhookAuthType>(webhook?.auth.type ?? meta.auth[0])
  const [token, setToken] = useState('')
  const [username, setUsername] = useState(webhook?.auth.username ?? '')
  const [password, setPassword] = useState('')
  const [headerName, setHeaderName] = useState(webhook?.auth.headerName ?? '')
  const [chatId, setChatId] = useState(webhook?.options.chatId ?? '')
  const [threadId, setThreadId] = useState(webhook?.options.messageThreadId ? String(webhook.options.messageThreadId) : '')
  const [discordName, setDiscordName] = useState(webhook?.options.username ?? '')
  const [detail, setDetail] = useState<'full' | 'minimal'>(webhook?.detail ?? 'full')
  const [filters, setFilters] = useState<Filters>(webhook?.filters ?? defaultFilters(preset))
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true)
  const [problem, setProblem] = useState<string | null>(null)

  const serverFields = fieldErrorsFromApi(mutation.error)
  const code = apiErrorCode(mutation.error)
  const haUrl = `${haBase.replace(/\/+$/, '')}/api/webhook/${haId}`
  const effectiveUrl = preset === 'homeassistant' && !editing ? haUrl : url.trim()
  const urlError = effectiveUrl ? urlProblem(effectiveUrl) : null
  let plainToInternet = false
  try {
    const parsed = effectiveUrl ? new URL(effectiveUrl) : null
    plainToInternet = parsed !== null && parsed.protocol === 'http:' && !isPrivateHost(parsed.hostname)
  } catch {
    // urlError says it
  }
  const secretChanged = token !== '' || password !== ''

  function buildAuth(): WebhookAuthInput | undefined {
    switch (authType) {
      case 'none':
        return editing && webhook?.auth.type === 'none' ? undefined : { type: 'none' }
      case 'bearer':
        return token ? { type: 'bearer', token } : undefined
      case 'gotify':
        return token ? { type: 'gotify', token } : undefined
      case 'telegram':
        return token ? { type: 'telegram', botToken: token } : undefined
      case 'basic':
        return password ? { type: 'basic', username, password } : undefined
      case 'header':
        return token ? { type: 'header', name: headerName.trim(), value: token } : undefined
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setProblem(null)
    const needsUrl = meta.format !== 'telegram'
    if (!name.trim()) return setProblem('Give it a name.')
    if (needsUrl && !editing && !effectiveUrl) return setProblem(`Enter the ${(meta.urlLabel ?? 'URL').toLowerCase()}.`)
    if (urlError) return setProblem(urlError)
    const auth = buildAuth()
    const authRequired = (authType === 'gotify' || authType === 'telegram') && !editing
    if (authRequired && !auth) return setProblem(`Enter the ${AUTH_LABEL[authType].toLowerCase()}.`)
    if (!editing && authType !== 'none' && !auth) return setProblem(`Fill in the ${AUTH_LABEL[authType].toLowerCase()}.`)
    if (meta.format === 'telegram' && !chatId.trim()) return setProblem('Enter the chat id.')

    const input: WebhookInput = {
      name: name.trim(),
      format: meta.format,
      preset,
      ...(effectiveUrl ? { url: effectiveUrl } : {}),
      ...(auth ? { auth } : {}),
      options:
        meta.format === 'telegram'
          ? { chatId: chatId.trim(), ...(threadId.trim() ? { messageThreadId: Number(threadId) } : {}) }
          : meta.format === 'discord' && discordName.trim()
            ? { username: discordName.trim() }
            : undefined,
      filters,
      detail,
      respectQuietHours: filters.quietHours === 'inherit',
      enabled,
    }
    if (editing) {
      update.mutate({ id: webhook.id, ...input }, { onSuccess: onDone })
    } else {
      create.mutate(input, {
        onSuccess: (result) => {
          if (result.secret || preset === 'homeassistant') {
            onCreated({ webhook: result.webhook, secret: result.secret, haUrl: preset === 'homeassistant' ? haUrl : null })
          } else onDone()
        },
      })
    }
  }

  const codeText =
    code === 'webhook_url_invalid'
      ? 'The controller refused this URL.'
      : code === 'webhook_auth_invalid'
        ? 'This kind of webhook does not take that authentication, or a required one is missing.'
        : code === 'webhook_options_invalid'
          ? 'Telegram needs a chat id.'
          : null
  const otherError = mutation.error && !codeText && Object.keys(serverFields).length === 0 ? mutation.error.message : null

  return (
    <DialogContent wide>
      <form onSubmit={submit} className="contents">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${webhook.name}` : WEBHOOK_PRESET_LABEL[preset]}</DialogTitle>
          <DialogDescription>{meta.blurb}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Name" htmlFor={`${id}-name`} error={serverFields.name}>
            <Input id={`${id}-name`} className={inputClass} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          {preset === 'homeassistant' && !editing ? (
            <Field
              label="Home Assistant address"
              htmlFor={`${id}-ha`}
              error={serverFields.url ?? urlError ?? undefined}
              hint={
                <>
                  Perch posts to <span className="font-mono break-all">{haUrl}</span>. The webhook id is the password:
                  keep it private.
                </>
              }
            >
              <Input id={`${id}-ha`} className={inputClass} value={haBase} onChange={(e) => setHaBase(e.target.value)} inputMode="url" />
            </Field>
          ) : meta.urlLabel ? (
            <Field
              label={meta.urlLabel}
              htmlFor={`${id}-url`}
              error={serverFields.url ?? urlError ?? undefined}
              hint={editing ? `Stored: ${webhook.urlDisplay}. Leave empty to keep it.` : meta.urlHelp}
            >
              <Input
                id={`${id}-url`}
                className={cn(inputClass, 'font-mono')}
                value={url}
                placeholder={editing ? webhook.urlDisplay : meta.urlPlaceholder}
                onChange={(e) => setUrl(e.target.value)}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          ) : null}
          {plainToInternet ? (
            <p className="flex items-start gap-1.5 text-xs text-status-serious">
              <Warning className="mt-px size-3.5 shrink-0" />
              Plain http:// to an address outside your network: the message and any token travel unencrypted.
            </p>
          ) : null}

          {meta.format === 'telegram' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Chat id" htmlFor={`${id}-chat`} error={serverFields['options.chatId']} hint="Numeric id, or @channelname.">
                <Input id={`${id}-chat`} className={inputClass} value={chatId} onChange={(e) => setChatId(e.target.value)} />
              </Field>
              <Field label="Topic id (optional)" htmlFor={`${id}-thread`} hint="For a forum group’s topic.">
                <Input
                  id={`${id}-thread`}
                  className={inputClass}
                  value={threadId}
                  inputMode="numeric"
                  onChange={(e) => setThreadId(e.target.value.replace(/\D/g, ''))}
                />
              </Field>
            </div>
          ) : null}
          {meta.format === 'discord' ? (
            <Field label="Posts as (optional)" htmlFor={`${id}-dname`} hint="Defaults to “Perch”.">
              <Input id={`${id}-dname`} className={inputClass} maxLength={80} value={discordName} onChange={(e) => setDiscordName(e.target.value)} />
            </Field>
          ) : null}

          {meta.auth.length > 1 || meta.auth[0] !== 'none' ? (
            <div className="space-y-3">
              {meta.auth.length > 1 ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Authentication</p>
                  <Segmented
                    size="xs"
                    ariaLabel="Authentication"
                    value={authType}
                    onChange={setAuthType}
                    options={meta.auth.map((type) => ({ id: type, label: AUTH_LABEL[type] }))}
                    className="w-fit flex-wrap"
                  />
                </div>
              ) : null}
              {authType === 'basic' ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="User" htmlFor={`${id}-user`}>
                    <Input id={`${id}-user`} className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                  </Field>
                  <Field label="Password" htmlFor={`${id}-pass`} hint={editing ? 'Leave empty to keep it.' : undefined}>
                    <Input id={`${id}-pass`} type="password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                  </Field>
                </div>
              ) : authType !== 'none' ? (
                <div className={cn('grid gap-4', authType === 'header' && 'sm:grid-cols-2')}>
                  {authType === 'header' ? (
                    <Field label="Header name" htmlFor={`${id}-hname`}>
                      <Input id={`${id}-hname`} className={cn(inputClass, 'font-mono')} value={headerName} placeholder="X-Api-Key" onChange={(e) => setHeaderName(e.target.value)} />
                    </Field>
                  ) : null}
                  <Field
                    label={authType === 'header' ? 'Header value' : AUTH_LABEL[authType]}
                    htmlFor={`${id}-token`}
                    error={serverFields['auth.token'] ?? serverFields['auth.botToken']}
                    hint={
                      editing
                        ? 'Stored and never shown. Leave empty to keep it.'
                        : authType === 'telegram'
                          ? 'From @BotFather. Add the bot to the chat first.'
                          : authType === 'gotify'
                            ? 'Gotify → Apps → create an application.'
                            : authType === 'bearer' && preset === 'ntfy'
                              ? 'An ntfy access token (tk_…).'
                              : undefined
                    }
                  >
                    <Input
                      id={`${id}-token`}
                      type="password"
                      className={cn(inputClass, 'font-mono')}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <p className="text-xs font-medium">Detail</p>
            <Segmented
              size="xs"
              ariaLabel="Detail"
              value={detail}
              onChange={setDetail}
              options={[
                { id: 'full', label: 'Full' },
                { id: 'minimal', label: 'Minimal' },
              ]}
              className="w-fit"
            />
            <p className="text-xs text-muted-foreground">
              Minimal leaves out MAC and IP addresses, device host names and public IPs.
              {meta.cloud && detail === 'full'
                ? ' This service runs in the cloud and will see device names and addresses.'
                : ''}{' '}
              Guest details are never sent.
            </p>
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="section-label">What it receives</p>
            <FiltersEditor idPrefix={`${id}-filters`} value={filters} onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))} />
          </div>

          <label htmlFor={`${id}-enabled`} className="flex items-center justify-between gap-4">
            <span className="text-xs font-medium">Enabled</span>
            <Switch id={`${id}-enabled`} checked={enabled} onCheckedChange={setEnabled} />
          </label>

          {problem || codeText || otherError ? <p className="text-xs text-destructive">{problem ?? codeText ?? otherError}</p> : null}
          {editing && secretChanged ? (
            <p className="text-xs text-muted-foreground">The new credentials replace the stored ones when you save.</p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {onBack ? (
            <Button type="button" variant="ghost" onClick={onBack} className="sm:mr-auto">
              Back
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : editing ? 'Save' : 'Add webhook'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function haAutomation(webhookId: string): string {
  return `alias: Perch alert to my phone
triggers:
  - trigger: webhook
    webhook_id: ${webhookId}
    allowed_methods: [POST]
    local_only: true
actions:
  - action: notify.mobile_app_YOUR_PHONE
    data:
      title: "{{ trigger.json.message.title }}"
      message: "{{ trigger.json.message.body }}"
      data:
        url: "{{ trigger.json.message.url }}"
        clickAction: "{{ trigger.json.message.url }}"
`
}

/** After saving: the signing secret (once) and, for Home Assistant, the automation to paste. */
function CreatedStep({ created, onDone }: { created: Created; onDone: () => void }) {
  const webhookId = created.haUrl?.split('/api/webhook/')[1] ?? null
  const yaml = webhookId ? haAutomation(webhookId) : null
  return <SecretReveal title={`${created.webhook.name} added`} secret={created.secret} yaml={yaml} onDone={onDone} />
}

/** Shows a new signing secret exactly once (create, rotate). */
export function SecretReveal({
  title,
  secret,
  yaml = null,
  onDone,
}: {
  title: string
  secret: string | null
  yaml?: string | null
  onDone: () => void
}) {
  return (
    <DialogContent wide>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {secret ? 'Copy the signing secret now: Perch shows it only this once.' : 'One more step in Home Assistant.'}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {secret ? (
          <div className="space-y-2">
            <p className="section-label">Signing secret</p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-2">
              <code className="min-w-0 flex-1 font-mono text-[12px] break-all">{secret}</code>
              <CopyButton value={secret} ariaLabel="Copy the signing secret" />
            </div>
            <p className="text-xs text-muted-foreground">
              Every request carries <span className="font-mono">webhook-id</span>, <span className="font-mono">webhook-timestamp</span>{' '}
              and <span className="font-mono">webhook-signature</span> headers. Verify them with a Standard Webhooks library
              (Node, Python, Go and more) and this secret; skip duplicates by <span className="font-mono">webhook-id</span>.
            </p>
          </div>
        ) : null}
        {yaml ? (
          <div className="space-y-2">
            <p className="section-label">Home Assistant automation</p>
            <p className="text-xs text-muted-foreground">
              Settings → Automations → Create → Edit in YAML, paste, and put your phone’s notify action in place of{' '}
              <span className="font-mono">notify.mobile_app_YOUR_PHONE</span>.
            </p>
            <div className="relative">
              <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed">
                {yaml}
              </pre>
              <CopyButton value={yaml} className="absolute top-2 right-2" ariaLabel="Copy the automation" />
            </div>
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </DialogContent>
  )
}

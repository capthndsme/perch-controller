import type { Collector, CollectorStatus } from '@/types/api'

export type SetupStep = 'admin' | 'instance' | 'collector' | 'complete'

export type SetupStatusResponse = {
  step: SetupStep
  adminExists: boolean
  hasInstance: boolean
  hasCollector: boolean
  /** The admin chose "Skip for now" at the collector step. */
  collectorsDeferred: boolean
  suggestedCollectorUrl: string
  defaultPollIntervalSeconds: number
  defaultCollectorName: string
}

export type SetupAdminPayload = {
  fullName: string | null
  email: string
  password: string
  passwordConfirmation: string
}

export type SetupInstancePayload = {
  siteName: string
  timezone: string
}

export type SetupCollectorPayload = {
  name: string
  baseUrl: string
  apiKey?: string | null
  pollIntervalSeconds: number
}

export type UserSummary = {
  id: number
  fullName: string | null
  email: string
  role: string
}

export type CollectorProbe = {
  ok: boolean
  checkedAt: string
  latencyMs?: number
  error?: string
  totalDevices?: number
  captureInterface?: string
}

export type CollectorSummary = {
  id: number
  name: string
  baseUrl: string
  hasApiKey: boolean
  pollIntervalSeconds: number
  enabled: boolean
  lastStatus: CollectorProbe | null
}

export type SetupAdminResponse = {
  user: UserSummary
  token: string
}

export type SetupCollectorResponse = {
  collector: CollectorSummary
  probe: CollectorProbe
  setupComplete: boolean
}

export type FieldError = {
  field?: string
  message: string
}

/** `GET /api/v1/setup/collector/candidates`: collectors waiting for adoption. */
export type SetupCandidatesResponse = {
  /** `lifecycle === 'pending'`, newest announce first. */
  candidates: Collector[]
  /** False when announces are switched off, so nothing new can appear. */
  discoveryEnabled: boolean
}

export type SetupAdoptPayload = {
  name?: string
  pollIntervalSeconds?: number
  apiKey?: string | null
  /** Adopt even though the key does not match the announced fingerprint. */
  acceptKeyChange?: boolean
}

export type SetupAdoptResponse = {
  collector: Collector
  probe: CollectorStatus
  setupComplete: boolean
}

export type SetupSkipResponse = {
  setupComplete: boolean
}

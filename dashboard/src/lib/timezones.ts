const FALLBACK_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
]

export function getTimezoneOptions(): string[] {
  if (typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl) {
    return Intl.supportedValuesOf('timeZone').slice().sort()
  }

  return FALLBACK_TIMEZONES
}

export function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

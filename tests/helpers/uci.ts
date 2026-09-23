import { readFileSync } from 'node:fs'
import type { UciConfig, UciOptions } from '#services/gateway_config/types'

/**
 * Minimal UCI text reader for test fixtures (`config`, `option`, `list`,
 * single-quoted values), producing the shape `ubus call uci get` hands the
 * agent (`UciConfig`).
 */
export function parseUci(text: string, name = 'sqm'): UciConfig {
  const sections: UciConfig['sections'] = []
  let current: UciConfig['sections'][number] | null = null
  const unquote = (value: string) => value.replace(/^'(.*)'$/, '$1')
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('package')) continue
    const configMatch = /^config\s+(\S+)(?:\s+(\S+))?$/.exec(line)
    if (configMatch) {
      current = {
        name: configMatch[2] ? unquote(configMatch[2]) : `@${configMatch[1]}[${sections.length}]`,
        type: configMatch[1],
        anonymous: !configMatch[2],
        index: sections.length,
        options: {},
      }
      sections.push(current)
      continue
    }
    const optionMatch = /^(option|list)\s+(\S+)\s+'(.*)'$/.exec(line)
    if (!optionMatch || !current) throw new Error(`bad fixture line: ${line}`)
    const [, kind, key, value] = optionMatch
    if (kind === 'option') current.options[key] = value
    else {
      const list = current.options[key]
      current.options[key] = Array.isArray(list) ? [...list, value] : [value]
    }
  }
  return { name, hash: 'fixture', sections }
}

/** A `sqm` fixture from tests/unit/services/fixtures/sqm as a whole config. */
export function sqmFixtureConfig(file: string): UciConfig {
  const text = readFileSync(
    new URL(`../unit/services/fixtures/sqm/${file}`, import.meta.url),
    'utf8'
  )
  return parseUci(text, 'sqm')
}

/** The first section of a `sqm` fixture. */
export function sqmFixture(file: string): { name: string; options: UciOptions } {
  const section = sqmFixtureConfig(file).sections[0]
  return { name: section.name, options: section.options }
}

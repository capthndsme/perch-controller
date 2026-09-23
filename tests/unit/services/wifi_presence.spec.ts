import { PRESENCE_LIMITS, normalizePresenceSettings } from '#services/presence_settings'
import { PRESENCE_DEFAULTS, apStaleSeconds, devicePresence } from '#services/wifi_presence'
import { test } from '@japa/runner'

const now = Date.parse('2026-09-22T12:00:00Z')
const ago = (seconds: number) => now - seconds * 1000
const iso = (seconds: number) => new Date(ago(seconds)).toISOString()

test.group('devicePresence', () => {
  test('a device its AP lists is connected, however quiet its traffic', ({ assert }) => {
    assert.deepEqual(
      devicePresence(
        { wifi: { connected: true, heardAt: ago(20) }, trafficAt: ago(5 * 3600) },
        PRESENCE_DEFAULTS,
        now
      ),
      { status: 'connected', via: 'wifi', lastSeenAt: iso(20) }
    )
  })

  test('traffic that ended with the last Wi-Fi sighting: it left over Wi-Fi', ({ assert }) => {
    // The gateway kept forwarding to it for a few minutes after it left: not a
    // sighting, so it was last seen when its AP last heard it.
    assert.deepEqual(
      devicePresence(
        { wifi: { connected: false, heardAt: ago(2 * 3600) }, trafficAt: ago(2 * 3600 - 300) },
        PRESENCE_DEFAULTS,
        now
      ),
      { status: 'disconnected', via: 'wifi', lastSeenAt: iso(2 * 3600) }
    )
    // Seen by an AP, never by the collector.
    assert.deepEqual(
      devicePresence(
        { wifi: { connected: false, heardAt: ago(600) }, trafficAt: null },
        PRESENCE_DEFAULTS,
        now
      ),
      { status: 'disconnected', via: 'wifi', lastSeenAt: iso(600) }
    )
  })

  test('traffic well after the last Wi-Fi sighting: it is on the LAN now', ({ assert }) => {
    const wifi = { connected: false, heardAt: ago(3 * 86_400) }
    assert.deepEqual(devicePresence({ wifi, trafficAt: ago(60) }, PRESENCE_DEFAULTS, now), {
      status: 'connected',
      via: 'lan',
      lastSeenAt: iso(60),
    })
    assert.deepEqual(devicePresence({ wifi, trafficAt: ago(2 * 3600) }, PRESENCE_DEFAULTS, now), {
      status: 'disconnected',
      via: 'lan',
      lastSeenAt: iso(2 * 3600),
    })
  })

  test('without Wi-Fi it goes by traffic: quiet for 30 minutes is disconnected', ({ assert }) => {
    const presence = (trafficAt: number | null) =>
      devicePresence({ wifi: null, trafficAt }, PRESENCE_DEFAULTS, now)
    assert.equal(presence(ago(29 * 60)).status, 'connected')
    assert.deepEqual(presence(ago(30 * 60)), {
      status: 'disconnected',
      via: 'lan',
      lastSeenAt: iso(30 * 60),
    })
    assert.deepEqual(presence(null), { status: 'disconnected', via: 'lan', lastSeenAt: null })
  })

  test('marked Ethernet: it goes by its traffic, unless an AP lists it right now', ({ assert }) => {
    // Left Wi-Fi an hour ago and talked a minute later: unmarked, that minute is
    // the gateway talking to a device that is gone; marked, it is the cable.
    const left = { wifi: { connected: false, heardAt: ago(3600) }, trafficAt: ago(3540) }
    assert.equal(devicePresence(left, PRESENCE_DEFAULTS, now).via, 'wifi')
    assert.deepEqual(devicePresence({ ...left, ethernet: true }, PRESENCE_DEFAULTS, now), {
      status: 'disconnected',
      via: 'ethernet',
      lastSeenAt: iso(3540),
    })
    assert.deepEqual(
      devicePresence({ wifi: null, trafficAt: ago(60), ethernet: true }, PRESENCE_DEFAULTS, now),
      { status: 'connected', via: 'ethernet', lastSeenAt: iso(60) }
    )
    assert.deepEqual(
      devicePresence({ wifi: null, trafficAt: null, ethernet: true }, PRESENCE_DEFAULTS, now),
      { status: 'disconnected', via: 'ethernet', lastSeenAt: null }
    )
    // An AP lists it right now: that is where it is, whatever the mark says.
    assert.deepEqual(
      devicePresence(
        { wifi: { connected: true, heardAt: ago(5) }, trafficAt: ago(1), ethernet: true },
        PRESENCE_DEFAULTS,
        now
      ),
      { status: 'connected', via: 'wifi', lastSeenAt: iso(5) }
    )
  })

  test('cabled on the map: wired like the mark, the Wi-Fi memory rule skipped', ({ assert }) => {
    // Left Wi-Fi an hour ago, talked a minute later: unmarked and not on the
    // map, that is the gateway talking to a device that is gone.
    const left = { wifi: { connected: false, heardAt: ago(3600) }, trafficAt: ago(3540) }
    assert.equal(devicePresence(left, PRESENCE_DEFAULTS, now).via, 'wifi')
    // Cabled on the map (no live port at the far end): it goes by its traffic.
    const cabled = { wired: true, link: null }
    assert.deepEqual(devicePresence({ ...left, onMap: cabled }, PRESENCE_DEFAULTS, now), {
      status: 'disconnected',
      via: 'ethernet',
      lastSeenAt: iso(3540),
    })
    assert.deepEqual(
      devicePresence({ wifi: null, trafficAt: ago(60), onMap: cabled }, PRESENCE_DEFAULTS, now),
      { status: 'connected', via: 'ethernet', lastSeenAt: iso(60) }
    )
    assert.deepEqual(
      devicePresence({ wifi: null, trafficAt: null, onMap: cabled }, PRESENCE_DEFAULTS, now),
      { status: 'disconnected', via: 'ethernet', lastSeenAt: null }
    )
  })

  test('a quiet wired device on a live port with link is connected', ({ assert }) => {
    // Quiet for 45 minutes; the AP's port reported link 5 s ago.
    const onMap = { wired: true, link: { up: true, at: ago(5) } }
    assert.deepEqual(
      devicePresence({ wifi: null, trafficAt: ago(45 * 60), onMap }, PRESENCE_DEFAULTS, now),
      { status: 'connected', via: 'ethernet', lastSeenAt: iso(5) }
    )
    // Never talked at all: the link alone says it is there.
    assert.deepEqual(
      devicePresence({ wifi: null, trafficAt: null, onMap }, PRESENCE_DEFAULTS, now),
      {
        status: 'connected',
        via: 'ethernet',
        lastSeenAt: iso(5),
      }
    )
    // The operator's mark reads the link the same way.
    assert.deepEqual(
      devicePresence(
        {
          wifi: null,
          trafficAt: ago(45 * 60),
          ethernet: true,
          onMap: { wired: false, link: { up: true, at: ago(5) } },
        },
        PRESENCE_DEFAULTS,
        now
      ),
      { status: 'connected', via: 'ethernet', lastSeenAt: iso(5) }
    )
  })

  test('traffic never loses to the map: a talking device on a port without link', ({ assert }) => {
    // The port says the link went down 10 minutes ago, yet the device talked a
    // minute ago: the drawing is wrong, not the device.
    const down = { wired: true, link: { up: false, at: ago(600) } }
    assert.deepEqual(
      devicePresence({ wifi: null, trafficAt: ago(60), onMap: down }, PRESENCE_DEFAULTS, now),
      { status: 'connected', via: 'ethernet', lastSeenAt: iso(60) }
    )
    // Quiet since before the link went down: gone when the link went down.
    assert.deepEqual(
      devicePresence({ wifi: null, trafficAt: ago(3600), onMap: down }, PRESENCE_DEFAULTS, now),
      { status: 'disconnected', via: 'ethernet', lastSeenAt: iso(600) }
    )
    // Quiet, no traffic ever: last seen when the link went down.
    assert.deepEqual(
      devicePresence({ wifi: null, trafficAt: null, onMap: down }, PRESENCE_DEFAULTS, now),
      { status: 'disconnected', via: 'ethernet', lastSeenAt: iso(600) }
    )
  })

  test('the map only speaks for wired cables; an AP listing still comes first', ({ assert }) => {
    // A wireless or virtual cable, or none: the rules without the map.
    const notWired = { wired: false, link: { up: true, at: ago(5) } }
    const left = { wifi: { connected: false, heardAt: ago(3600) }, trafficAt: ago(3540) }
    assert.deepEqual(devicePresence({ ...left, onMap: notWired }, PRESENCE_DEFAULTS, now), {
      status: 'disconnected',
      via: 'wifi',
      lastSeenAt: iso(3600),
    })
    assert.deepEqual(
      devicePresence(
        { wifi: null, trafficAt: ago(2 * 3600), onMap: notWired },
        PRESENCE_DEFAULTS,
        now
      ),
      { status: 'disconnected', via: 'lan', lastSeenAt: iso(2 * 3600) }
    )
    assert.deepEqual(
      devicePresence({ wifi: null, trafficAt: ago(60), onMap: null }, PRESENCE_DEFAULTS, now),
      { status: 'connected', via: 'lan', lastSeenAt: iso(60) }
    )
    // An AP lists it right now: that is where it is, whatever the cable says.
    assert.deepEqual(
      devicePresence(
        {
          wifi: { connected: true, heardAt: ago(5) },
          trafficAt: ago(1),
          onMap: { wired: true, link: { up: false, at: ago(900) } },
        },
        PRESENCE_DEFAULTS,
        now
      ),
      { status: 'connected', via: 'wifi', lastSeenAt: iso(5) }
    )
  })

  test('both windows follow the thresholds passed in', ({ assert }) => {
    const thresholds = { ...PRESENCE_DEFAULTS, lanQuietMinutes: 5, wifiTrailingTrafficMinutes: 2 }
    // Quiet for 10 minutes: connected under the default 30, not under 5.
    assert.equal(
      devicePresence({ wifi: null, trafficAt: ago(600) }, PRESENCE_DEFAULTS, now).status,
      'connected'
    )
    assert.equal(
      devicePresence({ wifi: null, trafficAt: ago(600) }, thresholds, now).status,
      'disconnected'
    )
    // Traffic 5 minutes after it left Wi-Fi: that visit under the default 10,
    // back another way under 2.
    const left = { wifi: { connected: false, heardAt: ago(3600) }, trafficAt: ago(3600 - 300) }
    assert.equal(devicePresence(left, PRESENCE_DEFAULTS, now).via, 'wifi')
    assert.equal(devicePresence(left, thresholds, now).via, 'lan')
  })
})

test.group('presence thresholds', () => {
  test('an AP is silent after max(intervals × its interval, the floor)', ({ assert }) => {
    assert.equal(apStaleSeconds(PRESENCE_DEFAULTS, 5), 30)
    assert.equal(apStaleSeconds(PRESENCE_DEFAULTS, 15), 45)
    assert.equal(apStaleSeconds({ ...PRESENCE_DEFAULTS, apStaleIntervals: 4 }, 15), 60)
    assert.equal(apStaleSeconds({ ...PRESENCE_DEFAULTS, apStaleMinSeconds: 120 }, 15), 120)
  })

  test('stored values: missing or not whole numbers read as the default, others clamp', ({
    assert,
  }) => {
    assert.deepEqual(normalizePresenceSettings(null), PRESENCE_DEFAULTS)
    assert.deepEqual(normalizePresenceSettings('garbage'), PRESENCE_DEFAULTS)
    assert.deepEqual(
      normalizePresenceSettings({
        lanQuietMinutes: 45,
        wifiTrailingTrafficMinutes: 2.5,
        apStaleIntervals: '4',
        apStaleMinSeconds: 5,
        nowRateIntervals: 999,
      }),
      {
        lanQuietMinutes: 45,
        wifiTrailingTrafficMinutes: PRESENCE_DEFAULTS.wifiTrailingTrafficMinutes,
        apStaleIntervals: PRESENCE_DEFAULTS.apStaleIntervals,
        apStaleMinSeconds: PRESENCE_LIMITS.apStaleMinSeconds.min,
        nowRateIntervals: PRESENCE_LIMITS.nowRateIntervals.max,
      }
    )
  })

  test('the defaults lie inside the accepted ranges', ({ assert }) => {
    for (const [key, { min, max }] of Object.entries(PRESENCE_LIMITS)) {
      const value = PRESENCE_DEFAULTS[key as keyof typeof PRESENCE_DEFAULTS]
      assert.isAtLeast(value, min, key)
      assert.isAtMost(value, max, key)
    }
  })
})

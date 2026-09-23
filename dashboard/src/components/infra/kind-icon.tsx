import type { IconProps } from '@phosphor-icons/react'
import { deviceTypeMeta } from '@/lib/device-labels'
import { kindMeta } from '@/lib/infra'
import type { InfraNode, InfraNodeKind } from '@/types/api'

/** The Phosphor glyph for a node kind (§8.3). */
export function KindIcon({ kind, ...props }: IconProps & { kind: InfraNodeKind }) {
  const meta = kindMeta(kind)
  return <meta.Icon aria-hidden {...props} />
}

/** A box's glyph: its device's type when it is bound to a typed device (A4.2), else its kind's. */
export function NodeIcon({ node, ...props }: IconProps & { node: Pick<InfraNode, 'kind' | 'device'> }) {
  const type = deviceTypeMeta(node.device?.deviceType)
  if (type) return <type.Icon aria-hidden {...props} />
  return <KindIcon kind={node.kind} {...props} />
}

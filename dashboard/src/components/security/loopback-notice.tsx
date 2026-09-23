import { isLoopbackUrl } from '@/lib/transport-security'

type LoopbackNoticeProps = {
  /** The controller URL a command will carry. */
  url: string | null | undefined
  /** What has to reach it: "a router", "an AP". */
  device: string
  className?: string
}

/** Warns when a command would point a device at this browser's own machine. */
export function LoopbackNotice({ url, device, className }: LoopbackNoticeProps) {
  if (!url || !isLoopbackUrl(url)) return null
  return (
    <p className={`text-[11px] text-amber-600 dark:text-amber-400 ${className ?? ''}`}>
      This page is open on {new URL(url).hostname}, which {device} cannot reach. Replace it with
      this machine&apos;s LAN address or hostname.
    </p>
  )
}

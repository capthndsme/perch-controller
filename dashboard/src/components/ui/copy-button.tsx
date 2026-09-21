import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'

/**
 * `navigator.clipboard` exists only in secure contexts (https, localhost); a
 * dashboard reached as http://<lan-ip>:8080 falls back to a hidden textarea
 * and `execCommand('copy')`.
 */
async function copyText(value: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // Permission denied or document not focused: try the fallback.
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}

type CopyButtonProps = {
  value: string
  /** Visible button text. */
  label?: string
  /** Names what is copied for screen readers when several buttons read "Copy". */
  ariaLabel?: string
  className?: string
}

export function CopyButton({ value, label = 'Copy', ariaLabel, className }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  async function onCopy() {
    const ok = await copyText(value)
    setState(ok ? 'copied' : 'failed')
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 1500)
  }

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className={className}
      aria-label={ariaLabel}
      onClick={onCopy}
    >
      {state === 'copied' ? <Check className="size-3" /> : <Copy className="size-3" />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : label}
    </Button>
  )
}

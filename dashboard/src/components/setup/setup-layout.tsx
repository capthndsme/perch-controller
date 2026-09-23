import type { ReactNode } from 'react'
import { PlainHttpPageNote } from '@/components/security/plain-http'
import { useThemeEffect } from '@/hooks/use-theme'
import { controllerVersionLabel, useVersion } from '@/hooks/use-version'

type SetupLayoutProps = {
  children: ReactNode
}

export function SetupLayout({ children }: SetupLayoutProps) {
  useThemeEffect()
  const versionLabel = controllerVersionLabel(useVersion().data?.version)

  return (
    <div className="relative min-h-svh overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--color-primary)_0%,_transparent_45%)] opacity-[0.07]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,var(--color-muted)_120%)] opacity-30"
      />
      <div className="relative mx-auto flex min-h-svh w-full max-w-3xl flex-col justify-center px-4 py-10">
        <div className="mb-8 space-y-2 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            First-run setup
          </p>
          <h1 className="text-3xl font-medium tracking-tight">Welcome to Perch</h1>
          <p className="text-sm text-muted-foreground">
            Three quick steps to set up your Perch Network Controller.
          </p>
        </div>
        {children}
        <PlainHttpPageNote className="mt-4" />
        {versionLabel ? (
          <p className="mt-4 text-center text-[11px] text-muted-foreground">{versionLabel}</p>
        ) : null}
      </div>
    </div>
  )
}

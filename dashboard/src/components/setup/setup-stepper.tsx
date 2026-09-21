import { cn } from '@/lib/utils'
import type { SetupStep } from '@/types/setup'
import { Check } from '@phosphor-icons/react'

const STEPS: { id: SetupStep; label: string; description: string }[] = [
  { id: 'admin', label: 'Admin', description: 'Create your account' },
  { id: 'instance', label: 'Instance', description: 'Name this deployment' },
  { id: 'collector', label: 'Collectors', description: 'Optional: adopt or add' },
]

const STEP_ORDER: SetupStep[] = ['admin', 'instance', 'collector', 'complete']

type SetupStepperProps = {
  current: SetupStep
}

export function SetupStepper({ current }: SetupStepperProps) {
  const currentIndex = STEP_ORDER.indexOf(current)

  return (
    <ol className="grid gap-3 sm:grid-cols-3">
      {STEPS.map((step, index) => {
        const stepIndex = STEP_ORDER.indexOf(step.id)
        const isComplete = currentIndex > stepIndex
        const isCurrent = current === step.id

        return (
          <li
            key={step.id}
            className={cn(
              'flex items-start gap-3 rounded-lg border p-3 transition-colors',
              isCurrent && 'border-primary/40 bg-primary/5',
              isComplete && 'border-border/80 bg-muted/40',
              !isCurrent && !isComplete && 'border-border/60 opacity-70',
            )}
          >
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-md border text-xs font-medium',
                isComplete && 'border-primary bg-primary text-primary-foreground',
                isCurrent && !isComplete && 'border-primary text-primary',
                !isCurrent && !isComplete && 'border-border text-muted-foreground',
              )}
            >
              {isComplete ? <Check weight="bold" className="size-3.5" /> : index + 1}
            </span>
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">{step.label}</p>
              <p className="text-xs text-muted-foreground">{step.description}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

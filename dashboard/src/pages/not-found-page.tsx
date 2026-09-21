import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">
        The route you requested does not exist.
      </p>
      <Button asChild variant="outline">
        <Link to="/">Back home</Link>
      </Button>
    </div>
  )
}

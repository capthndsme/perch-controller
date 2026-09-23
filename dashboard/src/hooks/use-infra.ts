import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { wifiQueryKey } from '@/hooks/use-wifi'
import { apiFetch } from '@/lib/api'
import type {
  BindInfraNodePayload,
  CreateInfraLinkPayload,
  CreateInfraNodePayload,
  CreateInfraNodeResponse,
  InfraLayoutResponse,
  InfraLink,
  InfraNode,
  InfraPort,
  InfraPortInput,
  InfraPositionEntry,
  InfraStateResponse,
  UpdateInfraLinkPayload,
  UpdateInfraNodePayload,
  UpdateInfraPortPayload,
  WifiClientSummary,
} from '@/types/api'

/**
 * The infrastructure view (docs/infrastructure-view.md §7, §8.2): the layout
 * (nodes, ports, cables; operator structure, polled slowly) and the live state
 * (status, link LEDs; polled every 5 s). The page joins the state into the
 * layout by id, so a state poll never rebuilds the map.
 */
export const infraQueryKey = ['infra'] as const
export const infraLayoutQueryKey = [...infraQueryKey, 'layout'] as const
export const infraStateQueryKey = [...infraQueryKey, 'state'] as const

type PollOptions = {
  /** Stops polling while a drag or a connection gesture is in flight. */
  paused?: boolean
}

export function useInfraLayout(options: PollOptions = {}) {
  return useQuery({
    queryKey: infraLayoutQueryKey,
    queryFn: () => apiFetch<InfraLayoutResponse>('/api/v1/infra/layout'),
    refetchInterval: options.paused ? false : 30_000,
    refetchOnWindowFocus: true,
  })
}

export function useInfraState(options: PollOptions & { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: infraStateQueryKey,
    queryFn: () => apiFetch<InfraStateResponse>('/api/v1/infra/state'),
    refetchInterval: options.paused ? false : 5_000,
    enabled: options.enabled ?? true,
  })
}

/**
 * A4.4: the connected Wi-Fi clients the map's overlay draws, polled every 10 s
 * and only while the overlay is on (`enabled`), paused like the map's own polls
 * during a drag. Same request and cache entry as the WiFi page's client list.
 */
export function useInfraWifiClients(options: { enabled: boolean; paused?: boolean }) {
  return useQuery({
    queryKey: [...wifiQueryKey, 'clients', 'all', 'active'] as const,
    queryFn: () => apiFetch<WifiClientSummary[]>('/api/v1/wifi/clients?activeOnly=true'),
    refetchInterval: options.paused ? false : 10_000,
    enabled: options.enabled,
  })
}

function invalidateLayout(queryClient: QueryClient, withState = false) {
  void queryClient.invalidateQueries({ queryKey: infraLayoutQueryKey })
  if (withState) void queryClient.invalidateQueries({ queryKey: infraStateQueryKey })
}

/** Applies `update` to the cached layout, if one is loaded. */
function patchLayout(
  queryClient: QueryClient,
  update: (layout: InfraLayoutResponse) => InfraLayoutResponse,
) {
  queryClient.setQueryData<InfraLayoutResponse>(infraLayoutQueryKey, (current) =>
    current ? update(current) : current,
  )
}

/** The cached layout with these nodes moved, so a drop stays where it landed. */
function withPositions(layout: InfraLayoutResponse, entries: InfraPositionEntry[]): InfraLayoutResponse {
  const byId = new Map(entries.map((entry) => [entry.nodeId, entry]))
  return {
    ...layout,
    nodes: layout.nodes.map((node) => {
      const entry = byId.get(node.id)
      return entry
        ? { ...node, position: { x: entry.x, y: entry.y }, parentId: entry.parentId }
        : node
    }),
  }
}

export function useCreateInfraNode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateInfraNodePayload) =>
      apiFetch<CreateInfraNodeResponse>('/api/v1/infra/nodes', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: ({ node, link }) => {
      // The box, and the cable `linkTo` drew (A4.4), show up at once; the refetch brings the far port's row.
      patchLayout(queryClient, (layout) => {
        const nodes = layout.nodes.some((existing) => existing.id === node.id) ? layout.nodes : [...layout.nodes, node]
        const links =
          link && !layout.links.some((existing) => existing.id === link.id) ? [...layout.links, link] : layout.links
        return nodes === layout.nodes && links === layout.links ? layout : { ...layout, nodes, links }
      })
    },
    onSettled: () => invalidateLayout(queryClient, true),
  })
}

export function useUpdateInfraNode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: UpdateInfraNodePayload }) =>
      apiFetch<{ node: InfraNode }>(`/api/v1/infra/nodes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onMutate: async ({ id, payload }) => {
      // A moved node must not jump back while the request is in flight.
      if (payload.position !== undefined && payload.position !== null) {
        await queryClient.cancelQueries({ queryKey: infraLayoutQueryKey })
        const { x, y } = payload.position
        patchLayout(queryClient, (layout) => {
          const node = layout.nodes.find((candidate) => candidate.id === id)
          const parentId = payload.parentId !== undefined ? payload.parentId : (node?.parentId ?? null)
          return withPositions(layout, [{ nodeId: id, x, y, parentId }])
        })
      }
    },
    onSuccess: ({ node }) => {
      patchLayout(queryClient, (layout) => ({
        ...layout,
        nodes: layout.nodes.map((existing) => (existing.id === node.id ? node : existing)),
      }))
    },
    // A device bound or unbound changes the box's presence too, which only the state carries.
    onSettled: (_data, _error, { payload }) => invalidateLayout(queryClient, payload.deviceMac !== undefined),
  })
}

export function useDeleteInfraNode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiFetch<void>(`/api/v1/infra/nodes/${id}`, { method: 'DELETE' }),
    onSettled: () => invalidateLayout(queryClient, true),
  })
}

export function useBindInfraNode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: BindInfraNodePayload }) =>
      apiFetch<{ node: InfraNode; replacedNodeId: number | null }>(`/api/v1/infra/nodes/${id}/bind`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSettled: () => invalidateLayout(queryClient, true),
  })
}

export function useAddInfraPorts() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ nodeId, ports }: { nodeId: number; ports: InfraPortInput[] }) =>
      apiFetch<{ ports: InfraPort[] }>(`/api/v1/infra/nodes/${nodeId}/ports`, {
        method: 'POST',
        body: JSON.stringify({ ports }),
      }),
    onSettled: () => invalidateLayout(queryClient, true),
  })
}

export function useUpdateInfraPort() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: UpdateInfraPortPayload }) =>
      apiFetch<{ port: InfraPort }>(`/api/v1/infra/ports/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSettled: () => invalidateLayout(queryClient, true),
  })
}

export function useDeleteInfraPort() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiFetch<void>(`/api/v1/infra/ports/${id}`, { method: 'DELETE' }),
    onSettled: () => invalidateLayout(queryClient, true),
  })
}

export function useCreateInfraLink() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateInfraLinkPayload) =>
      apiFetch<{ link: InfraLink }>('/api/v1/infra/links', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: ({ link }) => {
      // Draw the new cable right away; the refetch below brings the port rows along.
      patchLayout(queryClient, (layout) =>
        layout.links.some((existing) => existing.id === link.id)
          ? layout
          : { ...layout, links: [...layout.links, link] },
      )
    },
    onSettled: () => invalidateLayout(queryClient, true),
  })
}

export function useUpdateInfraLink() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: UpdateInfraLinkPayload }) =>
      apiFetch<{ link: InfraLink }>(`/api/v1/infra/links/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: ({ link }) => {
      patchLayout(queryClient, (layout) => ({
        ...layout,
        links: layout.links.map((existing) => (existing.id === link.id ? link : existing)),
      }))
    },
    onSettled: () => invalidateLayout(queryClient, true),
  })
}

export function useDeleteInfraLink() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiFetch<void>(`/api/v1/infra/links/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: infraLayoutQueryKey })
      patchLayout(queryClient, (layout) => ({
        ...layout,
        links: layout.links.filter((link) => link.id !== id),
        nodes: layout.nodes.map((node) =>
          node.ports.some((port) => port.linkId === id)
            ? { ...node, ports: node.ports.map((port) => (port.linkId === id ? { ...port, linkId: null } : port)) }
            : node,
        ),
      }))
    },
    onSettled: () => invalidateLayout(queryClient, true),
  })
}

export function useSaveInfraPositions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (positions: InfraPositionEntry[]) =>
      apiFetch<{ updated: number }>('/api/v1/infra/positions', {
        method: 'PUT',
        body: JSON.stringify({ positions }),
      }),
    onMutate: async (positions) => {
      await queryClient.cancelQueries({ queryKey: infraLayoutQueryKey })
      patchLayout(queryClient, (layout) => withPositions(layout, positions))
    },
    onSettled: () => invalidateLayout(queryClient),
  })
}

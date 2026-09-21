import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { User } from '@/types/api'

export const usersQueryKey = ['settings', 'users'] as const

export function useUsers() {
  return useQuery({
    queryKey: usersQueryKey,
    queryFn: () => apiFetch<User[]>('/api/v1/settings/users'),
  })
}

export type CreateUserPayload = {
  fullName: string | null
  email: string
  password?: string
  passwordConfirmation?: string
  role: string
}

export function useCreateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateUserPayload) =>
      apiFetch<User>('/api/v1/settings/users', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: usersQueryKey })
    },
  })
}

export function useUpdateUserRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, role }: { id: number; role: string }) =>
      apiFetch<User>(`/api/v1/settings/users/${id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: usersQueryKey })
    },
  })
}

export function useDeleteUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<void>(`/api/v1/settings/users/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: usersQueryKey })
    },
  })
}

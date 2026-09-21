import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ApiError, apiFetch, fieldErrorsFromApi, setTokenReader } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import type { AuthResponse, User } from '@/types/api'

export const profileQueryKey = ['account', 'profile'] as const

setTokenReader(() => useAuthStore.getState().token)

export function useProfile() {
  const token = useAuthStore((state) => state.token)

  return useQuery({
    queryKey: profileQueryKey,
    queryFn: () => apiFetch<User>('/api/v1/account/profile'),
    enabled: Boolean(token),
    retry: (count, error) => {
      if (error instanceof ApiError && error.status === 401) return false
      return count < 1
    },
  })
}

export function useLogin() {
  const queryClient = useQueryClient()
  const setSession = useAuthStore((state) => state.setSession)

  return useMutation({
    mutationFn: (payload: { email: string; password: string }) =>
      apiFetch<AuthResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(payload),
        auth: false,
      }),
    onSuccess: (data) => {
      setSession(data.token, data.user)
      queryClient.setQueryData(profileQueryKey, data.user)
    },
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  const clearSession = useAuthStore((state) => state.clearSession)
  const navigate = useNavigate()

  return useMutation({
    mutationFn: () =>
      apiFetch<{ message: string }>('/api/v1/account/logout', {
        method: 'POST',
      }),
    onSettled: () => {
      clearSession()
      queryClient.removeQueries({ queryKey: profileQueryKey })
      queryClient.clear()
      navigate('/login')
    },
  })
}

export type ChangePasswordPayload = {
  currentPassword?: string
  password?: string
  passwordConfirmation?: string
}

export function useChangePassword() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: ChangePasswordPayload) =>
      apiFetch<{ message: string }>('/api/v1/account/password', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: profileQueryKey })
    },
  })
}

export { fieldErrorsFromApi }

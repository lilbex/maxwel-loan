import { ApiError, createApiClient } from '@loan-platform/api-client';

export const api = createApiClient({ baseUrl: '/api' });

export const errorMessage = (cause: unknown) =>
  cause instanceof ApiError ? cause.message : 'The server could not be reached. Check your connection and try again.';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { ApiError, createApiClient, type Me } from '@loan-platform/api-client';

/** For server components, which call the API directly and forward the signed-in user's cookie. */
export async function serverApi() {
  const jar = await cookies();
  return createApiClient({
    baseUrl: process.env.API_URL ?? 'http://localhost:4000',
    cookie: jar.toString(),
  });
}

/** Shared by the layout and page within one request. Sends signed-out visitors to sign-in. */
export const currentUser = cache(async (): Promise<Me> => {
  const api = await serverApi();
  try {
    return await api.me();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect('/login');
    throw error;
  }
});

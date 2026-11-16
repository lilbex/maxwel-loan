import { redirect } from 'next/navigation';
import { ApiError } from '@loan-platform/api-client';
import { currentUser } from '@/lib/api';

export async function reportUser() {
  const me = await currentUser();
  if (!me.permissions.includes('reports.read')) redirect('/');
  return me;
}

/** Turns a bad date range into a message on the page rather than an error screen. */
export async function loadReport<T>(load: () => Promise<T>): Promise<T | string> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) return error.message;
    throw error;
  }
}

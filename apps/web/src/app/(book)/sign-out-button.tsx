'use client';

import { useRouter } from 'next/navigation';
import { createApiClient } from '@loan-platform/api-client';

const api = createApiClient({ baseUrl: '/api' });

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="spine-signout"
      type="button"
      onClick={async () => {
        await api.logout().catch(() => undefined);
        router.replace('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createApiClient } from '@loan-platform/api-client';

const api = createApiClient({ baseUrl: '/api' });

export function ArchiveButton({ id, status }: { id: string; status: 'active' | 'archived' }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
    <button
      className="button button-quiet"
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        setError(null);
        try {
          await api.setLoanProductStatus(id, status === 'active' ? 'archived' : 'active');
          router.refresh();
        } catch {
          setError('The change was not saved. Try again.');
        } finally {
          setPending(false);
        }
      }}
    >
      {status === 'active' ? 'Archive' : 'Reactivate'}
    </button>
    {error && (
      <p className="form-error" role="alert">
        {error}
      </p>
    )}
    </>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/client-api';

export function ApplyPenaltiesButton() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="apply-penalties">
      <button
        className="button button-quiet"
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setMessage(null);
          try {
            const { chargesAdded, loansCharged } = await api.applyPenalties();
            setMessage(
              chargesAdded === 0
                ? 'Penalties are up to date.'
                : `Added ${chargesAdded} ${chargesAdded === 1 ? 'charge' : 'charges'} on ${loansCharged} ${loansCharged === 1 ? 'loan' : 'loans'}.`,
            );
            router.refresh();
          } catch (cause) {
            setMessage(errorMessage(cause));
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Applying' : 'Apply penalties now'}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}

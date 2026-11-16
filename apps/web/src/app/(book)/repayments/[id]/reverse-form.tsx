'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useRef, useState } from 'react';
import { ApiError } from '@loan-platform/api-client';
import { api, errorMessage } from '@/lib/client-api';

export function ReverseForm({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef<string | null>(null);

  if (!open) {
    return (
      <button className="text-button no-print correct-link" type="button" onClick={() => setOpen(true)}>
        Correct this payment
      </button>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    key.current ??= crypto.randomUUID();
    setPending(true);
    setError(null);
    try {
      const correction = await api.reversePayment(id, key.current, {
        reason: String(new FormData(event.currentTarget).get('reason')),
      });
      router.push(`/repayments/${correction.id}`);
      router.refresh();
    } catch (cause) {
      if (cause instanceof ApiError) key.current = null;
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  return (
    <section className="activity no-print">
      <h2 className="activity-title">Correct this payment</h2>
      <p className="field-note">
        This cancels the payment and restores what the borrower owes. The original record stays. To fix an amount, correct
        it here, then record the right one on the loan.
      </p>
      <form className="decision-form" onSubmit={onSubmit}>
        <label className="field">
          Reason
          <textarea name="reason" rows={2} required minLength={3} />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div>
          <button className="button button-danger" type="submit" disabled={pending}>
            {pending ? 'Correcting' : 'Cancel this payment'}
          </button>
        </div>
      </form>
    </section>
  );
}

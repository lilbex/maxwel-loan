'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '@/lib/client-api';

export function DisburseForm({ id, today }: { id: string; today: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const firstDueDate = String(form.get('firstDueDate'));
    const reference = String(form.get('reference')).trim();
    setPending(true);
    setError(null);
    try {
      await api.disburseLoan(id, {
        disbursementDate: String(form.get('disbursementDate')),
        method: form.get('method') === 'cash' ? 'cash' : 'bank',
        firstDueDate: firstDueDate || undefined,
        reference: reference || undefined,
      });
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  return (
    <section className="activity">
      <h2 className="activity-title">Record disbursement</h2>
      <p className="field-note">Record this after the money has been paid out. It creates the repayment schedule and posts to the ledger.</p>
      <form className="decision-form" onSubmit={onSubmit}>
        <div className="field-row">
          <label className="field">
            Date paid out
            <input name="disbursementDate" type="date" defaultValue={today} max={today} required />
          </label>
          <label className="field">
            Paid from
            <select name="method" defaultValue="bank">
              <option value="bank">Bank account</option>
              <option value="cash">Cash on hand</option>
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            First repayment date (optional)
            <input name="firstDueDate" type="date" />
          </label>
          <label className="field">
            Payment reference (optional)
            <input name="reference" />
          </label>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div>
          <button className="button" type="submit" disabled={pending}>
            {pending ? 'Recording' : 'Record disbursement'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function CancelButton({ id }: { id: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <button className="button button-quiet" type="button" onClick={() => setConfirming(true)}>
        Cancel loan
      </button>
    );
  }
  return (
    <>
      <button
        className="button button-danger"
        type="button"
        onClick={async () => {
          try {
            await api.cancelLoan(id);
            router.refresh();
          } catch (cause) {
            setError(errorMessage(cause));
          }
        }}
      >
        Confirm cancellation
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

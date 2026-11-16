'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useRef, useState } from 'react';
import { ApiError, formatNaira, nairaToKobo } from '@loan-platform/api-client';
import { api, errorMessage } from '@/lib/client-api';

export function OpeningCashForm() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    const amountKobo = nairaToKobo(String(form.get('amount')));
    if (!amountKobo || amountKobo === '0') {
      setError('Enter the amount in naira.');
      return;
    }
    key.current ??= crypto.randomUUID();
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      await api.recordOpeningCash(key.current, {
        account: form.get('account') === 'cash' ? 'cash' : 'bank',
        amountKobo,
      });
      key.current = null;
      setMessage(`Recorded ${formatNaira(amountKobo)}.`);
      target.reset();
      router.refresh();
    } catch (cause) {
      if (cause instanceof ApiError) key.current = null;
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="activity no-print">
      <h2 className="activity-title">Opening cash and bank</h2>
      <p className="field-note">Record once, using the balances on the day you start. Each entry adds to the balance.</p>
      <form className="decision-form" onSubmit={onSubmit}>
        <div className="field-row">
          <label className="field">
            Account
            <select name="account" defaultValue="bank">
              <option value="bank">Bank account</option>
              <option value="cash">Cash on hand</option>
            </select>
          </label>
          <label className="field">
            Balance (₦)
            <input name="amount" inputMode="decimal" required />
          </label>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        <div>
          <button className="button button-quiet" type="submit" disabled={pending}>
            {pending ? 'Recording' : 'Record opening balance'}
          </button>
        </div>
      </form>
    </section>
  );
}

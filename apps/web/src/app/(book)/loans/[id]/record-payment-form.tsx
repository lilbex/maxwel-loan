'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useRef, useState } from 'react';
import { ApiError, formatNaira, nairaToKobo } from '@loan-platform/api-client';
import { api, errorMessage } from '@/lib/client-api';

export function RecordPaymentForm({
  loanId,
  today,
  disbursementDate,
  nextDueKobo,
  outstandingKobo,
}: {
  loanId: string;
  today: string;
  disbursementDate: string;
  nextDueKobo: string | null;
  outstandingKobo: string;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Kept when the connection fails, so pressing the button again cannot record a second payment.
  const key = useRef<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountKobo = nairaToKobo(amount);
    if (!amountKobo || amountKobo === '0') {
      setError('Enter the amount received in naira.');
      return;
    }
    if (BigInt(amountKobo) > BigInt(outstandingKobo) && error !== OVERPAYMENT) {
      setError(OVERPAYMENT);
      return;
    }
    const form = new FormData(event.currentTarget);
    const reference = String(form.get('reference')).trim();
    const note = String(form.get('note')).trim();
    key.current ??= crypto.randomUUID();
    setPending(true);
    setError(null);
    try {
      const payment = await api.recordPayment(loanId, key.current, {
        amountKobo,
        paymentDate: String(form.get('paymentDate')),
        method: form.get('method') === 'cash' ? 'cash' : 'bank',
        reference: reference || undefined,
        note: note || undefined,
      });
      key.current = null;
      router.push(`/repayments/${payment.id}`);
      router.refresh();
    } catch (cause) {
      if (cause instanceof ApiError) key.current = null;
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  return (
    <section className="activity no-print">
      <h2 className="activity-title">Record repayment</h2>
      <form className="decision-form" onSubmit={onSubmit}>
        <div className="field-row">
          <label className="field">
            Amount received (₦)
            <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" required />
          </label>
          <label className="field">
            Date received
            <input name="paymentDate" type="date" defaultValue={today} min={disbursementDate} max={today} required />
          </label>
        </div>
        {nextDueKobo && <p className="field-note">Next repayment left to pay: {formatNaira(nextDueKobo)}</p>}
        <div className="field-row">
          <label className="field">
            Received into
            <select name="method" defaultValue="bank">
              <option value="bank">Bank account</option>
              <option value="cash">Cash on hand</option>
            </select>
          </label>
          <label className="field">
            Payment reference (optional)
            <input name="reference" />
          </label>
        </div>
        <label className="field">
          Note (optional)
          <input name="note" />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div>
          <button className="button" type="submit" disabled={pending}>
            {pending ? 'Recording' : error === OVERPAYMENT ? 'Record overpayment' : 'Record repayment'}
          </button>
        </div>
      </form>
    </section>
  );
}

const OVERPAYMENT = 'This is more than the borrower owes. Check the amount. To record it anyway, press the button again.';

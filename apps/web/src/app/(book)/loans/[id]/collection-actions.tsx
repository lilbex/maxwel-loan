'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { type CollectionOutcome, formatNaira, nairaToKobo } from '@loan-platform/api-client';
import { api, errorMessage } from '@/lib/client-api';

export function WaiveForm({ loanId, penaltyKobo }: { loanId: string; penaltyKobo: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!open) {
    return (
      <button className="text-button no-print correct-link" type="button" onClick={() => setOpen(true)}>
        Waive penalties
      </button>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amountKobo = nairaToKobo(String(form.get('amount')));
    if (!amountKobo || amountKobo === '0') {
      setError('Enter the amount to waive in naira.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.waivePenalty(loanId, { amountKobo, reason: String(form.get('reason')) });
      setOpen(false);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="activity no-print">
      <h2 className="activity-title">Waive penalties</h2>
      <p className="field-note">Penalties owed: {formatNaira(penaltyKobo)}. The oldest are cleared first.</p>
      <form className="decision-form" onSubmit={onSubmit}>
        <label className="field">
          Amount to waive (₦)
          <input name="amount" inputMode="decimal" required />
        </label>
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
          <button className="button" type="submit" disabled={pending}>
            {pending ? 'Waiving' : 'Waive penalties'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function NoteForm({ loanId, today }: { loanId: string; today: string }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<CollectionOutcome>('called');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    const promisedAmount = String(form.get('promisedAmount') ?? '').trim();
    const promisedAmountKobo = promisedAmount ? nairaToKobo(promisedAmount) : undefined;
    if (promisedAmountKobo === null) {
      setError('Enter the promised amount in naira.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.addCollectionNote(loanId, {
        outcome,
        note: String(form.get('note')),
        promisedDate: outcome === 'promised' ? String(form.get('promisedDate')) : undefined,
        promisedAmountKobo: outcome === 'promised' ? promisedAmountKobo : undefined,
      });
      target.reset();
      setOutcome('called');
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="decision-form no-print" onSubmit={onSubmit}>
      <label className="field">
        Outcome
        <select value={outcome} onChange={(event) => setOutcome(event.target.value as CollectionOutcome)}>
          <option value="called">Spoke to borrower</option>
          <option value="no_answer">No answer</option>
          <option value="promised">Promise to pay</option>
          <option value="visited">Visited</option>
          <option value="other">Other</option>
        </select>
      </label>
      {outcome === 'promised' && (
        <div className="field-row">
          <label className="field">
            Promised date
            <input name="promisedDate" type="date" min={today} required />
          </label>
          <label className="field">
            Promised amount (₦, optional)
            <input name="promisedAmount" inputMode="decimal" />
          </label>
        </div>
      )}
      <label className="field">
        Note
        <textarea name="note" rows={2} required minLength={3} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button className="button button-quiet" type="submit" disabled={pending}>
          {pending ? 'Saving' : 'Add note'}
        </button>
      </div>
    </form>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/client-api';

export function SubmitButton({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <>
      <button
        className="button"
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            await api.submitApplication(id);
            router.refresh();
          } catch (cause) {
            setError(errorMessage(cause));
          } finally {
            setPending(false);
          }
        }}
      >
        Submit for decision
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function DecisionForm({ id, existing }: { id: string; existing: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function decide(decision: 'approved' | 'rejected' | 'returned') {
    if (decision !== 'approved' && note.trim().length < 3) {
      setError('Give a reason when rejecting or returning an application.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.decideApplication(id, { decision, note: note.trim() || undefined });
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="activity">
      <h2 className="activity-title">{existing ? 'Your check' : 'Your decision'}</h2>
      <div className="decision-form">
        <label className="field">
          Note (needed to reject or return)
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="page-actions">
          <button className="button" type="button" disabled={pending} onClick={() => decide('approved')}>
            {existing ? 'Confirm and move loan' : 'Approve'}
          </button>
          <button className="button button-quiet" type="button" disabled={pending} onClick={() => decide('returned')}>
            Return for changes
          </button>
          <button className="button button-danger" type="button" disabled={pending} onClick={() => decide('rejected')}>
            Reject
          </button>
        </div>
      </div>
    </section>
  );
}

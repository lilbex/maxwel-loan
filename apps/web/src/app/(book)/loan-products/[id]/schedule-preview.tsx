'use client';

import { type FormEvent, useState } from 'react';
import {
  ApiError,
  createApiClient,
  formatNaira,
  type LoanProduct,
  type LoanSchedule,
  nairaToKobo,
} from '@loan-platform/api-client';
import { ScheduleTable } from '../../schedule-table';

const api = createApiClient({ baseUrl: '/api' });

export function SchedulePreview({
  product,
  today,
  termUnit,
}: {
  product: LoanProduct;
  today: string;
  termUnit: string;
}) {
  const [amount, setAmount] = useState('');
  const [term, setTerm] = useState(String(product.minTerm));
  const [date, setDate] = useState(today);
  const [schedule, setSchedule] = useState<LoanSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const principalKobo = nairaToKobo(amount);
    if (!principalKobo || principalKobo === '0') {
      setError('Enter the loan amount in naira.');
      return;
    }
    setError(null);
    try {
      setSchedule(
        await api.previewSchedule(product.id, { principalKobo, termCount: Number(term), disbursementDate: date }),
      );
    } catch (cause) {
      setSchedule(null);
      setError(cause instanceof ApiError ? cause.message : 'The server could not be reached. Try again.');
    }
  }

  return (
    <section className="preview">
      <h2 className="activity-title">Repayment schedule</h2>
      <form className="preview-form" onSubmit={onSubmit}>
        <label className="field">
          Loan amount (₦)
          <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" required />
        </label>
        <label className="field">
          Term ({termUnit})
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            type="number"
            min={product.minTerm}
            max={product.maxTerm}
            required
          />
        </label>
        <label className="field">
          Disbursement date
          <input value={date} onChange={(event) => setDate(event.target.value)} type="date" required />
        </label>
        <button className="button" type="submit">
          Work out schedule
        </button>
      </form>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {schedule && (
        <>
          <dl className="summary">
            <div>
              <dt>Borrower receives</dt>
              <dd>{formatNaira(schedule.netDisbursedKobo)}</dd>
            </div>
            <div>
              <dt>Total interest</dt>
              <dd>{formatNaira(schedule.totalInterestKobo)}</dd>
            </div>
            <div>
              <dt>Fees</dt>
              <dd>
                {formatNaira((BigInt(schedule.upfrontFeesKobo) + BigInt(schedule.totalScheduledFeesKobo)).toString())}
              </dd>
            </div>
            <div>
              <dt>Borrower repays</dt>
              <dd>{formatNaira(schedule.totalRepayableKobo)}</dd>
            </div>
          </dl>
          <ScheduleTable installments={schedule.installments} />
        </>
      )}
    </section>
  );
}

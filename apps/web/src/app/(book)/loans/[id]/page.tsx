import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, formatNaira, type InstallmentStatus } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';
import { LOAN_STATUS_LABELS, METHOD_LABELS } from '@/lib/product-labels';
import { CancelButton, DisburseForm } from './loan-actions';
import { NoteForm, WaiveForm } from './collection-actions';
import { RecordPaymentForm } from './record-payment-form';

const paidFrom = { bank: 'Bank account', cash: 'Cash on hand' };
const OUTCOME_LABELS = {
  called: 'Spoke to borrower',
  no_answer: 'No answer',
  promised: 'Promise to pay',
  visited: 'Visited',
  other: 'Other',
};
const INSTALLMENT_LABELS: Record<InstallmentStatus, string> = {
  paid: 'Paid',
  part_paid: 'Part paid',
  overdue: 'Overdue',
  due: 'Not yet due',
};

export default async function LoanPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, api, me] = await Promise.all([params, serverApi(), currentUser()]);
  const loan = await api.loan(id).catch((error: unknown) => {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: me.tenant.timezone }).format(new Date());
  const longDate = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'UTC' });
  const waiting = loan.status === 'approved';
  const { terms, outstanding } = loan;
  const dueDate = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'UTC' });
  const stamp = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: me.tenant.timezone });
  const paidOut = loan.status === 'active' || loan.status === 'closed';
  const next = loan.installments.find((row) => row.status !== 'paid');

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{loan.reference}</h1>
        {waiting && me.permissions.includes('loans.approve') && <CancelButton id={id} />}
        {paidOut && (
          <Link className="button button-quiet" href={`/loans/${id}/statement`}>
            Statement
          </Link>
        )}
      </div>
      <p className="page-status">{LOAN_STATUS_LABELS[loan.status]}</p>

      <dl className="terms">
        <dt>Borrower</dt>
        <dd>
          <Link href={`/borrowers/${loan.borrowerId}`}>{loan.borrowerName}</Link>
        </dd>
        <dt>Amount</dt>
        <dd>{formatNaira(loan.principalKobo)}</dd>
        <dt>Product</dt>
        <dd>{terms.name}</dd>
        <dt>Interest</dt>
        <dd>
          {terms.ratePercent}% per {terms.ratePeriod}, {METHOD_LABELS[terms.interestMethod].toLowerCase()}
        </dd>
        <dt>Repayments</dt>
        <dd>{loan.termCount}</dd>
        <dt>Application</dt>
        <dd>
          <Link href={`/applications/${loan.applicationId}`}>View application</Link>
        </dd>
        <dt>Approved by</dt>
        <dd>{loan.approvedByName}</dd>
        {loan.disbursementDate && (
          <>
            <dt>Paid out</dt>
            <dd>
              {longDate.format(new Date(loan.disbursementDate))}
              {loan.origin === 'existing'
                ? ', moved from paper records'
                : `, ${paidFrom[loan.disbursementMethod ?? 'bank'].toLowerCase()}`}
              {loan.disbursementReference ? `, reference ${loan.disbursementReference}` : ''}
            </dd>
          </>
        )}
      </dl>

      {waiting && me.permissions.includes('loans.disburse') && <DisburseForm id={id} today={today} />}

      {paidOut && (
        <>
          <dl className="summary">
            <div>
              <dt>Still owed</dt>
              <dd>{formatNaira(outstanding.totalKobo)}</dd>
            </div>
            <div>
              <dt>Overdue</dt>
              <dd className={outstanding.overdueKobo === '0' ? undefined : 'amount-overdue'}>
                {formatNaira(outstanding.overdueKobo)}
              </dd>
            </div>
            <div>
              <dt>Principal owed</dt>
              <dd>{formatNaira(outstanding.principalKobo)}</dd>
            </div>
            <div>
              <dt>Interest owed</dt>
              <dd>{formatNaira(outstanding.interestKobo)}</dd>
            </div>
            <div>
              <dt>Penalties owed</dt>
              <dd>{formatNaira(outstanding.penaltyKobo)}</dd>
            </div>
            <div>
              <dt>Paid so far</dt>
              <dd>{formatNaira(outstanding.paidKobo)}</dd>
            </div>
          </dl>
          {outstanding.overpaymentKobo !== '0' && (
            <p className="page-status">
              The borrower has overpaid by {formatNaira(outstanding.overpaymentKobo)}. This is held in Borrower
              overpayments until it is refunded.
            </p>
          )}
        </>
      )}

      {loan.status === 'active' && me.permissions.includes('payments.record') && (
        <RecordPaymentForm
          loanId={id}
          today={today}
          disbursementDate={loan.disbursementDate!}
          outstandingKobo={outstanding.totalKobo}
          nextDueKobo={next ? (BigInt(next.totalKobo) - BigInt(next.paidKobo)).toString() : null}
        />
      )}

      {loan.status === 'active' && outstanding.penaltyKobo !== '0' && me.permissions.includes('penalties.manage') && (
        <WaiveForm loanId={id} penaltyKobo={outstanding.penaltyKobo} />
      )}

      {loan.installments.length > 0 && (
        <section className="preview">
          <h2 className="activity-title">Repayment schedule</h2>
          <div className="sheet-scroll">
            <table className="sheet">
              <thead>
                <tr>
                  <th scope="col">Due</th>
                  <th className="amount" scope="col">Repayment</th>
                  <th className="amount" scope="col">Principal</th>
                  <th className="amount" scope="col">Interest</th>
                  <th className="amount" scope="col">Fees</th>
                  <th className="amount" scope="col">Paid</th>
                  <th className="amount" scope="col">Penalty owed</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {loan.installments.map((row) => (
                  <tr key={row.number}>
                    <td className="nowrap">{dueDate.format(new Date(row.dueDate))}</td>
                    <td className="amount">{formatNaira(row.totalKobo)}</td>
                    <td className="amount">{formatNaira(row.principalKobo)}</td>
                    <td className="amount">{formatNaira(row.interestKobo)}</td>
                    <td className="amount">{row.feeKobo === '0' ? '' : formatNaira(row.feeKobo)}</td>
                    <td className="amount">{row.paidKobo === '0' ? '' : formatNaira(row.paidKobo)}</td>
                    <td className="amount">{row.penaltyOwedKobo === '0' ? '' : formatNaira(row.penaltyOwedKobo)}</td>
                    <td className={row.status === 'overdue' ? 'nowrap amount-overdue' : 'nowrap'}>
                      {INSTALLMENT_LABELS[row.status]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {loan.payments.length > 0 && (
        <section className="activity">
          <h2 className="activity-title">Repayments</h2>
          <ul className="activity-list">
            {loan.payments.map((payment) => (
              <li key={payment.id}>
                <Link href={`/repayments/${payment.id}`}>
                  {payment.reference}, {formatNaira(payment.amountKobo)}
                </Link>
                <span>
                  {payment.isOpening
                    ? 'Paid before the move, '
                    : payment.reversesPaymentId
                      ? 'Correction, '
                      : payment.reversedByPaymentId
                        ? 'Corrected, '
                        : ''}
                  {dueDate.format(new Date(payment.paymentDate))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {paidOut && (loan.notes.length > 0 || me.permissions.includes('collections.manage')) && (
        <section className="activity">
          <h2 className="activity-title">Collection notes</h2>
          {me.permissions.includes('collections.manage') && <NoteForm loanId={id} today={today} />}
          {loan.notes.length > 0 && (
            <ul className="activity-list">
              {loan.notes.map((note) => (
                <li key={note.id}>
                  <span>
                    {OUTCOME_LABELS[note.outcome]}: {note.note}
                    {note.promisedDate ? `. Promised ${dueDate.format(new Date(note.promisedDate))}` : ''}
                    {note.promisedAmountKobo ? `, ${formatNaira(note.promisedAmountKobo)}` : ''}
                  </span>
                  <span className="nowrap">
                    {note.recordedByName}, {stamp.format(new Date(note.createdAt))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

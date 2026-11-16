import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, formatNaira } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';
import { PrintButton } from '../../print-button';
import { ReverseForm } from './reverse-form';

const METHOD = { bank: 'Bank account', cash: 'Cash' };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, api, me] = await Promise.all([params, serverApi(), currentUser()]);
  const payment = await api.payment(id).catch((error: unknown) => {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  const date = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'UTC' });
  const correction = payment.reversesPaymentId !== null;
  const { allocation } = payment;
  const shares = [
    ['Principal', allocation.principalKobo],
    ['Interest', allocation.interestKobo],
    ['Fees', allocation.feeKobo],
    ['Penalties', allocation.penaltyKobo],
    ['Overpayment', allocation.overpaymentKobo],
  ].filter(([, amount]) => amount !== '0');
  const balance = BigInt(payment.balanceAfterKobo);
  const canCorrect =
    !correction &&
    !payment.isOpening &&
    !payment.reversedByPaymentId &&
    me.permissions.includes('payments.reverse') &&
    payment.recordedByUserId !== me.user.id;

  return (
    <>
      <div className="page-head no-print">
        <Link href={`/loans/${payment.loanId}`}>Back to loan {payment.loanReference}</Link>
        <PrintButton label="Print receipt" />
      </div>

      <article className="receipt">
        <p className="receipt-lender">{me.tenant.name}</p>
        <h1 className="receipt-title">
          {correction ? 'Payment correction' : payment.isOpening ? 'Repaid before the move' : 'Payment receipt'}
        </h1>
        <p className="receipt-number">{payment.reference}</p>
        <p className="receipt-amount">{formatNaira(payment.amountKobo)}</p>

        {payment.reversedByPaymentId && (
          <p className="receipt-void">
            This payment was cancelled. <Link href={`/repayments/${payment.reversedByPaymentId}`}>View the correction</Link>
          </p>
        )}
        {correction && (
          <p className="receipt-void">
            Cancels an earlier payment. <Link href={`/repayments/${payment.reversesPaymentId}`}>View the original</Link>
          </p>
        )}

        <dl className="terms">
          <dt>Received from</dt>
          <dd>{payment.borrowerName}</dd>
          <dt>Loan</dt>
          <dd>{payment.loanReference}</dd>
          <dt>Date</dt>
          <dd>{date.format(new Date(payment.paymentDate))}</dd>
          {!payment.isOpening && (
            <>
              <dt>Paid by</dt>
              <dd>{METHOD[payment.method]}</dd>
            </>
          )}
          {payment.externalReference && (
            <>
              <dt>Reference</dt>
              <dd>{payment.externalReference}</dd>
            </>
          )}
          {shares.map(([label, amount]) => (
            <div className="terms-row" key={label}>
              <dt>{label}</dt>
              <dd>{formatNaira(amount!)}</dd>
            </div>
          ))}
          <dt>{balance < 0n ? 'Overpaid by' : 'Balance after this'}</dt>
          <dd>{formatNaira((balance < 0n ? -balance : balance).toString())}</dd>
          {payment.note && (
            <>
              <dt>Note</dt>
              <dd>{payment.note}</dd>
            </>
          )}
          <dt>Recorded by</dt>
          <dd>{payment.recordedByName}</dd>
        </dl>
      </article>

      {canCorrect && <ReverseForm id={id} />}
    </>
  );
}

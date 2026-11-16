import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatNaira } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';

const date = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'UTC' });

export default async function RepaymentsPage() {
  const [api, me] = await Promise.all([serverApi(), currentUser()]);
  if (!me.permissions.includes('loans.read')) redirect('/');
  const payments = await api.payments();

  return (
    <>
      <h1 className="page-title">Repayments</h1>
      {payments.length === 0 ? (
        <p className="page-status">No repayments yet. Open an active loan to record one.</p>
      ) : (
        <div className="sheet-scroll">
          <table className="sheet">
            <thead>
              <tr>
                <th scope="col">Receipt</th>
                <th scope="col">Date</th>
                <th scope="col">Borrower</th>
                <th scope="col">Loan</th>
                <th scope="col">Note</th>
                <th className="amount" scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td className="nowrap">
                    <Link href={`/repayments/${payment.id}`}>{payment.reference}</Link>
                  </td>
                  <td className="nowrap">{date.format(new Date(payment.paymentDate))}</td>
                  <td>{payment.borrowerName}</td>
                  <td className="nowrap">
                    <Link href={`/loans/${payment.loanId}`}>{payment.loanReference}</Link>
                  </td>
                  <td>
                    {payment.isOpening
                      ? 'Paid before the move'
                      : payment.reversesPaymentId
                        ? 'Correction'
                        : payment.reversedByPaymentId
                          ? 'Corrected'
                          : ''}
                  </td>
                  <td className="amount">{formatNaira(payment.amountKobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatNaira } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';
import { LOAN_STATUS_LABELS } from '@/lib/product-labels';

export default async function LoansPage() {
  const [api, me] = await Promise.all([serverApi(), currentUser()]);
  if (!me.permissions.includes('loans.read')) redirect('/');
  const loans = await api.loans();

  return (
    <>
      <h1 className="page-title">Loans</h1>
      {loans.length === 0 ? (
        <p className="page-status">No loans yet. A loan appears here once an application is approved.</p>
      ) : (
        <div className="sheet-scroll">
          <table className="sheet">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Borrower</th>
                <th scope="col">Product</th>
                <th scope="col">Status</th>
                <th className="amount" scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((loan) => (
                <tr key={loan.id}>
                  <td className="nowrap">
                    <Link href={`/loans/${loan.id}`}>{loan.reference}</Link>
                  </td>
                  <td>{loan.borrowerName}</td>
                  <td>{loan.productName}</td>
                  <td>{LOAN_STATUS_LABELS[loan.status]}</td>
                  <td className="amount">{formatNaira(loan.principalKobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

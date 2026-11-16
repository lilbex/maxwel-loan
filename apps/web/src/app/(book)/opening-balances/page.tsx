import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatNaira } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';
import { PrintButton } from '../print-button';
import { OpeningCashForm } from './opening-cash-form';

export default async function OpeningBalancesPage() {
  const [api, me] = await Promise.all([serverApi(), currentUser()]);
  if (!me.permissions.includes('loans.read')) redirect('/');
  const summary = await api.openingSummary();
  const date = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'UTC' });

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Moving from paper</h1>
        <div className="page-actions no-print">
          <PrintButton label="Print sign-off" />
          {me.permissions.includes('loans.apply') && (
            <Link className="button" href="/opening-balances/new">
              Add existing loan
            </Link>
          )}
        </div>
      </div>
      <p className="page-status">
        {me.tenant.name}, as of {date.format(new Date(summary.today))}. Compare these totals with a full count of the paper
        records before you stop using them.
      </p>

      <dl className="summary">
        <div>
          <dt>Loans moved</dt>
          <dd>{summary.loansMoved}</dd>
        </div>
        <div>
          <dt>Owed when moved</dt>
          <dd>{formatNaira(summary.totalOwedKobo)}</dd>
        </div>
        <div>
          <dt>Principal when moved</dt>
          <dd>{formatNaira(summary.totalPrincipalKobo)}</dd>
        </div>
        <div>
          <dt>Still to finish</dt>
          <dd>
            <Link href="/applications?status=submitted">{summary.waitingForCheck} to check</Link>,{' '}
            <Link href="/applications?status=draft">{summary.drafts} drafts</Link>
          </dd>
        </div>
      </dl>

      {summary.rows.length === 0 ? (
        <p className="page-status">No loans moved yet. Add each active loan from the paper records.</p>
      ) : (
        <div className="sheet-scroll statement-table">
          <table className="sheet">
            <thead>
              <tr>
                <th scope="col">Loan</th>
                <th scope="col">Borrower</th>
                <th className="amount" scope="col">Original amount</th>
                <th className="amount" scope="col">Paid before</th>
                <th className="amount" scope="col">Owed when moved</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((row) => (
                <tr key={row.loanId}>
                  <td className="nowrap">
                    <Link href={`/loans/${row.loanId}`}>{row.loanReference}</Link>
                  </td>
                  <td>{row.borrowerName}</td>
                  <td className="amount">{formatNaira(row.principalKobo)}</td>
                  <td className="amount">{row.paidBeforeKobo === '0' ? '' : formatNaira(row.paidBeforeKobo)}</td>
                  <td className="amount">{formatNaira(row.owedAtMoveKobo)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>Total owed when moved</td>
                <td className="amount">{formatNaira(summary.totalOwedKobo)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {me.permissions.includes('ledger.post') && <OpeningCashForm />}

      <div className="signoff">
        <p>Checked against paper records by: ______________________</p>
        <p>Owner signature and date: ______________________</p>
      </div>
    </>
  );
}

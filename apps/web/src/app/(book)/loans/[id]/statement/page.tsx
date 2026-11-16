import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ApiError, formatNaira } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';
import { PrintButton } from '../../../print-button';

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, api, me] = await Promise.all([params, serverApi(), currentUser()]);
  const statement = await api.statement(id).catch((error: unknown) => {
    if (error instanceof ApiError) {
      if (error.status === 404 || error.status === 400) notFound();
      if (error.status === 409) redirect(`/loans/${id}`);
    }
    throw error;
  });
  const date = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'UTC' });
  const longDate = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'UTC' });
  const closing = BigInt(statement.closingBalanceKobo);

  const signed = (kobo: string) =>
    kobo.startsWith('-') ? `${formatNaira(kobo.slice(1))} credit` : formatNaira(kobo);

  return (
    <>
      <div className="page-head no-print">
        <Link href={`/loans/${id}`}>Back to loan {statement.loanReference}</Link>
        <PrintButton label="Print statement" />
      </div>

      <p className="receipt-lender">{me.tenant.name}</p>
      <h1 className="page-title">Loan statement</h1>
      <dl className="terms">
        <dt>Borrower</dt>
        <dd>
          {statement.borrowerName} ({statement.borrowerReference})
        </dd>
        <dt>Loan</dt>
        <dd>
          {statement.loanReference}, {formatNaira(statement.principalKobo)}
        </dd>
        <dt>Statement date</dt>
        <dd>{longDate.format(new Date(statement.generatedOn))}</dd>
      </dl>

      <div className="sheet-scroll statement-table">
        <table className="sheet">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Details</th>
              <th scope="col">Reference</th>
              <th className="amount" scope="col">Owed</th>
              <th className="amount" scope="col">Paid</th>
              <th className="amount" scope="col">Balance</th>
            </tr>
          </thead>
          <tbody>
            {statement.lines.map((line, index) => (
              <tr key={index}>
                <td className="nowrap">{date.format(new Date(line.date))}</td>
                <td>{line.description}</td>
                <td className="nowrap">{line.reference}</td>
                <td className="amount">{line.chargedKobo === '0' ? '' : formatNaira(line.chargedKobo)}</td>
                <td className="amount">{line.paidKobo === '0' ? '' : formatNaira(line.paidKobo)}</td>
                <td className="amount">{signed(line.balanceKobo)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>{closing < 0n ? 'Overpaid by' : 'Balance owed'}</td>
              <td className="amount">{formatNaira((closing < 0n ? -closing : closing).toString())}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

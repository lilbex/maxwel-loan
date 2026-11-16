import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatNaira } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';
import { ApplyPenaltiesButton } from './apply-button';

const VIEWS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'upcoming', label: 'Due in 7 days' },
  { key: 'all', label: 'All active loans' },
];

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const [{ view = 'overdue' }, api, me] = await Promise.all([searchParams, serverApi(), currentUser()]);
  if (!me.permissions.includes('loans.read')) redirect('/');
  const report = await api.collections();
  const date = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'UTC' });

  const weekOut = new Date(Date.parse(`${report.today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const rows = report.rows.filter((row) => {
    if (view === 'overdue') return row.daysOverdue > 0;
    if (view === 'today') return row.dueTodayKobo !== '0';
    if (view === 'upcoming') return row.nextDueDate !== null && row.nextDueDate > report.today && row.nextDueDate <= weekOut;
    return true;
  });

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Collections</h1>
        {me.permissions.includes('penalties.manage') && <ApplyPenaltiesButton />}
      </div>

      <dl className="summary">
        <div>
          <dt>Due today</dt>
          <dd>{formatNaira(report.dueTodayKobo)}</dd>
        </div>
        <div>
          <dt>Overdue</dt>
          <dd className={report.overdueKobo === '0' ? undefined : 'amount-overdue'}>{formatNaira(report.overdueKobo)}</dd>
        </div>
        <div>
          <dt>Principal out</dt>
          <dd>{formatNaira(report.outstandingPrincipalKobo)}</dd>
        </div>
        <div>
          <dt>Over 30 days late</dt>
          <dd>{report.par30Percent}% of principal</dd>
        </div>
      </dl>

      <dl className="ageing">
        {report.ageing.map((bucket) => (
          <div key={bucket.label}>
            <dt>{bucket.label} late</dt>
            <dd>
              {formatNaira(bucket.principalKobo)}, {bucket.loans} {bucket.loans === 1 ? 'loan' : 'loans'}
            </dd>
          </div>
        ))}
      </dl>

      <nav className="tabs" aria-label="Choose a list">
        {VIEWS.map(({ key, label }) => (
          <Link key={key} href={`/collections?view=${key}`} aria-current={view === key ? 'page' : undefined}>
            {label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="page-status">{report.activeLoans === 0 ? 'No active loans yet.' : 'Nothing on this list.'}</p>
      ) : (
        <div className="sheet-scroll">
          <table className="sheet">
            <thead>
              <tr>
                <th scope="col">Borrower</th>
                <th scope="col">Phone</th>
                <th scope="col">Loan</th>
                <th className="amount" scope="col">Days late</th>
                <th className="amount" scope="col">Overdue</th>
                <th className="amount" scope="col">Due today</th>
                <th scope="col">Next due</th>
                <th scope="col">Latest note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.loanId}>
                  <td>
                    <Link href={`/borrowers/${row.borrowerId}`}>{row.borrowerName}</Link>
                  </td>
                  <td className="nowrap">
                    <a href={`tel:${row.borrowerPhone.replace(/[^+\d]/g, '')}`}>{row.borrowerPhone}</a>
                  </td>
                  <td className="nowrap">
                    <Link href={`/loans/${row.loanId}`}>{row.loanReference}</Link>
                  </td>
                  <td className="amount">{row.daysOverdue || ''}</td>
                  <td className="amount">{row.overdueKobo === '0' ? '' : formatNaira(row.overdueKobo)}</td>
                  <td className="amount">{row.dueTodayKobo === '0' ? '' : formatNaira(row.dueTodayKobo)}</td>
                  <td className="nowrap">{row.nextDueDate ? date.format(new Date(row.nextDueDate)) : ''}</td>
                  <td>
                    {row.lastNote}
                    {row.promisedDate ? ` (promised ${date.format(new Date(row.promisedDate))})` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

import { formatNaira, type AuditEvent, type TrialBalance } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';

const ACTIVITY_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.login_failed': 'Failed sign-in attempt',
  'ledger.entry_posted': 'Posted a journal entry',
  'ledger.entry_reversed': 'Reversed a journal entry',
  'ledger.account_created': 'Added a ledger account',
  'user.created': 'Added a staff account',
  'tenant.provisioned': 'Workspace created',
  'borrower.created': 'Added a borrower',
  'borrower.updated': 'Changed a borrower',
  'application.created': 'Started a loan application',
  'application.updated': 'Changed a loan application',
  'application.submitted': 'Submitted a loan application',
  'application.approved': 'Approved a loan application',
  'application.rejected': 'Rejected a loan application',
  'application.returned': 'Returned a loan application',
  'loan.approved': 'Created a loan',
  'loan.disbursed': 'Recorded a disbursement',
  'loan.cancelled': 'Cancelled a loan',
  'loan.moved_in': 'Moved a loan from paper',
  'loan.closed': 'Closed a fully repaid loan',
  'loan.reopened': 'Reopened a loan',
  'payment.recorded': 'Recorded a repayment',
  'payment.reversed': 'Corrected a repayment',
  'penalty.charged': 'Late penalties charged',
  'penalty.waived': 'Waived a late penalty',
  'collection.noted': 'Added a collection note',
  'product.created': 'Added a loan product',
  'product.updated': 'Changed a loan product',
  'product.archived': 'Archived a loan product',
  'product.reactivated': 'Reactivated a loan product',
};

export default async function HomePage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const { asOf } = await searchParams;
  const [api, me] = await Promise.all([serverApi(), currentUser()]);

  const report: TrialBalance | null = me.permissions.includes('ledger.read') ? await api.trialBalance(asOf || undefined) : null;
  const activity: AuditEvent[] = me.permissions.includes('audit.read') ? await api.auditEvents(10) : [];

  const longDate = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'UTC' });
  const stamp = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short', timeZone: me.tenant.timezone });

  return (
    <>
        {report ? (
          <>
            <div className="page-head">
              <h1 className="page-title">Trial balance</h1>
              <form className="range-form as-of-form no-print" action="/">
                <label className="field">
                  As of
                  <input name="asOf" type="date" defaultValue={report.asOf} required />
                </label>
                <button className="button button-quiet" type="submit">
                  Show
                </button>
              </form>
            </div>
            <p className="page-status" data-state={report.balanced ? 'on' : 'off'}>
              {report.totalDebitKobo === '0'
                ? 'No journal entries on or before this date.'
                : report.balanced
                  ? `Debits and credits match as of ${longDate.format(new Date(report.asOf))}.`
                  : `Debits and credits do not match as of ${longDate.format(new Date(report.asOf))}. Do not close the month until this is resolved.`}
            </p>

            <div className="sheet-scroll">
            <table className="sheet">
              <thead>
                <tr>
                  <th className="code" scope="col">Code</th>
                  <th scope="col">Account</th>
                  <th className="amount" scope="col">Debit</th>
                  <th className="amount" scope="col">Credit</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.code}>
                    <td className="code">{row.code}</td>
                    <td>{row.name}</td>
                    <td className="amount">{row.debitKobo === '0' ? '' : formatNaira(row.debitKobo)}</td>
                    <td className="amount">{row.creditKobo === '0' ? '' : formatNaira(row.creditKobo)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="code" />
                  <td>Total</td>
                  <td className="amount">{formatNaira(report.totalDebitKobo)}</td>
                  <td className="amount">{formatNaira(report.totalCreditKobo)}</td>
                </tr>
              </tfoot>
            </table>
            </div>
          </>
        ) : (
          <>
            <h1 className="page-title">Welcome, {me.user.fullName}</h1>
            <p className="page-status">Your role does not include the ledger. Ask an admin if you need access.</p>
          </>
        )}

        {activity.length > 0 && (
          <section className="activity">
            <h2 className="activity-title">Recent activity</h2>
            <ul className="activity-list">
              {activity.map((event) => (
                <li key={event.id}>
                  <span>
                    {event.actorName
                      ? `${event.actorName}: ${(ACTIVITY_LABELS[event.action] ?? event.action).toLowerCase()}`
                      : (ACTIVITY_LABELS[event.action] ?? event.action)}
                  </span>
                  <time dateTime={event.createdAt}>{stamp.format(new Date(event.createdAt))}</time>
                </li>
              ))}
            </ul>
          </section>
        )}
    </>
  );
}

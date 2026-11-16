import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, formatNaira } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';
import { APPLICATION_STATUS_LABELS, LOAN_STATUS_LABELS } from '@/lib/product-labels';

export default async function BorrowerPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, api, me] = await Promise.all([params, serverApi(), currentUser()]);
  const borrower = await api.borrower(id).catch((error: unknown) => {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  const canReadLoans = me.permissions.includes('loans.read');
  const [applications, loans] = canReadLoans
    ? await Promise.all([api.applications({ borrowerId: id }), api.loans({ borrowerId: id })])
    : [[], []];

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{borrower.fullName}</h1>
        <div className="page-actions">
          {me.permissions.includes('borrowers.manage') && (
            <Link className="button button-quiet" href={`/borrowers/${id}/edit`}>
              Change
            </Link>
          )}
          {me.permissions.includes('loans.apply') && (
            <Link className="button" href={`/applications/new?borrower=${id}`}>
              Start application
            </Link>
          )}
        </div>
      </div>

      <dl className="terms">
        <dt>Reference</dt>
        <dd>{borrower.reference}</dd>
        <dt>Phone</dt>
        <dd>{borrower.phone}</dd>
        <dt>Address</dt>
        <dd>{borrower.address}</dd>
        {borrower.businessName && (
          <>
            <dt>Business</dt>
            <dd>{borrower.businessName}</dd>
          </>
        )}
        {borrower.occupation && (
          <>
            <dt>Occupation</dt>
            <dd>{borrower.occupation}</dd>
          </>
        )}
        {borrower.email && (
          <>
            <dt>Email</dt>
            <dd>{borrower.email}</dd>
          </>
        )}
        {borrower.notes && (
          <>
            <dt>Notes</dt>
            <dd>{borrower.notes}</dd>
          </>
        )}
      </dl>

      {loans.length > 0 && (
        <section className="activity">
          <h2 className="activity-title">Loans</h2>
          <ul className="activity-list">
            {loans.map((loan) => (
              <li key={loan.id}>
                <Link href={`/loans/${loan.id}`}>
                  {loan.reference}, {formatNaira(loan.principalKobo)}
                </Link>
                <span>{LOAN_STATUS_LABELS[loan.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {applications.length > 0 && (
        <section className="activity">
          <h2 className="activity-title">Applications</h2>
          <ul className="activity-list">
            {applications.map((application) => (
              <li key={application.id}>
                <Link href={`/applications/${application.id}`}>
                  {application.reference}, {formatNaira(application.principalKobo)}
                </Link>
                <span>{APPLICATION_STATUS_LABELS[application.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

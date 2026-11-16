import Link from 'next/link';
import { redirect } from 'next/navigation';
import { applicationStatuses, type ApplicationStatus, formatNaira } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';
import { APPLICATION_STATUS_LABELS } from '@/lib/product-labels';

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const [{ status }, api, me] = await Promise.all([searchParams, serverApi(), currentUser()]);
  if (!me.permissions.includes('loans.read')) redirect('/');
  const selected = applicationStatuses.find((value) => value === status) as ApplicationStatus | undefined;
  const applications = await api.applications(selected ? { status: selected } : {});

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Applications</h1>
        {me.permissions.includes('loans.apply') && (
          <Link className="button" href="/applications/new">
            Start application
          </Link>
        )}
      </div>

      <nav className="tabs" aria-label="Filter by status">
        <Link href="/applications" aria-current={selected ? undefined : 'page'}>
          All
        </Link>
        {applicationStatuses.map((value) => (
          <Link key={value} href={`/applications?status=${value}`} aria-current={selected === value ? 'page' : undefined}>
            {APPLICATION_STATUS_LABELS[value]}
          </Link>
        ))}
      </nav>

      {applications.length === 0 ? (
        <p className="page-status">No applications here yet.</p>
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
              {applications.map((application) => (
                <tr key={application.id}>
                  <td className="nowrap">
                    <Link href={`/applications/${application.id}`}>{application.reference}</Link>
                  </td>
                  <td>{application.borrowerName}</td>
                  <td>{application.productName}</td>
                  <td>{APPLICATION_STATUS_LABELS[application.status]}</td>
                  <td className="amount">{formatNaira(application.principalKobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

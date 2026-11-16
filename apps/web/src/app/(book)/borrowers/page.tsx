import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser, serverApi } from '@/lib/api';

export default async function BorrowersPage({ searchParams }: { searchParams: Promise<{ search?: string }> }) {
  const [{ search = '' }, api, me] = await Promise.all([searchParams, serverApi(), currentUser()]);
  if (!me.permissions.includes('borrowers.read')) redirect('/');
  const borrowers = await api.borrowers(search);
  const canManage = me.permissions.includes('borrowers.manage');

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Borrowers</h1>
        {canManage && (
          <Link className="button" href="/borrowers/new">
            Add borrower
          </Link>
        )}
      </div>

      <form className="search-form" action="/borrowers">
        <label className="field">
          Find a borrower
          <input name="search" type="search" defaultValue={search} placeholder="Name, phone, business or reference" />
        </label>
        <button className="button button-quiet" type="submit">
          Search
        </button>
      </form>

      {borrowers.length === 0 ? (
        <p className="page-status">
          {search ? `No borrowers match "${search}".` : 'No borrowers yet. Add one to start a loan application.'}
        </p>
      ) : (
        <div className="sheet-scroll">
          <table className="sheet">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Name</th>
                <th scope="col">Phone</th>
                <th scope="col">Business</th>
              </tr>
            </thead>
            <tbody>
              {borrowers.map((borrower) => (
                <tr key={borrower.id}>
                  <td className="nowrap">{borrower.reference}</td>
                  <td>
                    <Link href={`/borrowers/${borrower.id}`}>{borrower.fullName}</Link>
                  </td>
                  <td className="nowrap">{borrower.phone}</td>
                  <td>{borrower.businessName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

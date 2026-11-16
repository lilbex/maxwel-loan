import { redirect } from 'next/navigation';
import { currentUser, serverApi } from '@/lib/api';
import { BorrowerForm } from '../../borrower-form';

export default async function EditBorrowerPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, api, me] = await Promise.all([params, serverApi(), currentUser()]);
  if (!me.permissions.includes('borrowers.manage')) redirect(`/borrowers/${id}`);
  const borrower = await api.borrower(id);
  return (
    <>
      <h1 className="page-title">Change {borrower.fullName}</h1>
      <BorrowerForm borrower={borrower} />
    </>
  );
}

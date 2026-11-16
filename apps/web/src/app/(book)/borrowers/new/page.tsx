import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/api';
import { BorrowerForm } from '../borrower-form';

export default async function NewBorrowerPage() {
  const me = await currentUser();
  if (!me.permissions.includes('borrowers.manage')) redirect('/borrowers');
  return (
    <>
      <h1 className="page-title">Add borrower</h1>
      <BorrowerForm />
    </>
  );
}

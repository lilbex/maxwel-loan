import { redirect } from 'next/navigation';
import { currentUser, serverApi } from '@/lib/api';
import { ApplicationForm } from '../application-form';

export default async function NewApplicationPage({ searchParams }: { searchParams: Promise<{ borrower?: string }> }) {
  const [{ borrower }, api, me] = await Promise.all([searchParams, serverApi(), currentUser()]);
  if (!me.permissions.includes('loans.apply')) redirect('/applications');
  const [borrowers, products] = await Promise.all([api.borrowers(), api.loanProducts()]);
  return (
    <>
      <h1 className="page-title">Start application</h1>
      <ApplicationForm
        borrowers={borrowers}
        products={products.filter((product) => product.status === 'active')}
        borrowerId={borrower}
      />
    </>
  );
}

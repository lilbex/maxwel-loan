import { redirect } from 'next/navigation';
import { currentUser, serverApi } from '@/lib/api';
import { ExistingLoanForm } from '../existing-loan-form';

export default async function NewExistingLoanPage() {
  const [api, me] = await Promise.all([serverApi(), currentUser()]);
  if (!me.permissions.includes('loans.apply')) redirect('/opening-balances');
  const [borrowers, products] = await Promise.all([api.borrowers(), api.loanProducts()]);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: me.tenant.timezone }).format(new Date());
  return (
    <>
      <h1 className="page-title">Add existing loan</h1>
      <p className="page-status">Copy this from the paper record. A second person will check it before it becomes a loan.</p>
      <ExistingLoanForm borrowers={borrowers} products={products.filter((item) => item.status === 'active')} today={today} />
    </>
  );
}

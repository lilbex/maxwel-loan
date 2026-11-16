import { redirect } from 'next/navigation';
import { currentUser, serverApi } from '@/lib/api';
import { ExistingLoanForm } from '../../existing-loan-form';

export default async function EditExistingLoanPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, api, me] = await Promise.all([params, serverApi(), currentUser()]);
  const [application, borrowers, products] = await Promise.all([api.application(id), api.borrowers(), api.loanProducts()]);
  if (!me.permissions.includes('loans.apply') || application.status !== 'draft' || !application.existing) {
    redirect(`/applications/${id}`);
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: me.tenant.timezone }).format(new Date());
  return (
    <>
      <h1 className="page-title">Change {application.reference}</h1>
      <ExistingLoanForm
        application={application}
        existing={application.existing}
        borrowers={borrowers}
        products={products.filter((item) => item.status === 'active')}
        today={today}
      />
    </>
  );
}

import { redirect } from 'next/navigation';
import { currentUser, serverApi } from '@/lib/api';
import { ApplicationForm } from '../../application-form';

export default async function EditApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, api, me] = await Promise.all([params, serverApi(), currentUser()]);
  const [application, borrowers, products] = await Promise.all([
    api.application(id),
    api.borrowers(),
    api.loanProducts(),
  ]);
  if (!me.permissions.includes('loans.apply') || application.status !== 'draft') redirect(`/applications/${id}`);
  return (
    <>
      <h1 className="page-title">Change {application.reference}</h1>
      <ApplicationForm
        application={application}
        borrowers={borrowers}
        products={products.filter((product) => product.status === 'active')}
      />
    </>
  );
}

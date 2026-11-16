import { currentUser } from '@/lib/api';
import { Nav } from './nav';
import { SignOutButton } from './sign-out-button';

export default async function BookLayout({ children }: { children: React.ReactNode }) {
  const me = await currentUser();
  const can = (permission: string) => me.permissions.includes(permission);
  const links = [
    ...(can('borrowers.read') ? [{ href: '/borrowers', label: 'Borrowers' }] : []),
    ...(can('loans.read')
      ? [
          { href: '/collections', label: 'Collections' },
          { href: '/applications', label: 'Applications' },
          { href: '/loans', label: 'Loans' },
          { href: '/repayments', label: 'Repayments' },
          { href: '/opening-balances', label: 'Moving from paper' },
        ]
      : []),
    ...(can('products.read') ? [{ href: '/loan-products', label: 'Loan products' }] : []),
    ...(can('reports.read') ? [{ href: '/reports', label: 'Reports' }] : []),
    ...(can('ledger.read') ? [{ href: '/', label: 'Trial balance' }] : []),
    ...(can('users.read') ? [{ href: '/staff', label: 'Staff' }] : []),
  ];

  return (
    <div className="book">
      <aside className="spine">
        <p className="spine-lender">{me.tenant.name}</p>
        <p className="spine-user">{me.user.fullName}</p>
        <Nav links={links} />
        <SignOutButton />
      </aside>
      <main className="page">{children}</main>
    </div>
  );
}

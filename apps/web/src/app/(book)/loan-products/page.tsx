import Link from 'next/link';
import { redirect } from 'next/navigation';
import { formatNaira } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';
import { FREQUENCY_LABELS, METHOD_LABELS, TERM_UNITS } from '@/lib/product-labels';

export default async function LoanProductsPage() {
  const [api, me] = await Promise.all([serverApi(), currentUser()]);
  if (!me.permissions.includes('products.read')) redirect('/');
  const products = await api.loanProducts();
  const canManage = me.permissions.includes('products.manage');

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Loan products</h1>
        {canManage && (
          <Link className="button" href="/loan-products/new">
            Add product
          </Link>
        )}
      </div>

      {products.length === 0 ? (
        <p className="page-status">
          {canManage
            ? 'No loan products yet. Add one to set its interest, fees and repayment terms.'
            : 'No loan products yet.'}
        </p>
      ) : (
        <div className="sheet-scroll">
          <table className="sheet">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Interest</th>
                <th scope="col">Repayment</th>
                <th className="amount" scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td>
                    <Link href={`/loan-products/${product.id}`}>{product.name}</Link>
                    {product.status === 'archived' && <span className="tag">Archived</span>}
                  </td>
                  <td>
                    {product.ratePercent}% per {product.ratePeriod}, {METHOD_LABELS[product.interestMethod].toLowerCase()}
                  </td>
                  <td>
                    {FREQUENCY_LABELS[product.repaymentFrequency]}, {product.minTerm} to {product.maxTerm}{' '}
                    {TERM_UNITS[product.repaymentFrequency]}
                  </td>
                  <td className="amount">
                    {formatNaira(product.minPrincipalKobo)} to {formatNaira(product.maxPrincipalKobo)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

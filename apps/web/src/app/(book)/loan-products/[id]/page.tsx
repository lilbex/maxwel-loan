import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, formatNaira, type LoanProduct, type ProductFee } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';
import { BUCKET_LABELS, FREQUENCY_LABELS, METHOD_LABELS, ROUNDING_LABELS, TERM_UNITS } from '@/lib/product-labels';
import { ArchiveButton } from './archive-button';
import { SchedulePreview } from './schedule-preview';

const TIMING = {
  deducted_upfront: 'deducted from the loan',
  first_installment: 'with the first repayment',
  spread: 'across all repayments',
};
const PENALTY_FREQUENCY = { once: 'once', daily: 'every day', weekly: 'every week', monthly: 'every month' };

const feeText = (fee: ProductFee) =>
  `${fee.name}: ${fee.type === 'flat' ? formatNaira(fee.amountKobo) : `${fee.percent}% of the loan`}, ${TIMING[fee.timing]}`;

function penaltyText({ penalty }: LoanProduct) {
  if (penalty.type === 'none') return 'None';
  const amount = penalty.type === 'flat' ? formatNaira(penalty.amountKobo) : `${penalty.percent}% of the overdue amount`;
  return `${amount} ${PENALTY_FREQUENCY[penalty.frequency]}, after ${penalty.graceDays} days of grace`;
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, api, me] = await Promise.all([params, serverApi(), currentUser()]);
  const product = await api.loanProduct(id).catch((error: unknown) => {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  const canManage = me.permissions.includes('products.manage');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: me.tenant.timezone }).format(new Date());
  const unit = TERM_UNITS[product.repaymentFrequency];

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{product.name}</h1>
        {canManage && (
          <div className="page-actions">
            <Link className="button button-quiet" href={`/loan-products/${product.id}/edit`}>
              Change
            </Link>
            <ArchiveButton id={product.id} status={product.status} />
          </div>
        )}
      </div>
      {product.status === 'archived' && (
        <p className="page-status">Archived. Staff can no longer choose this product for new loans.</p>
      )}

      <dl className="terms">
        <dt>Interest</dt>
        <dd>
          {product.ratePercent}% per {product.ratePeriod}, {METHOD_LABELS[product.interestMethod].toLowerCase()}
        </dd>
        <dt>Repayment</dt>
        <dd>
          {FREQUENCY_LABELS[product.repaymentFrequency]}, {product.minTerm} to {product.maxTerm} {unit}
        </dd>
        <dt>Loan amount</dt>
        <dd>
          {formatNaira(product.minPrincipalKobo)} to {formatNaira(product.maxPrincipalKobo)}
        </dd>
        <dt>Rounding</dt>
        <dd>{ROUNDING_LABELS[product.roundingUnitKobo]}</dd>
        <dt>Fees</dt>
        <dd>{product.fees.length ? product.fees.map(feeText).join('; ') : 'None'}</dd>
        <dt>Late penalty</dt>
        <dd>{penaltyText(product)}</dd>
        <dt>Payment order</dt>
        <dd>
          {product.allocationOrder
            .map((bucket, index) => (index === 0 ? BUCKET_LABELS[bucket] : BUCKET_LABELS[bucket].toLowerCase()))
            .join(', then ')}
        </dd>
      </dl>

      <SchedulePreview product={product} today={today} termUnit={unit} />
    </>
  );
}

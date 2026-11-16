'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import {
  allocationBuckets,
  ApiError,
  createApiClient,
  formatNaira,
  interestMethods,
  type LoanProduct,
  type LoanProductRequest,
  nairaToKobo,
  type ProductPenalty,
  repaymentFrequencies,
  roundingUnits,
} from '@loan-platform/api-client';
import {
  BUCKET_LABELS,
  FREQUENCY_LABELS,
  METHOD_LABELS,
  ROUNDING_LABELS,
  TERM_UNITS,
} from '@/lib/product-labels';

const api = createApiClient({ baseUrl: '/api' });
const koboToNaira = (kobo: string) => (kobo ? formatNaira(kobo).replace(/[₦,]|\.00$/g, '') : '');

interface FeeDraft {
  name: string;
  type: 'flat' | 'percent_of_principal';
  value: string;
  timing: 'deducted_upfront' | 'first_installment' | 'spread';
}

function feeDrafts(product?: LoanProduct): FeeDraft[] {
  return (product?.fees ?? []).map((fee) => ({
    name: fee.name,
    type: fee.type,
    value: fee.type === 'flat' ? koboToNaira(fee.amountKobo) : fee.percent,
    timing: fee.timing,
  }));
}

export function ProductForm({ product }: { product?: LoanProduct }) {
  const router = useRouter();
  const penalty = product?.penalty ?? ({ type: 'none' } as ProductPenalty);

  const [name, setName] = useState(product?.name ?? '');
  const [interestMethod, setInterestMethod] = useState(product?.interestMethod ?? 'flat');
  const [ratePercent, setRatePercent] = useState(product?.ratePercent ?? '');
  const [ratePeriod, setRatePeriod] = useState(product?.ratePeriod ?? 'month');
  const [frequency, setFrequency] = useState(product?.repaymentFrequency ?? 'monthly');
  const [periodBasis, setPeriodBasis] = useState(product?.periodBasis ?? 'simple');
  const [minAmount, setMinAmount] = useState(koboToNaira(product?.minPrincipalKobo ?? ''));
  const [maxAmount, setMaxAmount] = useState(koboToNaira(product?.maxPrincipalKobo ?? ''));
  const [minTerm, setMinTerm] = useState(String(product?.minTerm ?? ''));
  const [maxTerm, setMaxTerm] = useState(String(product?.maxTerm ?? ''));
  const [rounding, setRounding] = useState<number>(product?.roundingUnitKobo ?? 1);
  const [fees, setFees] = useState<FeeDraft[]>(feeDrafts(product));
  const [penaltyType, setPenaltyType] = useState(penalty.type);
  const [penaltyValue, setPenaltyValue] = useState(
    penalty.type === 'flat' ? koboToNaira(penalty.amountKobo) : penalty.type === 'none' ? '' : penalty.percent,
  );
  const [graceDays, setGraceDays] = useState(penalty.type === 'none' ? '0' : String(penalty.graceDays));
  const [penaltyFrequency, setPenaltyFrequency] = useState(penalty.type === 'none' ? 'once' : penalty.frequency);
  const [order, setOrder] = useState(product?.allocationOrder ?? [...allocationBuckets]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const updateFee = (index: number, change: Partial<FeeDraft>) =>
    setFees(fees.map((fee, position) => (position === index ? { ...fee, ...change } : fee)));

  function moveUp(index: number) {
    const next = [...order];
    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
    setOrder(next);
  }

  function buildRequest(): LoanProductRequest | string {
    const minPrincipalKobo = nairaToKobo(minAmount);
    const maxPrincipalKobo = nairaToKobo(maxAmount);
    if (!minPrincipalKobo || !maxPrincipalKobo || minPrincipalKobo === '0') {
      return 'Enter the smallest and largest loan amounts in naira.';
    }

    const builtFees: LoanProductRequest['fees'] = [];
    for (const fee of fees) {
      if (fee.type === 'percent_of_principal') {
        builtFees.push({ name: fee.name, type: fee.type, percent: fee.value.trim(), timing: fee.timing });
      } else {
        const amountKobo = nairaToKobo(fee.value);
        if (!amountKobo || amountKobo === '0') return `Enter a naira amount for the fee "${fee.name}".`;
        builtFees.push({ name: fee.name, type: fee.type, amountKobo, timing: fee.timing });
      }
    }

    let builtPenalty: ProductPenalty = { type: 'none' };
    if (penaltyType !== 'none') {
      const timing = { graceDays: Number(graceDays), frequency: penaltyFrequency };
      if (penaltyType === 'flat') {
        const amountKobo = nairaToKobo(penaltyValue);
        if (!amountKobo || amountKobo === '0') return 'Enter a naira amount for the late penalty.';
        builtPenalty = { type: 'flat', amountKobo, ...timing };
      } else {
        builtPenalty = { type: 'percent_of_overdue', percent: penaltyValue.trim(), ...timing };
      }
    }

    return {
      name,
      interestMethod,
      ratePercent: ratePercent.trim(),
      ratePeriod,
      repaymentFrequency: frequency,
      periodBasis,
      minPrincipalKobo,
      maxPrincipalKobo,
      minTerm: Number(minTerm),
      maxTerm: Number(maxTerm),
      roundingUnitKobo: rounding as LoanProductRequest['roundingUnitKobo'],
      fees: builtFees,
      penalty: builtPenalty,
      allocationOrder: order,
    };
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = buildRequest();
    if (typeof body === 'string') {
      setError(body);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const saved = product ? await api.updateLoanProduct(product.id, body) : await api.createLoanProduct(body);
      router.push(`/loan-products/${saved.id}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The server could not be reached. Try again.');
      setPending(false);
    }
  }

  return (
    <form className="product-form" onSubmit={onSubmit}>
      <label className="field">
        Product name
        <input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} />
      </label>

      <fieldset>
        <legend>Interest</legend>
        <label className="field">
          Method
          <select value={interestMethod} onChange={(event) => setInterestMethod(event.target.value as typeof interestMethod)}>
            {interestMethods.map((method) => (
              <option key={method} value={method}>
                {METHOD_LABELS[method]}
              </option>
            ))}
          </select>
        </label>
        <div className="field-row">
          <label className="field">
            Rate (%)
            <input value={ratePercent} onChange={(event) => setRatePercent(event.target.value)} inputMode="decimal" required />
          </label>
          <label className="field">
            Per
            <select value={ratePeriod} onChange={(event) => setRatePeriod(event.target.value as typeof ratePeriod)}>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Repayment</legend>
        <label className="field">
          How often
          <select value={frequency} onChange={(event) => setFrequency(event.target.value as typeof frequency)}>
            {repaymentFrequencies.map((value) => (
              <option key={value} value={value}>
                {FREQUENCY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        {frequency !== 'monthly' && (
          <label className="field">
            Month length
            <select value={periodBasis} onChange={(event) => setPeriodBasis(event.target.value as typeof periodBasis)}>
              <option value="simple">Simple: 30 days or 4 weeks in a month</option>
              <option value="calendar">Calendar: 365 days or 52 weeks in a year</option>
            </select>
          </label>
        )}
        <div className="field-row">
          <label className="field">
            Shortest term ({TERM_UNITS[frequency]})
            <input value={minTerm} onChange={(event) => setMinTerm(event.target.value)} type="number" min={1} max={730} required />
          </label>
          <label className="field">
            Longest term ({TERM_UNITS[frequency]})
            <input value={maxTerm} onChange={(event) => setMaxTerm(event.target.value)} type="number" min={1} max={730} required />
          </label>
        </div>
        <label className="field">
          Round repayments
          <select value={rounding} onChange={(event) => setRounding(Number(event.target.value))}>
            {roundingUnits.map((unit) => (
              <option key={unit} value={unit}>
                {ROUNDING_LABELS[unit]}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Loan amount</legend>
        <div className="field-row">
          <label className="field">
            Smallest (₦)
            <input value={minAmount} onChange={(event) => setMinAmount(event.target.value)} inputMode="decimal" required />
          </label>
          <label className="field">
            Largest (₦)
            <input value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} inputMode="decimal" required />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Fees</legend>
        {fees.map((fee, index) => (
          <div className="fee-row" key={index}>
            <label className="field">
              Name
              <input value={fee.name} onChange={(event) => updateFee(index, { name: event.target.value })} required minLength={2} />
            </label>
            <label className="field">
              Charged as
              <select
                value={fee.type}
                onChange={(event) => updateFee(index, { type: event.target.value as FeeDraft['type'] })}
              >
                <option value="percent_of_principal">% of loan</option>
                <option value="flat">Fixed ₦</option>
              </select>
            </label>
            <label className="field">
              {fee.type === 'flat' ? 'Amount (₦)' : 'Percent'}
              <input value={fee.value} onChange={(event) => updateFee(index, { value: event.target.value })} inputMode="decimal" required />
            </label>
            <label className="field">
              Collected
              <select
                value={fee.timing}
                onChange={(event) => updateFee(index, { timing: event.target.value as FeeDraft['timing'] })}
              >
                <option value="deducted_upfront">Deducted from the loan</option>
                <option value="first_installment">With the first repayment</option>
                <option value="spread">Across all repayments</option>
              </select>
            </label>
            <button className="text-button" type="button" onClick={() => setFees(fees.filter((_, position) => position !== index))}>
              Remove fee
            </button>
          </div>
        ))}
        <button
          className="text-button"
          type="button"
          onClick={() => setFees([...fees, { name: '', type: 'percent_of_principal', value: '', timing: 'deducted_upfront' }])}
        >
          Add a fee
        </button>
      </fieldset>

      <fieldset>
        <legend>Late penalty</legend>
        <label className="field">
          Charge
          <select value={penaltyType} onChange={(event) => setPenaltyType(event.target.value as typeof penaltyType)}>
            <option value="none">No penalty</option>
            <option value="percent_of_overdue">Percent of the overdue amount</option>
            <option value="flat">Fixed amount</option>
          </select>
        </label>
        {penaltyType !== 'none' && (
          <>
            <label className="field">
              {penaltyType === 'flat' ? 'Amount (₦)' : 'Percent'}
              <input value={penaltyValue} onChange={(event) => setPenaltyValue(event.target.value)} inputMode="decimal" required />
            </label>
            <div className="field-row">
              <label className="field">
                Days of grace
                <input value={graceDays} onChange={(event) => setGraceDays(event.target.value)} type="number" min={0} max={365} required />
              </label>
              <label className="field">
                Charged
                <select value={penaltyFrequency} onChange={(event) => setPenaltyFrequency(event.target.value as typeof penaltyFrequency)}>
                  <option value="once">Once</option>
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                  <option value="monthly">Every month</option>
                </select>
              </label>
            </div>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Payment order</legend>
        <p className="field-note">A repayment covers these in order, from the top.</p>
        <ol className="order-list">
          {order.map((bucket, index) => (
            <li key={bucket}>
              <span>{BUCKET_LABELS[bucket]}</span>
              {index > 0 && (
                <button
                  className="text-button"
                  type="button"
                  aria-label={`Move ${BUCKET_LABELS[bucket]} up`}
                  onClick={() => moveUp(index)}
                >
                  Move up
                </button>
              )}
            </li>
          ))}
        </ol>
      </fieldset>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="button" type="submit" disabled={pending}>
        {pending ? 'Saving' : product ? 'Save changes' : 'Add product'}
      </button>
    </form>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import {
  type Borrower,
  formatNaira,
  type GuarantorInput,
  type LoanApplication,
  type LoanProduct,
  nairaToKobo,
} from '@loan-platform/api-client';
import { api, errorMessage } from '@/lib/client-api';
import { TERM_UNITS } from '@/lib/product-labels';

const koboToNaira = (kobo: string) => formatNaira(kobo).replace(/[₦,]|\.00$/g, '');
const emptyGuarantor: GuarantorInput = { fullName: '', phone: '', address: '', relationship: '' };

export function ApplicationForm({
  borrowers,
  products,
  application,
  borrowerId,
}: {
  borrowers: Borrower[];
  products: LoanProduct[];
  application?: LoanApplication;
  borrowerId?: string;
}) {
  const router = useRouter();
  const [borrower, setBorrower] = useState(application?.borrowerId ?? borrowerId ?? '');
  const [productId, setProductId] = useState(application?.productId ?? products[0]?.id ?? '');
  const [amount, setAmount] = useState(application ? koboToNaira(application.principalKobo) : '');
  const [term, setTerm] = useState(application ? String(application.termCount) : '');
  const [purpose, setPurpose] = useState(application?.purpose ?? '');
  const [guarantors, setGuarantors] = useState<GuarantorInput[]>(application?.guarantors ?? []);
  const [collateral, setCollateral] = useState(
    (application?.collateral ?? []).map((item) => ({
      description: item.description,
      value: koboToNaira(item.estimatedValueKobo),
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const product = products.find((item) => item.id === productId);
  const updateGuarantor = (index: number, change: Partial<GuarantorInput>) =>
    setGuarantors(guarantors.map((item, position) => (position === index ? { ...item, ...change } : item)));
  const updateCollateral = (index: number, change: Partial<(typeof collateral)[number]>) =>
    setCollateral(collateral.map((item, position) => (position === index ? { ...item, ...change } : item)));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const principalKobo = nairaToKobo(amount);
    if (!principalKobo || principalKobo === '0') {
      setError('Enter the loan amount in naira.');
      return;
    }
    const builtCollateral = [];
    for (const item of collateral) {
      const estimatedValueKobo = nairaToKobo(item.value);
      if (!estimatedValueKobo || estimatedValueKobo === '0') {
        setError(`Enter a naira value for "${item.description}".`);
        return;
      }
      builtCollateral.push({ description: item.description, estimatedValueKobo });
    }
    const body = {
      borrowerId: borrower,
      productId,
      principalKobo,
      termCount: Number(term),
      purpose,
      guarantors,
      collateral: builtCollateral,
    };
    setPending(true);
    setError(null);
    try {
      const saved = application ? await api.updateApplication(application.id, body) : await api.createApplication(body);
      router.push(`/applications/${saved.id}`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  if (products.length === 0) {
    return <p className="page-status">Add a loan product before starting an application.</p>;
  }

  return (
    <form className="product-form" onSubmit={onSubmit}>
      <label className="field">
        Borrower
        <select value={borrower} onChange={(event) => setBorrower(event.target.value)} required>
          <option value="">Choose a borrower</option>
          {borrowers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.fullName} ({item.reference})
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Loan product
        <select value={productId} onChange={(event) => setProductId(event.target.value)} required>
          {products.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field-row">
        <label className="field">
          Amount (₦)
          <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" required />
        </label>
        <label className="field">
          Term{product ? ` (${TERM_UNITS[product.repaymentFrequency]})` : ''}
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            type="number"
            min={product?.minTerm}
            max={product?.maxTerm}
            required
          />
        </label>
      </div>
      {product && (
        <p className="field-note">
          This product allows {formatNaira(product.minPrincipalKobo)} to {formatNaira(product.maxPrincipalKobo)} over{' '}
          {product.minTerm} to {product.maxTerm} {TERM_UNITS[product.repaymentFrequency]}.
        </p>
      )}
      <label className="field">
        Purpose of the loan
        <textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} rows={2} required minLength={3} />
      </label>

      <fieldset>
        <legend>Guarantors</legend>
        {guarantors.map((guarantor, index) => (
          <div className="fee-row" key={index}>
            <label className="field">
              Full name
              <input value={guarantor.fullName} onChange={(event) => updateGuarantor(index, { fullName: event.target.value })} required minLength={2} />
            </label>
            <label className="field">
              Phone
              <input value={guarantor.phone} onChange={(event) => updateGuarantor(index, { phone: event.target.value })} type="tel" required />
            </label>
            <label className="field">
              Address
              <input value={guarantor.address} onChange={(event) => updateGuarantor(index, { address: event.target.value })} required minLength={3} />
            </label>
            <label className="field">
              Relationship
              <input value={guarantor.relationship} onChange={(event) => updateGuarantor(index, { relationship: event.target.value })} required minLength={2} />
            </label>
            <button className="text-button" type="button" onClick={() => setGuarantors(guarantors.filter((_, position) => position !== index))}>
              Remove guarantor
            </button>
          </div>
        ))}
        {guarantors.length < 5 && (
          <button className="text-button" type="button" onClick={() => setGuarantors([...guarantors, emptyGuarantor])}>
            Add a guarantor
          </button>
        )}
      </fieldset>

      <fieldset>
        <legend>Collateral</legend>
        {collateral.map((item, index) => (
          <div className="fee-row" key={index}>
            <label className="field">
              Item
              <input value={item.description} onChange={(event) => updateCollateral(index, { description: event.target.value })} required minLength={3} />
            </label>
            <label className="field">
              Estimated value (₦)
              <input value={item.value} onChange={(event) => updateCollateral(index, { value: event.target.value })} inputMode="decimal" required />
            </label>
            <button className="text-button" type="button" onClick={() => setCollateral(collateral.filter((_, position) => position !== index))}>
              Remove item
            </button>
          </div>
        ))}
        {collateral.length < 10 && (
          <button className="text-button" type="button" onClick={() => setCollateral([...collateral, { description: '', value: '' }])}>
            Add collateral
          </button>
        )}
      </fieldset>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="button" type="submit" disabled={pending}>
        {pending ? 'Saving' : application ? 'Save changes' : 'Save draft'}
      </button>
    </form>
  );
}

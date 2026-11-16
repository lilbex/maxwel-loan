'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import {
  type Borrower,
  type ExistingLoanDetails,
  type ExistingLoanPreview,
  type ExistingLoanRequest,
  formatNaira,
  type LoanApplication,
  type LoanProduct,
  nairaToKobo,
} from '@loan-platform/api-client';
import { api, errorMessage } from '@/lib/client-api';
import { TERM_UNITS } from '@/lib/product-labels';

const koboToNaira = (kobo: string) => formatNaira(kobo).replace(/[₦,]|\.00$/g, '');

export function ExistingLoanForm({
  borrowers,
  products,
  today,
  application,
  existing,
}: {
  borrowers: Borrower[];
  products: LoanProduct[];
  today: string;
  application?: LoanApplication;
  existing?: ExistingLoanDetails;
}) {
  const router = useRouter();
  const [borrowerId, setBorrowerId] = useState(application?.borrowerId ?? '');
  const [productId, setProductId] = useState(application?.productId ?? products[0]?.id ?? '');
  const [amount, setAmount] = useState(application ? koboToNaira(application.principalKobo) : '');
  const [term, setTerm] = useState(application ? String(application.termCount) : '');
  const [paidOut, setPaidOut] = useState(existing?.disbursementDate ?? '');
  const [firstDue, setFirstDue] = useState(existing?.firstDueDate ?? '');
  const [paid, setPaid] = useState(existing ? koboToNaira(existing.paidKobo) : '0');
  const [paper, setPaper] = useState(existing?.paperReference ?? '');
  const [preview, setPreview] = useState<ExistingLoanPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const product = products.find((item) => item.id === productId);
  const change = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPreview(null);
  };

  function buildRequest(): ExistingLoanRequest | null {
    const principalKobo = nairaToKobo(amount);
    const paidKobo = nairaToKobo(paid);
    if (!principalKobo || principalKobo === '0') {
      setError('Enter the original loan amount in naira.');
      return null;
    }
    if (paidKobo === null) {
      setError('Enter the total repaid so far in naira. Use 0 if nothing has been repaid.');
      return null;
    }
    return {
      borrowerId,
      productId,
      principalKobo,
      termCount: Number(term),
      disbursementDate: paidOut,
      firstDueDate: firstDue || undefined,
      paidKobo,
      paperReference: paper.trim() || undefined,
    };
  }

  async function check(event: FormEvent) {
    event.preventDefault();
    const body = buildRequest();
    if (!body) return;
    setPending(true);
    setError(null);
    try {
      setPreview(await api.previewExistingLoan(body));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function save() {
    const body = buildRequest();
    if (!body) return;
    setPending(true);
    setError(null);
    try {
      const saved = application ? await api.updateExistingLoan(application.id, body) : await api.createExistingLoan(body);
      router.push(`/applications/${saved.id}`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  if (products.length === 0) {
    return <p className="page-status">Add a loan product with the same terms as the paper loan first.</p>;
  }

  return (
    <form className="product-form" onSubmit={check}>
      <label className="field">
        Borrower
        <select value={borrowerId} onChange={(event) => change(setBorrowerId)(event.target.value)} required>
          <option value="">Choose a borrower</option>
          {borrowers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.fullName} ({item.reference})
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Loan product with the same terms
        <select value={productId} onChange={(event) => change(setProductId)(event.target.value)} required>
          {products.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}: {item.ratePercent}% per {item.ratePeriod}
            </option>
          ))}
        </select>
      </label>
      <div className="field-row">
        <label className="field">
          Original loan amount (₦)
          <input value={amount} onChange={(event) => change(setAmount)(event.target.value)} inputMode="decimal" required />
        </label>
        <label className="field">
          Original term{product ? ` (${TERM_UNITS[product.repaymentFrequency]})` : ''}
          <input value={term} onChange={(event) => change(setTerm)(event.target.value)} type="number" min={1} max={730} required />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          Date paid out
          <input value={paidOut} onChange={(event) => change(setPaidOut)(event.target.value)} type="date" max={today} required />
        </label>
        <label className="field">
          First repayment date (optional)
          <input value={firstDue} onChange={(event) => change(setFirstDue)(event.target.value)} type="date" />
        </label>
      </div>
      <label className="field">
        Total repaid so far (₦)
        <input value={paid} onChange={(event) => change(setPaid)(event.target.value)} inputMode="decimal" required />
      </label>
      <label className="field">
        Paper record reference (optional)
        <input value={paper} onChange={(event) => setPaper(event.target.value)} placeholder="Book 2, page 14" />
      </label>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div>
        <button className="button button-quiet" type="submit" disabled={pending}>
          {pending ? 'Checking' : 'Check balance'}
        </button>
      </div>

      {preview && (
        <section>
          <h2 className="activity-title">Compare this with the paper record</h2>
          <dl className="summary summary-tight">
            <div>
              <dt>Total to repay</dt>
              <dd>{formatNaira(preview.totalRepayableKobo)}</dd>
            </div>
            <div>
              <dt>Still owed</dt>
              <dd>{formatNaira(preview.owedKobo)}</dd>
            </div>
            <div>
              <dt>Principal owed</dt>
              <dd>{formatNaira(preview.principalOwedKobo)}</dd>
            </div>
            <div>
              <dt>Overdue</dt>
              <dd>{formatNaira(preview.overdueKobo)}</dd>
            </div>
          </dl>
          <p className="field-note report-note">
            {preview.installmentsCleared} of {preview.installments.length} repayments are fully covered. If these figures
            differ from the paper, check the product and dates before saving.
          </p>
          <button className="button save-existing" type="button" disabled={pending} onClick={save}>
            {application ? 'Save changes' : 'Save draft'}
          </button>
        </section>
      )}
    </form>
  );
}

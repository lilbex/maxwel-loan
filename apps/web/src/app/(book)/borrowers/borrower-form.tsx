'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import type { Borrower, BorrowerRequest } from '@loan-platform/api-client';
import { api, errorMessage } from '@/lib/client-api';

const optional = (value: FormDataEntryValue | null) => String(value ?? '').trim() || undefined;

export function BorrowerForm({ borrower }: { borrower?: Borrower }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: BorrowerRequest = {
      fullName: String(form.get('fullName')),
      phone: String(form.get('phone')),
      address: String(form.get('address')),
      email: optional(form.get('email')),
      businessName: optional(form.get('businessName')),
      occupation: optional(form.get('occupation')),
      notes: optional(form.get('notes')),
    };
    setPending(true);
    setError(null);
    try {
      const saved = borrower ? await api.updateBorrower(borrower.id, body) : await api.createBorrower(body);
      router.push(`/borrowers/${saved.id}`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  return (
    <form className="product-form" onSubmit={onSubmit}>
      <label className="field">
        Full name
        <input name="fullName" defaultValue={borrower?.fullName} required minLength={2} />
      </label>
      <label className="field">
        Phone
        <input name="phone" type="tel" defaultValue={borrower?.phone} required />
      </label>
      <label className="field">
        Address
        <input name="address" defaultValue={borrower?.address} required minLength={3} />
      </label>
      <label className="field">
        Business name (optional)
        <input name="businessName" defaultValue={borrower?.businessName} />
      </label>
      <label className="field">
        Occupation (optional)
        <input name="occupation" defaultValue={borrower?.occupation} />
      </label>
      <label className="field">
        Email (optional)
        <input name="email" type="email" defaultValue={borrower?.email} />
      </label>
      <label className="field">
        Notes (optional)
        <textarea name="notes" rows={3} defaultValue={borrower?.notes} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="button" type="submit" disabled={pending}>
        {pending ? 'Saving' : borrower ? 'Save changes' : 'Add borrower'}
      </button>
    </form>
  );
}

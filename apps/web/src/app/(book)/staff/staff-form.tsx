'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '@/lib/client-api';

export function StaffForm({ roles }: { roles: string[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    const roleNames = form.getAll('role').map(String);
    if (roleNames.length === 0) {
      setError('Choose at least one role.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.createStaff({
        fullName: String(form.get('fullName')),
        email: String(form.get('email')),
        password: String(form.get('password')),
        roleNames,
      });
      target.reset();
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="activity">
      <h2 className="activity-title">Add staff</h2>
      <form className="decision-form" onSubmit={onSubmit}>
        <div className="field-row">
          <label className="field">
            Full name
            <input name="fullName" required minLength={2} />
          </label>
          <label className="field">
            Email
            <input name="email" type="email" required autoComplete="off" />
          </label>
        </div>
        <label className="field">
          Starting password (12 characters or more)
          <input name="password" type="password" required minLength={12} autoComplete="new-password" />
        </label>
        <fieldset className="role-list">
          <legend>Roles</legend>
          {roles.map((role) => (
            <label key={role}>
              <input type="checkbox" name="role" value={role} /> {role}
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div>
          <button className="button" type="submit" disabled={pending}>
            {pending ? 'Adding' : 'Add staff'}
          </button>
        </div>
      </form>
    </section>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ApiError, createApiClient } from '@loan-platform/api-client';

const api = createApiClient({ baseUrl: '/api' });

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.login({
        workspace: String(form.get('workspace')),
        email: String(form.get('email')),
        password: String(form.get('password')),
      });
      router.replace('/');
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 429
          ? 'Too many sign-in attempts. Wait a minute and try again.'
          : cause instanceof ApiError && cause.status < 500
            ? cause.message
            : 'The server could not be reached. Check your connection and try again.',
      );
      setPending(false);
    }
  }

  return (
    <form className="signin-form" onSubmit={onSubmit}>
      <h2>Sign in</h2>
      <label className="field">
        Workspace
        <input name="workspace" required autoComplete="organization" autoCapitalize="none" spellCheck={false} />
      </label>
      <label className="field">
        Email
        <input name="email" type="email" required autoComplete="username" />
      </label>
      <label className="field">
        Password
        <input name="password" type="password" required autoComplete="current-password" />
      </label>
      {error && (
        <p className="signin-error" role="alert">
          {error}
        </p>
      )}
      <button className="signin-button" type="submit" disabled={pending}>
        {pending ? 'Signing in' : 'Sign in'}
      </button>
    </form>
  );
}

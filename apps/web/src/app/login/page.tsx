import { LoginForm } from './login-form';

export default function LoginPage() {
  return (
    <main className="cover-layout">
      <div className="cover">
        <h1 className="cover-title">Your loan book, kept to the kobo.</h1>
      </div>
      <div className="signin">
        <LoginForm />
      </div>
    </main>
  );
}

import type { Metadata } from 'next';
import '@fontsource-variable/schibsted-grotesk/index.css';
import './globals.css';

export const metadata: Metadata = { title: 'Loan Platform' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG">
      <body>{children}</body>
    </html>
  );
}

import Link from 'next/link';
import { PrintButton } from '../print-button';
import { ExportCsvButton } from './export-csv-button';

const TABS = [
  { href: '/reports', label: 'Portfolio' },
  { href: '/reports/collected', label: 'Money collected' },
  { href: '/reports/disbursements', label: 'Disbursements' },
  { href: '/reports/financials', label: 'Profit and balance sheet' },
];

/** First and last day of the current month in the lender's time zone. */
export function thisMonth(timezone: string) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const [year, month] = today.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { from: `${today.slice(0, 7)}-01`, to: last };
}

export function ReportHeader({
  active,
  title,
  lender,
  period,
  csv,
  csvName,
}: {
  active: string;
  title: string;
  lender: string;
  period: string;
  csv?: (string | number)[][];
  csvName?: string;
}) {
  return (
    <>
      <nav className="tabs tabs-top no-print" aria-label="Reports">
        {TABS.map(({ href, label }) => (
          <Link key={href} href={href} aria-current={active === href ? 'page' : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      <p className="report-lender">{lender}</p>
      <div className="page-head">
        <h1 className="page-title">{title}</h1>
        <div className="page-actions no-print">
          {csv && csvName && <ExportCsvButton rows={csv} fileName={csvName} />}
          <PrintButton label="Print" />
        </div>
      </div>
      <p className="page-status">{period}</p>
    </>
  );
}

export function RangeForm({ action, from, to }: { action: string; from: string; to: string }) {
  return (
    <form className="range-form no-print" action={action}>
      <label className="field">
        From
        <input name="from" type="date" defaultValue={from} required />
      </label>
      <label className="field">
        To
        <input name="to" type="date" defaultValue={to} required />
      </label>
      <button className="button button-quiet" type="submit">
        Show report
      </button>
    </form>
  );
}

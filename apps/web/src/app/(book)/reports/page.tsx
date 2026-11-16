import { formatNaira, koboToDecimal } from '@loan-platform/api-client';
import { serverApi } from '@/lib/api';
import { LOAN_STATUS_LABELS } from '@/lib/product-labels';
import { reportUser } from './guard';
import { ReportHeader } from './report-chrome';

const money = (kobo: string) => (kobo.startsWith('-') ? `-${formatNaira(kobo.slice(1))}` : formatNaira(kobo));

export default async function PortfolioReportPage() {
  const [api, me] = await Promise.all([serverApi(), reportUser()]);
  const report = await api.portfolioReport();
  const date = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'UTC' });

  const csv: (string | number)[][] = [
    ['Product', 'Active loans', 'Principal outstanding', 'Principal over 30 days late', 'Percent at risk'],
    ...report.products.map((row) => [
      row.productName,
      row.activeLoans,
      koboToDecimal(row.principalOutstandingKobo),
      koboToDecimal(row.principalOverdueOver30Kobo),
      row.par30Percent,
    ]),
  ];

  return (
    <>
      <ReportHeader
        active="/reports"
        title="Portfolio"
        lender={me.tenant.name}
        period={`As of ${date.format(new Date(report.asOf))}`}
        csv={csv}
        csvName={`portfolio-${report.asOf}.csv`}
      />

      {report.ledgerPrincipalKobo !== report.principalOutstandingKobo && (
        <p className="form-error report-note">
          The ledger shows {money(report.ledgerPrincipalKobo)} in loans receivable, but loan records show{' '}
          {formatNaira(report.principalOutstandingKobo)}. Check for manual journal entries on account 1100.
        </p>
      )}

      <dl className="summary">
        <div>
          <dt>Total paid out in loans</dt>
          <dd>{formatNaira(report.totalDisbursedKobo)}</dd>
        </div>
        <div>
          <dt>Principal outstanding</dt>
          <dd>{formatNaira(report.principalOutstandingKobo)}</dd>
        </div>
        <div>
          <dt>Overdue</dt>
          <dd className={report.overdueKobo === '0' ? undefined : 'amount-overdue'}>{formatNaira(report.overdueKobo)}</dd>
        </div>
        <div>
          <dt>Over 30 days late</dt>
          <dd>{report.par30Percent}% of principal</dd>
        </div>
      </dl>

      <dl className="ageing">
        <div>
          <dt>Interest to collect</dt>
          <dd>{formatNaira(report.interestOutstandingKobo)}</dd>
        </div>
        <div>
          <dt>Fees to collect</dt>
          <dd>{formatNaira(report.feesOutstandingKobo)}</dd>
        </div>
        <div>
          <dt>Penalties to collect</dt>
          <dd>{formatNaira(report.penaltiesOutstandingKobo)}</dd>
        </div>
        <div>
          <dt>Loans</dt>
          <dd>
            {report.loansByStatus.length === 0
              ? 'None yet'
              : report.loansByStatus.map((row) => `${row.loans} ${LOAN_STATUS_LABELS[row.status].toLowerCase()}`).join(', ')}
          </dd>
        </div>
      </dl>

      {report.products.length === 0 ? (
        <p className="page-status">No active loans yet.</p>
      ) : (
        <div className="sheet-scroll statement-table">
          <table className="sheet">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th className="amount" scope="col">Active loans</th>
                <th className="amount" scope="col">Principal outstanding</th>
                <th className="amount" scope="col">Over 30 days late</th>
                <th className="amount" scope="col">At risk</th>
              </tr>
            </thead>
            <tbody>
              {report.products.map((row) => (
                <tr key={row.productName}>
                  <td>{row.productName}</td>
                  <td className="amount">{row.activeLoans}</td>
                  <td className="amount">{formatNaira(row.principalOutstandingKobo)}</td>
                  <td className="amount">{formatNaira(row.principalOverdueOver30Kobo)}</td>
                  <td className="amount">{row.par30Percent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

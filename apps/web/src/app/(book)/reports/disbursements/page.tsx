import Link from 'next/link';
import { formatNaira, koboToDecimal } from '@loan-platform/api-client';
import { serverApi } from '@/lib/api';
import { loadReport, reportUser } from '../guard';
import { RangeForm, ReportHeader, thisMonth } from '../report-chrome';

const METHOD = { bank: 'Bank', cash: 'Cash' };

export default async function DisbursementsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [params, api, me] = await Promise.all([searchParams, serverApi(), reportUser()]);
  const { from, to } = { ...thisMonth(me.tenant.timezone), ...params };
  const report = await loadReport(() => api.disbursementsReport(from, to));
  const date = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'UTC' });
  const period = `${date.format(new Date(from))} to ${date.format(new Date(to))}`;
  const form = <RangeForm action="/reports/disbursements" from={from} to={to} />;

  if (typeof report === 'string') {
    return (
      <>
        <ReportHeader active="/reports/disbursements" title="Disbursements" lender={me.tenant.name} period={period} />
        {form}
        <p className="form-error">{report}</p>
      </>
    );
  }

  const csv: (string | number)[][] = [
    ['Date', 'Loan', 'Borrower', 'Product', 'Paid from', 'Loan amount', 'Fees deducted', 'Paid out'],
    ...report.rows.map((row) => [
      row.date,
      row.loanReference,
      row.borrowerName,
      row.productName,
      METHOD[row.method],
      koboToDecimal(row.principalKobo),
      koboToDecimal(row.feesDeductedKobo),
      koboToDecimal(row.paidOutKobo),
    ]),
  ];

  return (
    <>
      <ReportHeader
        active="/reports/disbursements"
        title="Disbursements"
        lender={me.tenant.name}
        period={period}
        csv={csv}
        csvName={`disbursements-${from}-to-${to}.csv`}
      />
      {form}
      {report.rows.length === 0 ? (
        <p className="page-status">No loans were paid out in this period.</p>
      ) : (
        <div className="sheet-scroll statement-table">
          <table className="sheet">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Loan</th>
                <th scope="col">Borrower</th>
                <th scope="col">Product</th>
                <th scope="col">From</th>
                <th className="amount" scope="col">Loan amount</th>
                <th className="amount" scope="col">Fees deducted</th>
                <th className="amount" scope="col">Paid out</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.loanId}>
                  <td className="nowrap">{date.format(new Date(row.date))}</td>
                  <td className="nowrap">
                    <Link href={`/loans/${row.loanId}`}>{row.loanReference}</Link>
                  </td>
                  <td>{row.borrowerName}</td>
                  <td>{row.productName}</td>
                  <td>{METHOD[row.method]}</td>
                  <td className="amount">{formatNaira(row.principalKobo)}</td>
                  <td className="amount">{row.feesDeductedKobo === '0' ? '' : formatNaira(row.feesDeductedKobo)}</td>
                  <td className="amount">{formatNaira(row.paidOutKobo)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}>Total</td>
                <td className="amount">{formatNaira(report.totalPrincipalKobo)}</td>
                <td className="amount">{formatNaira(report.totalFeesDeductedKobo)}</td>
                <td className="amount">{formatNaira(report.totalPaidOutKobo)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}

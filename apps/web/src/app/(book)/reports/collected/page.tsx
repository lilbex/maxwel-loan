import { formatNaira, koboToDecimal } from '@loan-platform/api-client';
import { serverApi } from '@/lib/api';
import { loadReport, reportUser } from '../guard';
import { RangeForm, ReportHeader, thisMonth } from '../report-chrome';

const money = (kobo: string) =>
  kobo === '0' ? '' : kobo.startsWith('-') ? `-${formatNaira(kobo.slice(1))}` : formatNaira(kobo);

export default async function CollectedReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [params, api, me] = await Promise.all([searchParams, serverApi(), reportUser()]);
  const { from, to } = { ...thisMonth(me.tenant.timezone), ...params };
  const report = await loadReport(() => api.collectedReport(from, to));
  const date = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'UTC' });
  const period = `${date.format(new Date(from))} to ${date.format(new Date(to))}`;
  const form = <RangeForm action="/reports/collected" from={from} to={to} />;

  if (typeof report === 'string') {
    return (
      <>
        <ReportHeader active="/reports/collected" title="Money collected" lender={me.tenant.name} period={period} />
        {form}
        <p className="form-error">{report}</p>
      </>
    );
  }

  const csv: (string | number)[][] = [
    ['Date', 'Receipts', 'Corrections', 'Cash', 'Bank', 'Principal', 'Interest', 'Fees', 'Penalties', 'Overpayments', 'Total'],
    ...[...report.days, { date: 'Total', ...report.totals }].map((row) => [
      row.date,
      row.receipts,
      row.corrections,
      koboToDecimal(row.cashKobo),
      koboToDecimal(row.bankKobo),
      koboToDecimal(row.principalKobo),
      koboToDecimal(row.interestKobo),
      koboToDecimal(row.feesKobo),
      koboToDecimal(row.penaltiesKobo),
      koboToDecimal(row.overpaymentsKobo),
      koboToDecimal(row.totalKobo),
    ]),
  ];

  return (
    <>
      <ReportHeader
        active="/reports/collected"
        title="Money collected"
        lender={me.tenant.name}
        period={period}
        csv={csv}
        csvName={`collected-${from}-to-${to}.csv`}
      />
      {form}
      {report.days.length === 0 ? (
        <p className="page-status">No repayments in this period.</p>
      ) : (
        <>
          {report.totals.corrections > 0 && (
            <p className="field-note report-note">Corrections show as negative amounts on the date they were made.</p>
          )}
          <div className="sheet-scroll statement-table">
            <table className="sheet">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th className="amount" scope="col">Cash</th>
                  <th className="amount" scope="col">Bank</th>
                  <th className="amount" scope="col">Principal</th>
                  <th className="amount" scope="col">Interest</th>
                  <th className="amount" scope="col">Fees</th>
                  <th className="amount" scope="col">Penalties</th>
                  <th className="amount" scope="col">Overpaid</th>
                  <th className="amount" scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {report.days.map((day) => (
                  <tr key={day.date}>
                    <td className="nowrap">{date.format(new Date(day.date))}</td>
                    <td className="amount">{money(day.cashKobo)}</td>
                    <td className="amount">{money(day.bankKobo)}</td>
                    <td className="amount">{money(day.principalKobo)}</td>
                    <td className="amount">{money(day.interestKobo)}</td>
                    <td className="amount">{money(day.feesKobo)}</td>
                    <td className="amount">{money(day.penaltiesKobo)}</td>
                    <td className="amount">{money(day.overpaymentsKobo)}</td>
                    <td className="amount">{money(day.totalKobo)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="amount">{money(report.totals.cashKobo)}</td>
                  <td className="amount">{money(report.totals.bankKobo)}</td>
                  <td className="amount">{money(report.totals.principalKobo)}</td>
                  <td className="amount">{money(report.totals.interestKobo)}</td>
                  <td className="amount">{money(report.totals.feesKobo)}</td>
                  <td className="amount">{money(report.totals.penaltiesKobo)}</td>
                  <td className="amount">{money(report.totals.overpaymentsKobo)}</td>
                  <td className="amount">{money(report.totals.totalKobo)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </>
  );
}

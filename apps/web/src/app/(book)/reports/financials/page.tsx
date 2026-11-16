import { type FinancialLine, formatNaira, koboToDecimal } from '@loan-platform/api-client';
import { serverApi } from '@/lib/api';
import { loadReport, reportUser } from '../guard';
import { RangeForm, ReportHeader, thisMonth } from '../report-chrome';

const money = (kobo: string) => (kobo.startsWith('-') ? `-${formatNaira(kobo.slice(1))}` : formatNaira(kobo));

function Lines({ lines }: { lines: FinancialLine[] }) {
  return lines.map((line) => (
    <tr key={line.code}>
      <td>{line.name}</td>
      <td className="amount">{money(line.amountKobo)}</td>
    </tr>
  ));
}

function Heading({ children }: { children: string }) {
  return (
    <tr className="group-heading">
      <th colSpan={2} scope="colgroup">
        {children}
      </th>
    </tr>
  );
}

export default async function FinancialsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [params, api, me] = await Promise.all([searchParams, serverApi(), reportUser()]);
  const { from, to } = { ...thisMonth(me.tenant.timezone), ...params };
  const report = await loadReport(() => api.financialsReport(from, to));
  const date = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'UTC' });
  const period = `${date.format(new Date(from))} to ${date.format(new Date(to))}`;
  const form = <RangeForm action="/reports/financials" from={from} to={to} />;

  if (typeof report === 'string') {
    return (
      <>
        <ReportHeader active="/reports/financials" title="Profit and balance sheet" lender={me.tenant.name} period={period} />
        {form}
        <p className="form-error">{report}</p>
      </>
    );
  }

  const rows = (section: string, lines: FinancialLine[]) =>
    lines.map((line) => [section, line.code, line.name, koboToDecimal(line.amountKobo)]);
  const csv: (string | number)[][] = [
    ['Section', 'Code', 'Account', 'Amount'],
    ...rows('Income', report.income),
    ...rows('Expenses', report.expenses),
    ['Profit', '', 'Profit for the period', koboToDecimal(report.profitKobo)],
    ...rows('Assets', report.assets),
    ...rows('Liabilities', report.liabilities),
    ...rows('Equity', report.equity),
    ['Equity', '', 'Earnings to date', koboToDecimal(report.earningsToDateKobo)],
  ];

  return (
    <>
      <ReportHeader
        active="/reports/financials"
        title="Profit and balance sheet"
        lender={me.tenant.name}
        period={period}
        csv={csv}
        csvName={`financials-${from}-to-${to}.csv`}
      />
      {form}
      <p className="field-note report-note">
        Income is counted when it is paid, so unpaid interest and penalties are not included.
      </p>

      <div className="statements">
        <section>
          <h2 className="activity-title">Profit and loss</h2>
          <table className="sheet statement-sheet">
            <tbody>
              <Heading>Income</Heading>
              <Lines lines={report.income} />
              <tr className="subtotal">
                <td>Total income</td>
                <td className="amount">{money(report.totalIncomeKobo)}</td>
              </tr>
              <Heading>Expenses</Heading>
              <Lines lines={report.expenses} />
              <tr className="subtotal">
                <td>Total expenses</td>
                <td className="amount">{money(report.totalExpensesKobo)}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td>{report.profitKobo.startsWith('-') ? 'Loss for the period' : 'Profit for the period'}</td>
                <td className="amount">{money(report.profitKobo)}</td>
              </tr>
            </tfoot>
          </table>
        </section>

        <section>
          <h2 className="activity-title">Balance sheet at {date.format(new Date(to))}</h2>
          <table className="sheet statement-sheet">
            <tbody>
              <Heading>Assets</Heading>
              <Lines lines={report.assets} />
              <tr className="subtotal">
                <td>Total assets</td>
                <td className="amount">{money(report.totalAssetsKobo)}</td>
              </tr>
              <Heading>Liabilities and equity</Heading>
              <Lines lines={report.liabilities} />
              <Lines lines={report.equity} />
              <tr>
                <td>Earnings to date</td>
                <td className="amount">{money(report.earningsToDateKobo)}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td>Total liabilities and equity</td>
                <td className="amount">{money(report.totalLiabilitiesAndEquityKobo)}</td>
              </tr>
            </tfoot>
          </table>
          {!report.balanced && (
            <p className="form-error">The balance sheet does not balance. Do not rely on these figures.</p>
          )}
        </section>
      </div>
    </>
  );
}

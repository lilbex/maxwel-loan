import { formatNaira, type ScheduleInstallment } from '@loan-platform/api-client';

const dueDate = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'UTC' });

export function ScheduleTable({ installments }: { installments: ScheduleInstallment[] }) {
  return (
    <div className="sheet-scroll">
      <table className="sheet">
        <thead>
          <tr>
            <th scope="col">Due</th>
            <th className="amount" scope="col">Principal</th>
            <th className="amount" scope="col">Interest</th>
            <th className="amount" scope="col">Fees</th>
            <th className="amount" scope="col">Repayment</th>
            <th className="amount" scope="col">Balance</th>
          </tr>
        </thead>
        <tbody>
          {installments.map((row) => (
            <tr key={row.number}>
              <td className="nowrap">{dueDate.format(new Date(row.dueDate))}</td>
              <td className="amount">{formatNaira(row.principalKobo)}</td>
              <td className="amount">{formatNaira(row.interestKobo)}</td>
              <td className="amount">{row.feeKobo === '0' ? '' : formatNaira(row.feeKobo)}</td>
              <td className="amount">{formatNaira(row.totalKobo)}</td>
              <td className="amount">{formatNaira(row.balanceAfterKobo)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

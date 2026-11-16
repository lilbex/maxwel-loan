import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, formatNaira } from '@loan-platform/api-client';
import { currentUser, serverApi } from '@/lib/api';
import { APPLICATION_STATUS_LABELS, DECISION_LABELS } from '@/lib/product-labels';
import { DecisionForm, SubmitButton } from './application-actions';

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, api, me] = await Promise.all([params, serverApi(), currentUser()]);
  const application = await api.application(id).catch((error: unknown) => {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  const canApply = me.permissions.includes('loans.apply');
  const preparedByMe = [application.preparedByUserId, application.submittedByUserId].includes(me.user.id);
  const canDecide = me.permissions.includes('loans.approve') && application.status === 'submitted';
  const longDate = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'UTC' });
  const stamp = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short', timeZone: me.tenant.timezone });

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">
          {application.reference}
          {application.existing ? ': existing loan' : ''}
        </h1>
        {application.status === 'draft' && canApply && (
          <div className="page-actions">
            <Link
              className="button button-quiet"
              href={application.existing ? `/opening-balances/${id}/edit` : `/applications/${id}/edit`}
            >
              Change
            </Link>
            <SubmitButton id={id} />
          </div>
        )}
        {application.loanId && (
          <Link className="button" href={`/loans/${application.loanId}`}>
            View loan
          </Link>
        )}
      </div>
      <p className="page-status">{APPLICATION_STATUS_LABELS[application.status]}</p>

      <dl className="terms">
        <dt>Borrower</dt>
        <dd>
          <Link href={`/borrowers/${application.borrowerId}`}>{application.borrowerName}</Link>
        </dd>
        <dt>Product</dt>
        <dd>
          <Link href={`/loan-products/${application.productId}`}>{application.productName}</Link>
        </dd>
        <dt>Amount</dt>
        <dd>{formatNaira(application.principalKobo)}</dd>
        <dt>Term</dt>
        <dd>{application.termCount} repayments</dd>
        <dt>Purpose</dt>
        <dd>{application.purpose}</dd>
        <dt>Prepared by</dt>
        <dd>{application.preparedByName}</dd>
      </dl>

      {application.existing && (
        <section className="activity">
          <h2 className="activity-title">Check against the paper record</h2>
          <dl className="terms">
            <dt>Date paid out</dt>
            <dd>{longDate.format(new Date(application.existing.disbursementDate))}</dd>
            {application.existing.paperReference && (
              <>
                <dt>Paper record</dt>
                <dd>{application.existing.paperReference}</dd>
              </>
            )}
            <dt>Total to repay</dt>
            <dd>{formatNaira(application.existing.preview.totalRepayableKobo)}</dd>
            <dt>Repaid so far</dt>
            <dd>{formatNaira(application.existing.paidKobo)}</dd>
            <dt>Still owed</dt>
            <dd>{formatNaira(application.existing.preview.owedKobo)}</dd>
            <dt>Principal owed</dt>
            <dd>{formatNaira(application.existing.preview.principalOwedKobo)}</dd>
            <dt>Overdue now</dt>
            <dd>{formatNaira(application.existing.preview.overdueKobo)}</dd>
          </dl>
        </section>
      )}

      {application.guarantors.length > 0 && (
        <section className="activity">
          <h2 className="activity-title">Guarantors</h2>
          <ul className="activity-list">
            {application.guarantors.map((guarantor, index) => (
              <li key={index}>
                <span>
                  {guarantor.fullName}, {guarantor.relationship.toLowerCase()}
                </span>
                <span>{guarantor.phone}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {application.collateral.length > 0 && (
        <section className="activity">
          <h2 className="activity-title">Collateral</h2>
          <ul className="activity-list">
            {application.collateral.map((item, index) => (
              <li key={index}>
                <span>{item.description}</span>
                <span>{formatNaira(item.estimatedValueKobo)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {application.decisions.length > 0 && (
        <section className="activity">
          <h2 className="activity-title">Decisions</h2>
          <ul className="activity-list">
            {application.decisions.map((decision, index) => (
              <li key={index}>
                <span>
                  {DECISION_LABELS[decision.decision]} by {decision.decidedByName}
                  {decision.note ? `: ${decision.note}` : ''}
                </span>
                <time dateTime={decision.createdAt}>{stamp.format(new Date(decision.createdAt))}</time>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canDecide &&
        (preparedByMe ? (
          <p className="page-status decision-note">You prepared this application, so another approver must decide on it.</p>
        ) : (
          <DecisionForm id={id} existing={application.existing !== null} />
        ))}
    </>
  );
}

const test = require('node:test');
const assert = require('node:assert/strict');

const sapRoutes = require('../routes/sap');

function makeRequest(status, currentStage, lineStatus) {
  return {
    Status: status,
    CurrentStage: currentStage,
    ApprovalRequestLines: [
      {
        UserID: '12',
        Status: lineStatus,
        StageID: currentStage,
      },
    ],
  };
}

test('buildSapStatusFilter covers Pending, Approved, Rejected, Generated and Cancelled variants', () => {
  assert.equal(
    sapRoutes.buildSapStatusFilter('Pending'),
    "Status eq 'arsPending'"
  );

  assert.equal(
    sapRoutes.buildSapStatusFilter('Approved'),
    "Status eq 'arsApproved' or Status eq 'arsGenerated' or Status eq 'arsGeneratedByAuthorizer'"
  );

  assert.equal(
    sapRoutes.buildSapStatusFilter('Rejected'),
    "Status eq 'arsNotApproved'"
  );

  assert.equal(
    sapRoutes.buildSapStatusFilter('Generated'),
    "Status eq 'arsGenerated' or Status eq 'arsGeneratedByAuthorizer'"
  );

  assert.equal(
    sapRoutes.buildSapStatusFilter('Cancelled'),
    "Status eq 'arsCancelled'"
  );
});

test('isApprovalVisibleToSapUser shows all requests that involve the mapped user, even when the request is not pending', () => {
  const request = makeRequest('arsApproved', 13, 'arsApproved');
  request.DraftEntry = 48730;

  assert.equal(
    sapRoutes.isApprovalVisibleToSapUser(request, '12', 'Approved'),
    true
  );
});

test('isApprovalVisibleToSapUser keeps the pending-only rule on the Pending tab', () => {
  const pendingRequest = makeRequest('arsPending', 13, 'arsPending');
  pendingRequest.DraftEntry = 48730;
  const nonActionableRequest = makeRequest('arsPending', 13, 'arsApproved');
  nonActionableRequest.DraftEntry = 48730;

  assert.equal(
    sapRoutes.isApprovalVisibleToSapUser(pendingRequest, '12', 'Pending'),
    true
  );
  assert.equal(
    sapRoutes.isApprovalVisibleToSapUser(nonActionableRequest, '12', 'Pending'),
    false
  );
});

test('isApprovalVisibleToSapUser does not rely on a hard-coded draft-key allowlist', () => {
  const allowed = makeRequest('arsPending', 13, 'arsPending');
  allowed.DraftEntry = 48730;
  const blocked = makeRequest('arsPending', 13, 'arsPending');
  blocked.DraftEntry = 99999;

  assert.equal(
    sapRoutes.isApprovalVisibleToSapUser(allowed, '12', 'All'),
    true
  );
  assert.equal(
    sapRoutes.isApprovalVisibleToSapUser(blocked, '12', 'All'),
    true
  );
});

test('isApprovalVisibleToSapUser shows the originator their own request even without a decision line', () => {
  const own = {
    Status: 'arsPending',
    CurrentStage: 13,
    OriginatorID: 12,
    // The only decision line belongs to a different approver (99), not user 12.
    ApprovalRequestLines: [{ UserID: '99', Status: 'arsPending', StageID: 13 }],
  };

  // User 12 raised it, so it is visible to them even though they cannot approve it.
  assert.equal(sapRoutes.isApprovalVisibleToSapUser(own, '12', 'Pending'), true);

  // An unrelated user (neither originator nor on a line) still sees nothing.
  assert.equal(sapRoutes.isApprovalVisibleToSapUser(own, '77', 'Pending'), false);
});

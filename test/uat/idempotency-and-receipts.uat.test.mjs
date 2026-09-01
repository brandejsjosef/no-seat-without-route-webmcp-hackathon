/**
 * What a request id promises, and what a receipt number promises.
 *
 * Two P1 defects, both about a command being replayed.
 *
 * The request id bound only on SUCCESS. A refused confirmation left the id
 * unrecorded, so replaying the identical refused command wrote another decision
 * -log entry every time, and - worse - the same id could later carry different
 * content and be accepted rather than refused as a conflict. An idempotency key
 * that only remembers what worked is not an idempotency key.
 *
 * Receipt numbers were allocated from a counter that reset with the venue, so
 * three booking cycles produced NSWR-00244, NSWR-00245, NSWR-00245: two
 * bookings in one running process carrying the same number.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoStore } from '../../lib/domain.mjs';

const store = () => createDemoStore({
  clock: () => Date.parse('2026-08-31T18:00:00.000Z'),
  idFactory: ((n) => () => `id-${++n}`)(0),
});

const FULL = Object.freeze({
  wheelchairWidthCm: 72,
  maxDistanceM: 80,
  stepFree: true,
  companionCount: 1,
  entranceAssistance: true,
  lowStimulus: true,
});

function readyToConfirm(venue, requestId) {
  const plan = venue.findBundle(FULL);
  venue.stageBundle(plan.id, venue.snapshot().resourceVersion);
  const confirmation = venue.prepareConfirmation(plan.id);
  return {
    planId: plan.id,
    confirmationId: confirmation.confirmationId,
    expectedResourceVersion: confirmation.expectedResourceVersion,
    accepted: true,
    requestId,
  };
}

const refusalOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

describe('a request id binds on the first execution, refusal included', () => {
  test('replaying an identical refused command returns the same refusal', () => {
    const venue = store();
    const command = readyToConfirm(venue, 'refused-then-replayed');
    venue.armOutage('east-lift');

    const first = refusalOf(() => venue.commitBundle(command));
    const second = refusalOf(() => venue.commitBundle(command));

    assert.ok(first, 'the armed fault should have refused the first attempt');
    assert.equal(second?.code, first.code, 'the replay produced a different refusal');
  });

  test('the replay writes no second decision-log entry and moves no revision', () => {
    const venue = store();
    const command = readyToConfirm(venue, 'refused-replay-quiet');
    venue.armOutage('east-lift');
    refusalOf(() => venue.commitBundle(command));

    const after = venue.snapshot();
    refusalOf(() => venue.commitBundle(command));
    const later = venue.snapshot();

    assert.equal(later.audit.length, after.audit.length, 'the replay wrote another decision-log entry');
    assert.equal(later.resourceVersion, after.resourceVersion, 'the replay moved the venue revision');
    assert.equal(later.atomicity.bookingCount, 0);
    assert.equal(later.atomicity.reservedResourceCount, 0);
  });

  test('the same id carrying different content is a conflict, not a fresh command', () => {
    // The dangerous half: a failed attempt must not later become a different
    // successful command under the same id.
    const venue = store();
    const command = readyToConfirm(venue, 'reused-after-refusal');

    const refused = refusalOf(() => venue.commitBundle({ ...command, accepted: false }));
    assert.ok(refused, 'an unaccepted confirmation should be refused');

    const conflict = refusalOf(() => venue.commitBundle(command));
    assert.equal(
      conflict?.code,
      'IDEMPOTENCY_CONFLICT',
      'the id was reused for different content and the command went through',
    );
    assert.equal(venue.snapshot().atomicity.bookingCount, 0, 'a reused id booked something');
  });

  test('a fresh id after a refusal still works, so this is not a lockout', () => {
    const venue = store();
    const command = readyToConfirm(venue, 'refused-once');
    refusalOf(() => venue.commitBundle({ ...command, accepted: false }));

    const committed = venue.commitBundle({ ...command, requestId: 'a-new-id' });
    assert.equal(committed.ok, true);
    assert.equal(venue.snapshot().atomicity.bookingCount, 1);
  });

  test('a successful command is still replayable and books once', () => {
    const venue = store();
    const command = readyToConfirm(venue, 'happy-replay');

    const first = venue.commitBundle(command);
    const second = venue.commitBundle(command);

    assert.equal(first.ok, true);
    assert.equal(second.idempotent, true, 'a replayed success must be reported as a replay');
    assert.equal(venue.snapshot().atomicity.bookingCount, 1, 'the replay booked a second time');
  });
});

describe('a receipt number is unique in a running venue', () => {
  test('three booking cycles across reset produce three different receipts', () => {
    const venue = store();
    const receipts = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const command = readyToConfirm(venue, `cycle-${cycle}`);
      receipts.push(venue.commitBundle(command).booking.receipt);
      venue.reset();
    }

    for (const receipt of receipts) {
      assert.match(receipt, /^NSWR-\d{5}$/, `${receipt} is not a receipt number`);
    }
    assert.equal(new Set(receipts).size, 3, `two bookings share a receipt: ${receipts.join(', ')}`);
  });

  test('the allocator keeps moving forward, it does not merely avoid the last one', () => {
    const venue = store();
    const seen = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      seen.push(venue.commitBundle(readyToConfirm(venue, `run-${cycle}`)).booking.receipt);
      venue.reset();
    }
    assert.equal(new Set(seen).size, 5, `receipts repeated across five cycles: ${seen.join(', ')}`);
  });

  test('replaying one booking returns its original receipt', () => {
    // Uniqueness must not be bought by minting a new number on every read.
    const venue = store();
    const command = readyToConfirm(venue, 'receipt-replay');
    const first = venue.commitBundle(command);
    const replay = venue.commitBundle(command);
    assert.equal(replay.booking.receipt, first.booking.receipt, 'a replay minted a new receipt');
  });
});

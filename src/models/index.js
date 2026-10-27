// Explicit collection names avoid pluralization surprises. Install indexes once
// during setup, never on every request. No secrets or credentials are stored here.
export function collections(db) {
  return {
    users: db.collection('users'),
    counterStates: db.collection('counter_states'),
    periodTotals: db.collection('period_totals'),
    syncOperations: db.collection('sync_operations'),
  };
}

export async function createIndexes(db) {
  const { users, counterStates, periodTotals, syncOperations } = collections(db);
  await users.createIndex({ googleSub: 1 }, { unique: true });
  await counterStates.createIndex({ userId: 1 }, { unique: true });
  await periodTotals.createIndex(
    { userId: 1, periodType: 1, periodKey: 1 }, { unique: true },
  );
  await periodTotals.createIndex({ periodType: 1, periodKey: 1, malas: -1, userId: 1 });
  await syncOperations.createIndex({ userId: 1, operationId: 1 }, { unique: true });
  await syncOperations.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
}

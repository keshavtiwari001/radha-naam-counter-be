export const CHANTS_PER_MALA = 108;

export function assertChantCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    const error = new Error('Chant count must be a non-negative safe integer');
    error.status = 400;
    throw error;
  }
  return value;
}

// Importing historical guest progress must NOT call this scoring function.
export function cumulativeDelta(savedTotal, incomingTotal) {
  assertChantCount(savedTotal);
  assertChantCount(incomingTotal);
  const acceptedTotal = Math.max(savedTotal, incomingTotal);
  return {
    savedTotalChants: acceptedTotal,
    newChants: acceptedTotal - savedTotal,
    newLeaderboardMalas: Math.floor(acceptedTotal / CHANTS_PER_MALA)
      - Math.floor(savedTotal / CHANTS_PER_MALA),
    completedLifetimeMalas: Math.floor(acceptedTotal / CHANTS_PER_MALA),
    remainder: acceptedTotal % CHANTS_PER_MALA,
  };
}

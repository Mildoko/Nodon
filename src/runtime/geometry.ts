import type { ContactWitness, Point } from './types.js';
import { deepFreeze } from './immutable.js';

export class RuntimeFault extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RuntimeFault'; }
}
export function finite(...values: number[]): void {
  if (values.some(value => !Number.isFinite(value))) throw new RuntimeFault('E_NONFINITE', 'Non-finite runtime arithmetic');
}
export function relativeSegmentContact(
  playerId: string, targetId: string, playerStart: Point, playerEnd: Point,
  targetStart: Point, targetEnd: Point, contactThreshold: number,
): ContactWitness {
  if (!playerId || !targetId || playerId === targetId || contactThreshold < 0) throw new RuntimeFault('E_CONTACT_INPUT', 'Invalid contact participants or threshold');
  finite(playerStart.x, playerStart.y, playerEnd.x, playerEnd.y, targetStart.x, targetStart.y, targetEnd.x, targetEnd.y, contactThreshold);
  const rx = playerStart.x - targetStart.x, ry = playerStart.y - targetStart.y;
  const dx = (playerEnd.x - playerStart.x) - (targetEnd.x - targetStart.x);
  const dy = (playerEnd.y - playerStart.y) - (targetEnd.y - targetStart.y);
  const den = dx * dx + dy * dy, dot = rx * dx + ry * dy;
  finite(rx, ry, dx, dy, den, dot);
  const rawFraction = den === 0 ? 0 : -dot / den;
  finite(rawFraction);
  const closestTickFraction = Math.min(1, Math.max(0, rawFraction));
  const mx = rx + closestTickFraction * dx, my = ry + closestTickFraction * dy;
  const minSquared = mx * mx + my * my, thresholdSquared = contactThreshold * contactThreshold;
  const ex = playerEnd.x - targetEnd.x, ey = playerEnd.y - targetEnd.y;
  const endpointSquared = ex * ex + ey * ey;
  finite(mx, my, minSquared, thresholdSquared, ex, ey, endpointSquared);
  return deepFreeze({
    entityIds: [playerId, targetId] as const,
    startPositions: { [playerId]: { ...playerStart }, [targetId]: { ...targetStart } },
    endPositions: { [playerId]: { ...playerEnd }, [targetId]: { ...targetEnd } },
    closestTickFraction, minCenterDistance: Math.sqrt(minSquared), contactThreshold,
    endpointCenterDistance: Math.sqrt(endpointSquared), contacted: minSquared <= thresholdSquared,
  });
}

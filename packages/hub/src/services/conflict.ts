import micromatch from "micromatch";

function hasGlob(input: string): boolean {
  return /[*?[\]{}()!+@]/.test(input);
}

export function patternsConflict(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const leftGlob = hasGlob(left);
  const rightGlob = hasGlob(right);

  if (leftGlob && micromatch.isMatch(right, left)) {
    return true;
  }

  if (rightGlob && micromatch.isMatch(left, right)) {
    return true;
  }

  if (leftGlob && rightGlob) {
    const probes = [
      left.replace(/\*\*/g, "src").replace(/\*/g, "file").replace(/\?/g, "a"),
      right.replace(/\*\*/g, "src").replace(/\*/g, "file").replace(/\?/g, "a"),
    ];
    return probes.some(
      (probe) => micromatch.isMatch(probe, left) && micromatch.isMatch(probe, right),
    );
  }

  return false;
}

export function findConflictingPattern(
  candidatePaths: string[],
  activePaths: Array<{ claimId: string; agentId: string; pathPattern: string }>,
): { claimId: string; agentId: string; pathPattern: string } | null {
  for (const existing of activePaths) {
    for (const incoming of candidatePaths) {
      if (patternsConflict(incoming, existing.pathPattern)) {
        return existing;
      }
    }
  }
  return null;
}

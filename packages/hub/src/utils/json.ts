export function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn("[parseJsonSafe] malformed JSON, using fallback:", error);
    return fallback;
  }
}

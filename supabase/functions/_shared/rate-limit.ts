export function createUserRateLimiter(limit: number, now = Date.now) {
  const windows = new Map<string, { until: number; count: number }>();
  return (userId: string): boolean => {
    const time = now();
    const previous = windows.get(userId);
    if (previous && previous.until > time) {
      if (previous.count >= limit) return false;
      previous.count++;
      return true;
    }
    if (windows.size >= 5_000) {
      for (const [id, window] of windows) if (window.until <= time) windows.delete(id);
      if (windows.size >= 5_000) return false;
    }
    windows.set(userId, { until: time + 60_000, count: 1 });
    return true;
  };
}

export function closeStoresIndependently(...closers: Array<() => void>): unknown[] {
  const errors: unknown[] = [];
  for (const close of closers) {
    try { close(); } catch (error) { errors.push(error); }
  }
  return errors;
}

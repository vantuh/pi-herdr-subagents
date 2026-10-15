let panePlacementQueue: Promise<void> = Promise.resolve();

export async function acquirePanePlacementLock(): Promise<() => void> {
  const previous = panePlacementQueue;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  panePlacementQueue = previous.then(() => current);
  await previous;
  return release;
}

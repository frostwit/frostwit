// Public shape of a graph: only thief-address mode may say "thieves"; every other mode publishes firstReceivers (not an accusation).
export function publicSeed(kind, seed) {
  if (kind === 'address') return seed;
  const { thieves, ...rest } = seed; return { ...rest, firstReceivers: thieves || [] };
}
export function publicNodes(kind, nodes) {
  return (nodes || []).map((n) => (n.label === 'thief' ? (kind === 'address' ? { ...n, role: 'thief' } : { ...n, label: 'receiver', role: 'first_receiver' }) : n));
}
export const publicGraph = (kind, g) => ({ ...g, seed: publicSeed(kind, g.seed), nodes: publicNodes(kind, g.nodes) });

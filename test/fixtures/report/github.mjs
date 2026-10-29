// Network boundary for the real collector CLI: synthetic public API records only.
const pull = { number: 10, title: 'feat: Synthetic update', labels: [], body: '## User Impact\n\nA synthetic update can be reviewed.', merged_at: '2026-10-27T01:00:00Z' };
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.origin !== 'https://api.github.com') throw new Error('Unexpected external request');
  const path = u.pathname;
  let data;
  if (path.endsWith('/releases')) data = [{ published_at: '2026-10-27T02:00:00Z', body: '### Highlights\n- Synthetic update. (#10)' }];
  else if (path.endsWith('/pulls')) data = u.searchParams.get('state') === 'closed' ? [pull] : [];
  else if (path.endsWith('/issues')) data = [];
  else throw new Error('Unexpected GitHub request');
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
};

// Walk a FHIR search result by following Bundle.link[relation=next] until the
// server stops offering one. The next link is opaque (HAPI's is a _getpages
// cursor token, not an offset), so it is followed verbatim, never rebuilt from
// _count/_offset arithmetic, and `total` is never trusted to decide when to stop.

export async function* paginate(client, url, { maxPages = Infinity } = {}) {
  const visited = new Set();
  let next = url;
  for (let page = 1; next && page <= maxPages; page++) {
    if (visited.has(next)) throw new Error(`Pagination loop: server repeated a next link (${next})`);
    visited.add(next);
    const bundle = await client.getJson(next);
    if (bundle?.resourceType !== 'Bundle') {
      throw new Error(`Expected a Bundle from ${next}, got ${bundle?.resourceType ?? typeof bundle}`);
    }
    yield { page, bundle, url: next };
    const link = bundle.link?.find((l) => l.relation === 'next')?.url;
    // Some servers send relative links; resolve against the page we just read.
    next = link ? new URL(link, next).toString() : null;
  }
}

/** Split a searchset page into resources and the OperationOutcomes servers attach as warnings. */
export function entriesOf(bundle) {
  const resources = [];
  const outcomes = [];
  for (const entry of bundle.entry ?? []) {
    if (!entry.resource) continue;
    if (entry.search?.mode === 'outcome' || entry.resource.resourceType === 'OperationOutcome') outcomes.push(entry.resource);
    else resources.push(entry.resource);
  }
  return { resources, outcomes };
}

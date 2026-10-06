/**
 * Terminals authenticate with a shared secret in the query string
 * (`/iclock/cdata?SN=...&key=...`), so any logged URL or query object would
 * otherwise carry a credential that lets its reader impersonate the device.
 */
const SECRET_PARAMS = new Set(['key', 'secret']);

export function redactUrlSecrets(url) {
  if (typeof url !== 'string' || !url.includes('?')) return url;
  const [path, search] = url.split('?', 2);
  const params = new URLSearchParams(search);
  let changed = false;
  for (const name of [...params.keys()]) {
    if (SECRET_PARAMS.has(name.toLowerCase())) {
      params.set(name, '[redacted]');
      changed = true;
    }
  }
  return changed ? `${path}?${params.toString()}` : url;
}

export function redactQuerySecrets(query) {
  if (!query || typeof query !== 'object') return query;
  const out = { ...query };
  for (const name of Object.keys(out)) {
    if (SECRET_PARAMS.has(name.toLowerCase())) out[name] = '[redacted]';
  }
  return out;
}

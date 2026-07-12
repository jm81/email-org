async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const api = {
  accounts: () => req('GET', '/api/accounts'),
  createAccount: (b) => req('POST', '/api/accounts', b),
  updateAccount: (id, b) => req('PUT', `/api/accounts/${id}`, b),
  deleteAccount: (id) => req('DELETE', `/api/accounts/${id}`),
  testAccount: (b) => req('POST', '/api/accounts/test', b),
  syncAccount: (id) => req('POST', `/api/accounts/${id}/sync`),
  folders: (id) => req('GET', `/api/accounts/${id}/folders`),
  createFolder: (b) => req('POST', '/api/folders', b),
  deleteFolder: (id, force) => req('DELETE', `/api/folders/${id}${force ? '?force=1' : ''}`),
  renameFolder: (id, name) => req('POST', `/api/folders/${id}/rename`, { name }),
  syncFolder: (id) => req('POST', `/api/folders/${id}/sync`),
  flatten: (id) => req('POST', `/api/folders/${id}/flatten`),
  scanRedundant: (id) => req('POST', `/api/folders/${id}/scan-redundant`),
  setDone: (id, done) => req('POST', `/api/folders/${id}/done`, { done }),
  messages: (id, sort, page) => {
    const q = new URLSearchParams();
    if (sort) { q.set('sort', sort.key); q.set('dir', sort.dir); }
    if (page?.limit != null) q.set('limit', page.limit);
    if (page?.offset) q.set('offset', page.offset);
    const qs = q.toString();
    return req('GET', `/api/folders/${id}/messages${qs ? `?${qs}` : ''}`);
  },
  body: (id, mode) => req('GET', `/api/messages/${id}/body?mode=${mode}`),
  deleteMessages: (ids) => req('POST', '/api/messages/delete', { messageIds: ids }),
  moveMessages: (ids, targetFolderId) => req('POST', '/api/messages/move', { messageIds: ids, targetFolderId }),
  job: (id) => req('GET', `/api/jobs/${id}`),
};

export async function pollJob(jobId, onProgress) {
  for (;;) {
    const job = await api.job(jobId);
    onProgress?.(job);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 500));
  }
}

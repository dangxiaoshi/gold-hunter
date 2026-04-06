(function attachGhApiHelpers(global) {
  function resolveApiUrl(path) {
    const base = localStorage.getItem('gh2_api_base') || location.origin;
    return base.replace(/\/$/, '') + path;
  }

  function apiFetch(url, opts = {}) {
    const token = localStorage.getItem('gh2_token') || '';
    const headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
    return fetch(resolveApiUrl(url), { ...opts, headers }).then(response => {
      if (response.status === 401) {
        localStorage.removeItem('gh2_auth');
        localStorage.removeItem('gh2_token');
        try {
          window.parent.postMessage({ action: 'authExpired' }, '*');
        } catch (error) {
          // ignore cross-window errors
        }
        throw new Error('unauthorized');
      }
      return response;
    });
  }

  global.GHApi = {
    resolveApiUrl,
    apiFetch,
  };
})(window);

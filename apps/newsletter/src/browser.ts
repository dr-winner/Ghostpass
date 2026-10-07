import { byId, explain, setupMerchantPage, when } from '@ghostpass/demo-web/browser';

const status = byId('session-status');
const button = byId('open-session');

try {
  const { client, refresh } = await setupMerchantPage();
  button.addEventListener('click', async () => {
    button.setAttribute('disabled', '');
    try {
      const r = await client.ghostFetch('/session/start', { method: 'POST' });
      const body = await r.json() as { ok?: boolean; expiresAt?: number; error?: string };
      if (r.ok && body.expiresAt) {
        status.replaceChildren(`Session open until ${when(body.expiresAt)}. `, Object.assign(document.createElement('a'), { href: '/', textContent: 'Read the posts' }));
      } else {
        status.textContent = `The server refused the token (${body.error ?? r.status}).`;
      }
    } catch (error) {
      status.textContent = explain(error);
    } finally {
      button.removeAttribute('disabled');
      await refresh();
    }
  });
} catch (error) {
  status.textContent = explain(error);
}

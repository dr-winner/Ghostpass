import { formatAuthorization } from '@ghostpass/core';
import { byId, explain, setupMerchantPage } from '@ghostpass/demo-web/browser';

const status = byId('call-status');
const output = byId('output');
const call = byId('call');
const exporter = byId('export');

function show(text: string) {
  output.textContent = text;
  output.hidden = false;
}

try {
  const { client, refresh } = await setupMerchantPage();
  call.addEventListener('click', async () => {
    call.setAttribute('disabled', '');
    try {
      const r = await client.ghostFetch('/api/v1/price');
      status.textContent = `HTTP ${r.status}`;
      show(JSON.stringify(await r.json(), null, 2));
    } catch (error) {
      status.textContent = explain(error);
    } finally {
      call.removeAttribute('disabled');
      await refresh();
    }
  });
  exporter.addEventListener('click', async () => {
    try {
      const token = await client.takeToken();
      status.textContent = 'This token was removed from the browser. It works once; run the command twice to see the replay rejected.';
      show(`curl -i -H 'Authorization: ${formatAuthorization(token)}' ${location.origin}/api/v1/price`);
    } catch (error) {
      status.textContent = explain(error);
    } finally {
      await refresh();
    }
  });
} catch (error) {
  status.textContent = explain(error);
}

import { config } from './config.js';

// List the model ids the current virtual key is allow-listed for on LiteLLM.
// Use this before setting CLAUDE_MODEL in .env — the allow-list uses LiteLLM's
// own naming and changes without warning (that's what silently broke
// classification in 2026-10). No Lark auth, no identity check — standalone
// probe you can run anytime: `npm run probe-models`.

async function main() {
  const { anthropicApiKey: apiKey, anthropicBaseUrl: baseUrl } = config;
  if (!apiKey || !baseUrl) {
    console.error('ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL must both be set in .env.');
    process.exit(1);
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
  let resp;
  try {
    resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (err) {
    console.error(`Network error reaching ${url}: ${err.cause?.code || err.message}`);
    console.error('(Company VPN often breaks this host — try off-VPN.)');
    process.exit(1);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error(`${resp.status} ${resp.statusText} from ${url}`);
    if (body) console.error(body.slice(0, 1000));
    process.exit(1);
  }

  const data = await resp.json();
  const ids = (data.data || []).map((m) => m.id).sort();
  if (!ids.length) {
    console.error('Empty allow-list — the key is valid but has no models attached. Ask IT.');
    process.exit(1);
  }

  console.log(`Models your key can call on ${baseUrl}:`);
  for (const id of ids) console.log(`  ${id}`);
  console.log(`\nSet one of these as CLAUDE_MODEL in .env (current: ${config.model}).`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

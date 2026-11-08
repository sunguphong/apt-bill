// Cloudflare Worker: 브라우저 → (이 프록시) → Claude API
// 실제 API 키는 Worker 비밀값(ANTHROPIC_API_KEY)에만 두고, 브라우저에는 노출하지 않는다.
// 필요한 비밀값/변수
//   ANTHROPIC_API_KEY : Claude API 키 (wrangler secret put ANTHROPIC_API_KEY)
//   APP_PASSCODE      : 앱 설정의 'API 키' 칸에 넣을 접속 암호 (wrangler secret put APP_PASSCODE)
//   ALLOWED_ORIGIN    : 앱 주소, 예) https://apt-bill.pages.dev  (wrangler.toml [vars])

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (origin !== allowed) return new Response('forbidden origin', { status: 403, headers: cors });

    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') return new Response('not found', { status: 404, headers: cors });
    if (!env.APP_PASSCODE || req.headers.get('x-api-key') !== env.APP_PASSCODE) return new Response('unauthorized', { status: 401, headers: cors });

    const headers = new Headers();
    for (const [k, v] of req.headers) if (k.startsWith('anthropic-') || k === 'content-type') headers.set(k, v);
    headers.delete('anthropic-dangerous-direct-browser-access');
    headers.set('x-api-key', env.ANTHROPIC_API_KEY);

    const upstream = await fetch('https://api.anthropic.com/v1/messages' + url.search, { method: 'POST', headers, body: req.body });
    const out = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};

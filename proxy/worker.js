// Cloudflare Worker: 우리집 관리비 백엔드
//  - POST /v1/messages      → Claude API 프록시 (실제 API 키는 여기에만 있음)
//  - /api/bills, /api/images → 관리비 기록(D1) · 원본 이미지(KV) 저장소
// 모든 요청은 앱 주소(ALLOWED_ORIGIN)에서 + x-api-key 헤더에 APP_PASSCODE 를 넣어야 통과한다.
// 바인딩: DB(D1), IMAGES(KV) · 비밀값: ANTHROPIC_API_KEY, APP_PASSCODE

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
    const text = (msg, status) => new Response(msg, { status, headers: cors });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (origin !== env.ALLOWED_ORIGIN) return text('forbidden origin', 403);
    if (!env.APP_PASSCODE || req.headers.get('x-api-key') !== env.APP_PASSCODE) return text('unauthorized', 401);

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ---- Claude API 프록시 ----
      if (path === '/v1/messages' && req.method === 'POST') {
        const headers = new Headers();
        for (const [k, v] of req.headers) if (k.startsWith('anthropic-') || k === 'content-type') headers.set(k, v);
        headers.delete('anthropic-dangerous-direct-browser-access');
        headers.set('x-api-key', env.ANTHROPIC_API_KEY);
        const upstream = await fetch('https://api.anthropic.com/v1/messages' + url.search, { method: 'POST', headers, body: req.body });
        const out = new Headers(upstream.headers);
        for (const [k, v] of Object.entries(cors)) out.set(k, v);
        return new Response(upstream.body, { status: upstream.status, headers: out });
      }

      // ---- 연결 확인 (요금 없음: Models API 조회만 함) ----
      if (path === '/api/check' && req.method === 'GET') {
        const model = url.searchParams.get('model') || 'claude-opus-5-5';
        const out = { passcode: { ok: true } };
        try {
          const r = await fetch('https://api.anthropic.com/v1/models/' + encodeURIComponent(model), {
            headers: { 'x-api-key': env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
          });
          let message = '';
          if (!r.ok) { try { message = (await r.json())?.error?.message || ''; } catch {} }
          out.apiKey = { ok: r.status !== 401 && r.status !== 403, status: r.status, message, configured: !!env.ANTHROPIC_API_KEY };
          out.model = { ok: r.ok, status: r.status, id: model };
        } catch (e) {
          out.apiKey = { ok: false, status: 0, message: String(e?.message || e) };
          out.model = { ok: false, status: 0, id: model };
        }
        try { await env.DB.prepare('SELECT 1').first(); await env.IMAGES.get('__check__'); out.storage = { ok: true }; }
        catch (e) { out.storage = { ok: false, message: String(e?.message || e) }; }
        return json(out);
      }

      // ---- 관리비 기록 ----
      if (path === '/api/bills' && req.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT data FROM bills ORDER BY id').all();
        return json(results.map(r => JSON.parse(r.data)));
      }
      if (path === '/api/bills' && req.method === 'DELETE') {   // 전체 삭제
        const { results } = await env.DB.prepare('SELECT id FROM bills').all();
        await env.DB.prepare('DELETE FROM bills').run();
        await Promise.all(results.map(r => env.IMAGES.delete('img:' + r.id)));
        return json({ ok: true, deleted: results.length });
      }
      let m = path.match(/^\/api\/bills\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!YM.test(id)) return text('bad id', 400);
        if (req.method === 'GET') {
          const row = await env.DB.prepare('SELECT data FROM bills WHERE id = ?').bind(id).first();
          return row ? json(JSON.parse(row.data)) : json(null, 404);
        }
        if (req.method === 'PUT') {
          const bill = await req.json();
          if (!bill || bill.yearMonth !== id || !Array.isArray(bill.items)) return text('bad bill', 400);
          await env.DB.prepare('INSERT INTO bills (id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = ?3')
            .bind(id, JSON.stringify({ ...bill, id }), new Date().toISOString()).run();
          return json({ ok: true });
        }
        if (req.method === 'DELETE') {
          await env.DB.prepare('DELETE FROM bills WHERE id = ?').bind(id).run();
          await env.IMAGES.delete('img:' + id);
          return json({ ok: true });
        }
      }

      // ---- 원본 이미지 ----
      m = path.match(/^\/api\/images\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!YM.test(id)) return text('bad id', 400);
        if (req.method === 'GET') return json((await env.IMAGES.get('img:' + id, 'json')) || []);
        if (req.method === 'PUT') {
          const images = await req.json();
          if (!Array.isArray(images)) return text('bad images', 400);
          if (images.length) await env.IMAGES.put('img:' + id, JSON.stringify(images));
          else await env.IMAGES.delete('img:' + id);
          return json({ ok: true });
        }
      }

      return text('not found', 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },
};

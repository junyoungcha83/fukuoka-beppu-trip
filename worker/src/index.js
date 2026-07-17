// fukuoka-beppu-trip 데이터 동기화 API
// - GET  /api/data  : 공용 읽기
// - PUT  /api/data  : X-Edit-Token 헤더가 EDIT_TOKEN 과 일치 시 KV 저장
//
// KV binding: TRIP (단일 키 "trip-data")
// Secret: EDIT_TOKEN

const KEY = 'trip-data';
const MAX_BYTES = 8 * 1024 * 1024;        // 8MB (KV 데이터)
const MAX_ATT_BYTES = 20 * 1024 * 1024;   // 20MB (R2 첨부 1개)

const ALLOWED_ORIGINS = [
  'https://junyoungcha83.github.io',
  'http://localhost:8000',
  'http://localhost:8001',
  'http://localhost:8002',
  'http://127.0.0.1:8000',
];

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function isValidShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  return Array.isArray(parsed.entries);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === '/api/data') {
      if (req.method === 'GET') {
        const raw = await env.TRIP.get(KEY);
        return new Response(raw || JSON.stringify({ version: 1, entries: [] }), {
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      if (req.method === 'PUT') {
        const token = req.headers.get('X-Edit-Token') || '';
        if (!env.EDIT_TOKEN || token !== env.EDIT_TOKEN) {
          return json({ error: 'unauthorized' }, 401, cors);
        }
        const body = await req.text();
        if (body.length > MAX_BYTES) {
          return json({ error: 'too_large', limit: MAX_BYTES, size: body.length }, 413, cors);
        }
        let parsed;
        try { parsed = JSON.parse(body); }
        catch { return json({ error: 'invalid_json' }, 400, cors); }
        if (!isValidShape(parsed)) {
          return json({ error: 'invalid_shape' }, 400, cors);
        }
        await env.TRIP.put(KEY, body);
        return json({ ok: true, bytes: body.length }, 200, cors);
      }

      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    // ── 첨부파일 (R2) : /api/attach(목록) · /api/attach/:id ──
    if (url.pathname === '/api/attach' || url.pathname.startsWith('/api/attach/')) {
      const id = url.pathname === '/api/attach' ? '' : decodeURIComponent(url.pathname.slice('/api/attach/'.length));

      // 목록(공개) — blob 없이 메타만
      if (req.method === 'GET' && !id) {
        const list = await env.ATT.list({ prefix: 'att/', include: ['customMetadata'] });
        const items = (list.objects || []).map(o => {
          const m = o.customMetadata || {};
          return {
            id: o.key.slice(4),
            entryId: m.entryId || '',
            name: m.name ? decodeURIComponent(m.name) : '',
            type: m.type || (o.httpMetadata && o.httpMetadata.contentType) || '',
            size: o.size,
            created_at: m.created_at || '',
          };
        });
        return json({ items }, 200, cors);
      }

      // 개별 다운로드(공개)
      if (req.method === 'GET' && id) {
        const obj = await env.ATT.get('att/' + id);
        if (!obj) return new Response('Not Found', { status: 404, headers: cors });
        const m = obj.customMetadata || {};
        const name = m.name ? decodeURIComponent(m.name) : id;
        return new Response(obj.body, {
          headers: {
            ...cors,
            'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || m.type || 'application/octet-stream',
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
            'Cache-Control': 'public, max-age=604800',
          },
        });
      }

      // 쓰기(인증)
      const token = req.headers.get('X-Edit-Token') || '';
      if (!env.EDIT_TOKEN || token !== env.EDIT_TOKEN) return json({ error: 'unauthorized' }, 401, cors);

      if (req.method === 'PUT' && id) {
        const buf = await req.arrayBuffer();
        if (buf.byteLength > MAX_ATT_BYTES) {
          return json({ error: 'too_large', limit: MAX_ATT_BYTES, size: buf.byteLength }, 413, cors);
        }
        const type = req.headers.get('Content-Type') || 'application/octet-stream';
        await env.ATT.put('att/' + id, buf, {
          httpMetadata: { contentType: type },
          customMetadata: {
            entryId: url.searchParams.get('entryId') || '',
            name: encodeURIComponent(url.searchParams.get('name') || ''),
            type,
            created_at: new Date().toISOString(),
          },
        });
        return json({ ok: true, id, size: buf.byteLength }, 200, cors);
      }

      if (req.method === 'DELETE' && id) {
        await env.ATT.delete('att/' + id);
        return json({ ok: true }, 200, cors);
      }

      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({ ok: true, service: 'fukuoka-beppu-trip-api' }, 200, cors);
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};

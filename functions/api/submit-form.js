// Cloudflare Pages Function: POST /api/submit-form
// Validates Turnstile, then sends contact email via Resend.
// Runs on the Workers runtime — only Web APIs available, no npm dependencies.

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'PR Tax Consultants <noreply@prtaxconsultants.com>';

const LIMITS = {
  nombre: { min: 2, max: 100 },
  email: { max: 254 },
  telefono: { max: 40 },
  servicio: { max: 100 },
  mensaje: { min: 5, max: 5000 },
  token: { max: 4096 },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function bad(message, status = 400) {
  return json(status, { ok: false, message });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

async function readBody(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('application/json')) {
    const data = await request.json();
    if (data === null || typeof data !== 'object') return {};
    return data;
  }

  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    const form = await request.formData();
    const out = {};
    for (const [k, v] of form.entries()) out[k] = typeof v === 'string' ? v : '';
    return out;
  }

  // Fallback: try JSON, then return empty
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function pickString(value, maxLen) {
  if (typeof value !== 'string') return '';
  // Strip control characters except tab/newline; trim outer whitespace.
  const cleaned = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function validate(data) {
  const nombre = pickString(data.nombre, LIMITS.nombre.max);
  const email = pickString(data.email, LIMITS.email.max);
  const telefono = pickString(data.telefono, LIMITS.telefono.max);
  const servicio = pickString(data.servicio, LIMITS.servicio.max);
  const mensaje = pickString(data.mensaje, LIMITS.mensaje.max);
  const token = pickString(data.turnstile_token, LIMITS.token.max);

  if (nombre.length < LIMITS.nombre.min) {
    return { error: 'El nombre debe tener al menos 2 caracteres.' };
  }
  if (!email || !EMAIL_RE.test(email)) {
    return { error: 'Email inválido.' };
  }
  if (mensaje.length < LIMITS.mensaje.min) {
    return { error: 'El mensaje debe tener al menos 5 caracteres.' };
  }
  if (!token) {
    return { error: 'Verificación de seguridad requerida.', status: 400 };
  }

  return { fields: { nombre, email, telefono, servicio, mensaje, token } };
}

async function verifyTurnstile(token, secret, remoteIp) {
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (remoteIp) body.append('remoteip', remoteIp);

  const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body });
  if (!res.ok) {
    console.error('[submit-form] Turnstile siteverify HTTP error:', res.status);
    return { success: false };
  }
  try {
    const data = await res.json();
    if (!data.success) {
      console.error('[submit-form] Turnstile rejected:', JSON.stringify(data['error-codes'] || []));
    }
    return { success: Boolean(data.success), data };
  } catch (err) {
    console.error('[submit-form] Turnstile JSON parse failed:', err && err.message);
    return { success: false };
  }
}

function buildEmail({ nombre, email, telefono, servicio, mensaje }) {
  const servicioDisplay = servicio || 'Sin especificar';
  const telefonoDisplay = telefono || 'No proporcionado';
  const subject = `Nueva consulta de ${nombre} — ${servicioDisplay}`;

  const text = [
    'Nueva consulta desde el sitio web',
    '',
    `Nombre:    ${nombre}`,
    `Email:     ${email}`,
    `Teléfono:  ${telefonoDisplay}`,
    `Servicio:  ${servicioDisplay}`,
    '',
    'Mensaje:',
    mensaje,
    '',
    '— Enviado desde prtaxconsultants.com',
  ].join('\n');

  const html = `<!doctype html>
<html lang="es">
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0a0b;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e4e4e7;overflow:hidden;">
    <tr>
      <td style="background:#0a0a0b;padding:20px 28px;">
        <div style="color:#00F7FF;font-size:12px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;">PR Tax Consultants</div>
        <div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:4px;">Nueva consulta del sitio web</div>
      </td>
    </tr>
    <tr>
      <td style="padding:24px 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;line-height:1.55;">
          <tr><td style="padding:6px 0;color:#6b7280;width:110px;">Nombre</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(nombre)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="padding:6px 0;"><a href="mailto:${escapeHtml(email)}" style="color:#0369a1;text-decoration:none;">${escapeHtml(email)}</a></td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Teléfono</td><td style="padding:6px 0;">${escapeHtml(telefonoDisplay)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Servicio</td><td style="padding:6px 0;">${escapeHtml(servicioDisplay)}</td></tr>
        </table>
        <div style="margin-top:20px;padding-top:20px;border-top:1px solid #e4e4e7;">
          <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;">Mensaje</div>
          <div style="font-size:15px;line-height:1.6;color:#0a0a0b;white-space:pre-wrap;">${nl2br(mensaje)}</div>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 28px;background:#f9fafb;border-top:1px solid #e4e4e7;font-size:12px;color:#6b7280;">
        Enviado desde <a href="https://prtaxconsultants.com" style="color:#6b7280;">prtaxconsultants.com</a>. Responde a este correo para contactar directamente al cliente.
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

async function sendEmail({ apiKey, to, replyTo, subject, html, text }) {
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: Array.isArray(to) ? to : [to],
      reply_to: replyTo,
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    let body = '';
    try { body = JSON.stringify(await res.json()); } catch { body = await res.text().catch(() => ''); }
    console.error('[submit-form] Resend error:', res.status, body);
    throw new Error(`Resend ${res.status}`);
  }

  return res.json().catch(() => ({}));
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.RESEND_API_KEY || !env.TURNSTILE_SECRET_KEY || !env.CONTACT_EMAIL_TO) {
      console.error('[submit-form] missing required env bindings');
      return bad('Servicio no disponible temporalmente. Por favor llámanos al (939) 272-4488.', 500);
    }

    const data = await readBody(request).catch(() => ({}));
    const result = validate(data);
    if (result.error) return bad(result.error, result.status || 422);

    const { nombre, email, telefono, servicio, mensaje, token } = result.fields;

    const remoteIp = request.headers.get('cf-connecting-ip') || '';
    const verify = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, remoteIp);
    if (!verify.success) {
      return bad('Verificación de seguridad falló. Recarga la página e intenta de nuevo.', 403);
    }

    const { subject, html, text } = buildEmail({ nombre, email, telefono, servicio, mensaje });

    try {
      await sendEmail({
        apiKey: env.RESEND_API_KEY,
        to: env.CONTACT_EMAIL_TO,
        replyTo: email,
        subject,
        html,
        text,
      });
    } catch (err) {
      console.error('[submit-form] Resend send failed:', err && err.message ? err.message : err);
      return bad(
        'Error al enviar la consulta. Por favor llámanos al (939) 272-4488 mientras resolvemos.',
        500
      );
    }

    return json(200, {
      ok: true,
      message: 'Tu consulta fue enviada. Te contactaremos en 24 horas hábiles.',
    });
  } catch (err) {
    console.error('[submit-form] unexpected error:', err && err.message ? err.message : err);
    return bad('Error al procesar la solicitud. Intenta de nuevo en unos momentos.', 500);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { 'allow': 'POST', 'content-type': 'text/plain; charset=utf-8' },
  });
}

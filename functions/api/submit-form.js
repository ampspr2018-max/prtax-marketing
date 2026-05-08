// DEBUG MODE: verbose error responses. Remove debug fields after diagnosing the issue.
// Cloudflare Pages Function: POST /api/submit-form
// Validates Turnstile, then sends contact email via Resend.
// Runs on the Workers runtime — only Web APIs available, no npm dependencies.

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'PR Tax Consultants <noreply@send.prtaxconsultants.com>';

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

function debugFlags(env) {
  return {
    has_resend_key: Boolean(env && env.RESEND_API_KEY),
    has_turnstile_secret: Boolean(env && env.TURNSTILE_SECRET_KEY),
    has_contact_email: Boolean(env && env.CONTACT_EMAIL_TO),
  };
}

function truncate(value, max = 500) {
  if (value == null) return '';
  let str;
  if (typeof value === 'string') {
    str = value;
  } else {
    try { str = JSON.stringify(value); } catch { str = String(value); }
  }
  return str.length > max ? str.slice(0, max) : str;
}

function bad(message, status, stage, detail, env) {
  return json(status, {
    ok: false,
    message,
    error_stage: stage,
    error_detail: truncate(detail),
    debug_env: debugFlags(env),
  });
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
  const status = res.status;
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  const success = Boolean(res.ok && data && data.success);
  return { success, status, data };
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

  let parsedBody = null;
  let rawBody = '';
  try {
    rawBody = await res.text();
    if (rawBody) {
      try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = null; }
    }
  } catch {
    rawBody = '';
  }

  return { ok: res.ok, status: res.status, body: parsedBody, rawBody };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // env_check
    const missing = [];
    if (!env || !env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
    if (!env || !env.TURNSTILE_SECRET_KEY) missing.push('TURNSTILE_SECRET_KEY');
    if (!env || !env.CONTACT_EMAIL_TO) missing.push('CONTACT_EMAIL_TO');
    if (missing.length) {
      console.error('submit-form: missing required env bindings', missing);
      return bad(
        'Servicio no disponible temporalmente. Por favor llámanos al (939) 272-4488.',
        500,
        'env_check',
        `Missing env vars: ${missing.join(', ')}`,
        env
      );
    }

    // parse_body
    let data;
    try {
      data = await readBody(request);
    } catch (err) {
      return bad(
        'No pudimos leer la solicitud. Intenta de nuevo.',
        400,
        'parse_body',
        `${err && err.name ? err.name + ': ' : ''}${err && err.message ? err.message : String(err)}`,
        env
      );
    }

    // validation
    const result = validate(data);
    if (result.error) {
      return bad(result.error, result.status || 422, 'validation', result.error, env);
    }

    const { nombre, email, telefono, servicio, mensaje, token } = result.fields;

    // turnstile_verify
    const remoteIp = request.headers.get('cf-connecting-ip') || '';
    let verify;
    try {
      verify = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, remoteIp);
    } catch (err) {
      return bad(
        'Verificación de seguridad falló. Recarga la página e intenta de nuevo.',
        403,
        'turnstile_verify',
        `fetch threw: ${err && err.name ? err.name + ': ' : ''}${err && err.message ? err.message : String(err)}`,
        env
      );
    }
    if (!verify.success) {
      const codes = verify.data && verify.data['error-codes'];
      const detail = `siteverify status=${verify.status} success=${Boolean(verify.data && verify.data.success)} error-codes=${JSON.stringify(codes || [])}`;
      return bad(
        'Verificación de seguridad falló. Recarga la página e intenta de nuevo.',
        403,
        'turnstile_verify',
        detail,
        env
      );
    }

    const { subject, html, text } = buildEmail({ nombre, email, telefono, servicio, mensaje });

    // resend_send
    let sendResult;
    try {
      sendResult = await sendEmail({
        apiKey: env.RESEND_API_KEY,
        to: env.CONTACT_EMAIL_TO,
        replyTo: email,
        subject,
        html,
        text,
      });
    } catch (err) {
      console.error('submit-form: Resend fetch threw', err && err.message ? err.message : err);
      return bad(
        'Error al enviar la consulta. Por favor llámanos al (939) 272-4488 mientras resolvemos.',
        500,
        'resend_send',
        `fetch threw: ${err && err.name ? err.name + ': ' : ''}${err && err.message ? err.message : String(err)}`,
        env
      );
    }

    if (!sendResult.ok) {
      const detailPayload = sendResult.body != null ? sendResult.body : sendResult.rawBody;
      const detail = `Resend status=${sendResult.status} body=${truncate(detailPayload, 400)}`;
      console.error('submit-form: Resend rejected', detail);
      return bad(
        'Error al enviar la consulta. Por favor llámanos al (939) 272-4488 mientras resolvemos.',
        500,
        'resend_send',
        detail,
        env
      );
    }

    return json(200, {
      ok: true,
      message: 'Tu consulta fue enviada. Te contactaremos en 24 horas hábiles.',
    });
  } catch (err) {
    console.error('submit-form: unexpected error', err && err.message ? err.message : err);
    const detail = `${err && err.name ? err.name : 'Error'}: ${err && err.message ? err.message : String(err)}`;
    return bad(
      'Error al procesar la solicitud. Intenta de nuevo en unos momentos.',
      500,
      'unexpected',
      detail,
      env
    );
  }
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { 'allow': 'POST', 'content-type': 'text/plain; charset=utf-8' },
  });
}

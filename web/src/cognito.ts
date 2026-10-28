// Inicio de sesión con Amazon Cognito (página de inicio de sesión de Cognito + código con PKCE).
// Solo se activa cuando el build recibe VITE_COGNITO_DOMAIN y VITE_COGNITO_CLIENT_ID (lo hace el
// pipeline de despliegue). En local siguen funcionando /auth/dev-login y el formulario de siempre.
const DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN as string | undefined; // https://<prefijo>.auth.us-east-1.amazoncognito.com
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const KEY = 'streamnote.pkce';

export const cognitoEnabled = Boolean(DOMAIN && CLIENT_ID);

const redirectUri = () => `${window.location.origin}/`;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Lleva al usuario a la página de Cognito (correo y contraseña, o Google si está configurado). */
export async function startLogin(): Promise<void> {
  const verifier = random(32);
  const state = random(16);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ verifier, state }));
  } catch {
    /* sin almacenamiento no se puede completar el flujo; Cognito devolverá un error */
  }
  const url = new URL(`${DOMAIN}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID!,
    redirect_uri: redirectUri(),
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  window.location.assign(url.toString());
}

/** Cambia el código que devolvió Cognito por el ID token (JWT) que valida la API. */
export async function finishLogin(code: string, state: string | null): Promise<string> {
  let saved: { verifier: string; state: string } | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    sessionStorage.removeItem(KEY);
  } catch {
    saved = null;
  }
  if (!saved || saved.state !== state) throw new Error('El inicio de sesión caducó. Vuelve a intentarlo.');
  const res = await fetch(`${DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID!,
      code,
      redirect_uri: redirectUri(),
      code_verifier: saved.verifier,
    }),
  });
  if (!res.ok) throw new Error('Cognito rechazó el inicio de sesión. Vuelve a intentarlo.');
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new Error('Cognito no devolvió un token.');
  return data.id_token;
}

/** Cierra también la sesión de Cognito, para que «Entrar» vuelva a pedir la cuenta. */
export function logoutUrl(): string | null {
  if (!cognitoEnabled) return null;
  const url = new URL(`${DOMAIN}/logout`);
  url.search = new URLSearchParams({ client_id: CLIENT_ID!, logout_uri: redirectUri() }).toString();
  return url.toString();
}

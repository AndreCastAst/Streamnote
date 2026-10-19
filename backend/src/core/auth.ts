// Autenticación.
// Local: /auth/dev-login emite un JWT HS256 (simula el inicio de sesión con Google de Cognito).
// AWS:   el JWT lo emite Cognito; se valida contra su JWKS. API Gateway ya lo valida antes,
//        pero se vuelve a validar aquí para no depender de la configuración del autorizador.
import { SignJWT, jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import type { Config } from '../config.js';
import type { Db } from './db.js';
import type { AuthUser } from './http.js';

export class Auth {
  private secret: Uint8Array;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private cache = new Map<string, AuthUser>();

  constructor(private cfg: Config, private db: Db) {
    this.secret = new TextEncoder().encode(cfg.auth.jwtSecret);
    if (cfg.auth.mode === 'cognito') {
      this.jwks = createRemoteJWKSet(new URL(`${cfg.auth.cognitoIssuer}/.well-known/jwks.json`));
    }
  }

  async issueLocalToken(user: AuthUser): Promise<string> {
    return new SignJWT({ email: user.email, name: user.name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(this.secret);
  }

  async verify(token: string | undefined | null): Promise<AuthUser | null> {
    if (!token) return null;
    try {
      if (this.cfg.auth.mode === 'local') {
        const { payload } = await jwtVerify(token, this.secret);
        return { id: payload.sub!, email: String(payload.email), name: String(payload.name) };
      }
      const { payload } = await jwtVerify(token, this.jwks!, { issuer: this.cfg.auth.cognitoIssuer });
      if (payload.client_id !== this.cfg.auth.cognitoClientId && payload.aud !== this.cfg.auth.cognitoClientId) return null;
      return this.fromCognito(payload);
    } catch {
      return null;
    }
  }

  /** Con Cognito, el usuario se crea en la primera petición (equivale al dev-login local). */
  private async fromCognito(p: JWTPayload): Promise<AuthUser> {
    const externalId = `cognito:${p.sub}`;
    const cached = this.cache.get(externalId);
    if (cached) return cached;
    const email = String(p.email ?? `${p.sub}@cognito`);
    const name = String(p.name ?? email.split('@')[0]);
    const row = await this.db.one<{ id: string; email: string; display_name: string }>(
      `INSERT INTO users (external_id, email, display_name) VALUES (:externalId, :email, :name)
       ON CONFLICT (external_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, email, display_name`,
      { externalId, email, name },
    );
    const user = { id: row!.id, email: row!.email, name: row!.display_name };
    this.cache.set(externalId, user);
    return user;
  }
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

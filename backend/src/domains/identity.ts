import { z } from 'zod';
import { route, notFound, requireUser } from '../core/http.js';

const DevLogin = z.object({
  email: z.string().trim().toLowerCase().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Correo no válido'),
  name: z.string().trim().min(1).max(60),
});

export const identityRoutes = [
  // Solo en local: reemplaza el inicio de sesión con Google de Cognito
  route({
    method: 'POST',
    path: '/auth/dev-login',
    auth: 'none',
    body: DevLogin,
    async handler(req, { db, auth, cfg }) {
      if (cfg.auth.mode !== 'local') throw notFound();
      const { email, name } = req.body as z.infer<typeof DevLogin>;
      const row = await db.one<{ id: string; email: string; display_name: string }>(
        `INSERT INTO users (external_id, email, display_name) VALUES (:externalId, :email, :name)
         ON CONFLICT (external_id) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id, email, display_name`,
        { externalId: `local:${email}`, email, name },
      );
      const user = { id: row!.id, email: row!.email, name: row!.display_name };
      return { token: await auth.issueLocalToken(user), user };
    },
  }),

  route({
    method: 'GET',
    path: '/me',
    auth: 'user',
    async handler(req) {
      return requireUser(req);
    },
  }),
];

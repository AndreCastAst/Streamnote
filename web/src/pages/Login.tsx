import { useState, type FormEvent } from 'react';
import { api, type User } from '../api';
import { useSession } from '../App';

export function Login() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; user: User }>('POST', '/auth/dev-login', { email, name });
      signIn(r.token, r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-page">
        <h1>StreamNote</h1>
        <p className="lede">Toma apuntes por módulos, compártelos en clase y repasa las grabaciones de tu comunidad.</p>
        <form onSubmit={submit} className="stack">
          <label>
            Correo
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@upao.edu.pe" />
          </label>
          <label>
            Nombre
            <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Cómo te verán los demás" />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
        <p className="muted small">
          Inicio de sesión de desarrollo: no pide contraseña. En AWS lo reemplaza Cognito con tu cuenta de Google.
        </p>
      </div>
    </div>
  );
}

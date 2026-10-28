import { useEffect, useState, type FormEvent } from 'react';
import { api, setToken, type User } from '../api';
import { cognitoEnabled, finishLogin, startLogin } from '../cognito';
import { useSession } from '../App';

export function Login() {
  return cognitoEnabled ? <CognitoLogin /> : <DevLogin />;
}

function DevLogin() {
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

// Evita canjear dos veces el mismo código (StrictMode monta los efectos dos veces en desarrollo)
let exchanging = false;

/** En AWS: el formulario lo muestra Cognito y aquí se recibe el código de vuelta. */
function CognitoLogin() {
  const { signIn } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(() => new URLSearchParams(window.location.search).has('code'));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code || exchanging) return;
    exchanging = true;
    window.history.replaceState(null, '', window.location.pathname);
    finishLogin(code, params.get('state'))
      .then(async (token) => {
        setToken(token);
        const user = await api<User>('GET', '/me');
        signIn(token, user);
      })
      .catch((err) => {
        setToken(null);
        setError((err as Error).message);
        setBusy(false);
      })
      .finally(() => {
        exchanging = false;
      });
  }, []);

  const go = () => {
    setBusy(true);
    startLogin().catch((err) => {
      setError((err as Error).message);
      setBusy(false);
    });
  };

  return (
    <div className="login">
      <div className="login-page">
        <h1>StreamNote</h1>
        <p className="lede">Toma apuntes por módulos, compártelos en clase y repasa las grabaciones de tu comunidad.</p>
        <div className="stack">
          {error && <p className="error">{error}</p>}
          <button type="button" className="primary" disabled={busy} onClick={go}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </div>
        <p className="muted small">Inicias sesión con Amazon Cognito. La primera vez, elige «Sign up» para crear tu cuenta.</p>
      </div>
    </div>
  );
}

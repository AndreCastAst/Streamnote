import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';

interface Mine {
  id: string;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  role: 'owner' | 'moderator' | 'member';
  can_stream: boolean;
  members: number;
  live: boolean;
}

const roleName = { owner: 'Creador', moderator: 'Moderador', member: 'Miembro' };

export function Home() {
  const [mine, setMine] = useState<Mine[] | null>(null);
  const [discover, setDiscover] = useState<Omit<Mine, 'role' | 'can_stream' | 'live'>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = () => {
    api<Mine[]>('GET', '/communities').then(setMine).catch((e) => setError(e.message));
    api('GET', '/communities/discover').then(setDiscover).catch(() => undefined);
  };
  useEffect(load, []);

  const join = async (id: string) => {
    await api('POST', `/communities/${id}/join`);
    navigate(`/c/${id}`);
  };

  return (
    <div className="page two-col">
      <section>
        <h1>Tus comunidades</h1>
        {error && <p className="error">{error}</p>}
        {mine && mine.length === 0 && <p className="muted">Todavía no perteneces a ninguna. Crea una o únete con un código de invitación.</p>}
        <ul className="rows">
          {mine?.map((c) => (
            <li key={c.id}>
              <Link to={`/c/${c.id}`} className="row-link">
                <span className="row-main">
                  <strong>{c.name}</strong>
                  {c.live && <span className="live-pill">En vivo</span>}
                  <span className="muted">{c.description || (c.visibility === 'private' ? 'Comunidad privada' : 'Comunidad pública')}</span>
                </span>
                <span className="row-meta">
                  {roleName[c.role]}
                  {c.can_stream && c.role === 'member' ? ', puede transmitir' : ''}
                  <br />
                  {c.members} {c.members === 1 ? 'miembro' : 'miembros'}
                </span>
              </Link>
            </li>
          ))}
        </ul>

        {discover.length > 0 && (
          <>
            <h2>Comunidades públicas</h2>
            <ul className="rows">
              {discover.map((c) => (
                <li key={c.id} className="row">
                  <span className="row-main">
                    <strong>{c.name}</strong>
                    <span className="muted">{c.description}</span>
                  </span>
                  <button type="button" onClick={() => join(c.id)}>
                    Unirme
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <aside className="side-forms">
        <CreateCommunity onCreated={(id) => navigate(`/c/${id}`)} />
        <JoinByCode onJoined={(id) => navigate(`/c/${id}`)} />
      </aside>
    </div>
  );
}

function CreateCommunity({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const c = await api('POST', '/communities', { name, description, visibility });
      onCreated(c.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="panel stack" onSubmit={submit}>
      <h2>Crear una comunidad</h2>
      <label>
        Nombre
        <input required minLength={3} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Cálculo II, sección B" />
      </label>
      <label>
        Descripción
        <textarea maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="De qué trata y quién puede unirse" />
      </label>
      <fieldset className="choice">
        <legend>Quién puede entrar</legend>
        <label>
          <input type="radio" checked={visibility === 'private'} onChange={() => setVisibility('private')} /> Solo con código de invitación
        </label>
        <label>
          <input type="radio" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> Cualquier estudiante
        </label>
      </fieldset>
      {error && <p className="error">{error}</p>}
      <button className="primary">Crear comunidad</button>
      <p className="muted small">Serás su creador: decides quién puede transmitir.</p>
    </form>
  );
}

function JoinByCode({ onJoined }: { onJoined: (id: string) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/communities/join-by-code', { code });
      onJoined(r.communityId);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="panel stack" onSubmit={submit}>
      <h2>Unirme con un código</h2>
      <label>
        Código de invitación
        <input required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="AB12CD34" className="code-input" />
      </label>
      {error && <p className="error">{error}</p>}
      <button>Unirme</button>
    </form>
  );
}

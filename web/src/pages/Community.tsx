import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, formatDate, realtime } from '../api';
import { useSession } from '../App';

interface Member {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'moderator' | 'member';
  can_stream: boolean;
}
interface Community {
  id: string;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  inviteCode?: string;
  me: { role: Member['role']; can_stream: boolean } | null;
  members: Member[];
}

const roleName = { owner: 'Creador', moderator: 'Moderador', member: 'Miembro' };
const tabs = [
  ['directos', 'Directos y grabaciones'],
  ['apuntes', 'Apuntes compartidos'],
  ['miembros', 'Miembros'],
] as const;

export function CommunityPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const [c, setC] = useState<Community | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const raw = params.get('tab') ?? 'directos';
  const tab = raw === 'grabaciones' ? 'directos' : raw;

  const load = useCallback(() => {
    api<Community>('GET', `/communities/${id}`).then(setC).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  // Si cambian mis permisos (p. ej. me dan permiso para transmitir), recargar
  useEffect(() => realtime.listen((m) => m.type === 'notification' && m.data.link?.startsWith(`/c/${id}`) && load()), [id, load]);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!c) return <div className="page muted">Cargando…</div>;

  const manager = c.me?.role === 'owner' || c.me?.role === 'moderator';

  const join = async () => {
    await api('POST', `/communities/${c.id}/join`);
    load();
  };
  const leave = async () => {
    await api('POST', `/communities/${c.id}/leave`);
    navigate('/');
  };

  return (
    <div className="page">
      <header className="community-head">
        <div>
          <h1>{c.name}</h1>
          <p className="muted">{c.description || (c.visibility === 'private' ? 'Comunidad privada' : 'Comunidad pública')}</p>
        </div>
        <div className="head-actions">
          {c.me ? (
            <>
              <span className="role-tag">{roleName[c.me.role]}</span>
              {c.me.role !== 'owner' && (
                <button type="button" className="link" onClick={leave}>
                  Salir de la comunidad
                </button>
              )}
            </>
          ) : (
            <button type="button" className="primary" onClick={join}>
              Unirme
            </button>
          )}
        </div>
      </header>

      {manager && c.inviteCode && <InviteCode community={c} onChange={load} />}

      <div className="tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setParams({ tab: key })}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'directos' && <StreamsTab c={c} manager={manager} />}
      {tab === 'apuntes' && <SharedNotesTab c={c} />}
      {tab === 'miembros' && <MembersTab c={c} onChange={load} />}
    </div>
  );
}

function InviteCode({ community, onChange }: { community: Community; onChange: () => void }) {
  const rotate = async () => {
    await api('POST', `/communities/${community.id}/invite-code`);
    onChange();
  };
  return (
    <p className="invite">
      Código de invitación: <strong className="code">{community.inviteCode}</strong>
      {community.me?.role === 'owner' && (
        <button type="button" className="link" onClick={rotate}>
          Generar otro
        </button>
      )}
    </p>
  );
}

// ---------- Directos y grabaciones ----------
interface StreamRow {
  id: string;
  title: string;
  status: 'live' | 'ended';
  started_at: string;
  host: string;
  recording: string;
}
interface Recording {
  id: string;
  title: string;
  host: string;
  status: 'provisional' | 'kept';
  durationSeconds: number;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string | null;
  storageTier: string;
  canKeep: boolean;
  videoUrl: string;
  audioUrl: string | null;
}

function StreamsTab({ c, manager }: { c: Community; manager: boolean }) {
  const [streams, setStreams] = useState<StreamRow[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [title, setTitle] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ id: string; kind: 'video' | 'audio' } | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api('GET', `/communities/${c.id}/streams`).then(setStreams).catch(() => undefined);
    api('GET', `/communities/${c.id}/recordings`).then(setRecordings).catch(() => undefined);
  }, [c.id]);
  useEffect(load, [load]);
  useEffect(() => realtime.listen((m) => m.type === 'notification' && load()), [load]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const s = await api('POST', `/communities/${c.id}/streams`, { title });
      navigate(`/live/${s.id}`);
    } catch (err) {
      setMsg((err as Error).message);
    }
  };

  const requestPermission = async () => {
    try {
      await api('POST', `/communities/${c.id}/stream-permission-requests`);
      setMsg('Se avisó al creador y a los moderadores.');
    } catch (err) {
      setMsg((err as Error).message);
    }
  };

  const keep = async (r: Recording) => {
    await api('POST', `/recordings/${r.id}/keep`);
    load();
  };
  const askKeep = async (r: Recording) => {
    await api('POST', `/recordings/${r.id}/keep-requests`);
    setMsg(`Pediste conservar «${r.title}». Se avisó a quien transmitió.`);
  };

  const live = streams.filter((s) => s.status === 'live');
  const processing = streams.filter((s) => s.status === 'ended' && (s.recording === 'pending' || s.recording === 'processing'));

  return (
    <div className="tab-body two-col">
      <section>
        <h2>En vivo ahora</h2>
        {live.length === 0 && <p className="muted">No hay directos en este momento.</p>}
        <ul className="rows">
          {live.map((s) => (
            <li key={s.id}>
              <Link to={`/live/${s.id}`} className="row-link">
                <span className="row-main">
                  <strong>{s.title}</strong>
                  <span className="live-pill">En vivo</span>
                  <span className="muted">Transmite {s.host}, desde {formatDate(s.started_at)}</span>
                </span>
                <span className="row-meta">Entrar</span>
              </Link>
            </li>
          ))}
        </ul>

        <h2 id="grabaciones">Grabaciones</h2>
        <p className="muted small">
          Las grabaciones nuevas son provisionales. Si quien transmitió o un moderador no las conserva, se borran al vencer el plazo. Las conservadas no se
          borran nunca y con el tiempo pasan a almacenamiento más barato.
        </p>
        {processing.map((s) => (
          <p key={s.id} className="muted">Preparando la grabación de «{s.title}»…</p>
        ))}
        {recordings.length === 0 && processing.length === 0 && <p className="muted">Aún no hay grabaciones.</p>}
        <ul className="rows">
          {recordings.map((r) => (
            <li key={r.id} className="recording">
              <div className="row">
                <span className="row-main">
                  <strong>{r.title}</strong>
                  <span className="muted">
                    {r.host}, {formatDate(r.createdAt)}, {Math.max(1, Math.round(r.durationSeconds / 60))} min
                  </span>
                  <span className={`rec-state ${r.status}`}>
                    {r.status === 'provisional' ? `Provisional hasta ${formatDate(r.expiresAt!)}` : 'Conservada'}, {r.storageTier}
                  </span>
                </span>
                <span className="row-actions">
                  <button type="button" onClick={() => setPlaying({ id: r.id, kind: 'video' })}>Ver</button>
                  {r.audioUrl && <button type="button" onClick={() => setPlaying({ id: r.id, kind: 'audio' })}>Escuchar</button>}
                  {r.canKeep && <button type="button" className="primary" onClick={() => keep(r)}>Conservar</button>}
                  {r.status === 'provisional' && !r.canKeep && c.me && (
                    <button type="button" onClick={() => askKeep(r)}>Pedir que se conserve</button>
                  )}
                </span>
              </div>
              {playing?.id === r.id &&
                (playing.kind === 'video' ? (
                  <video controls autoPlay src={r.videoUrl} className="player" />
                ) : (
                  <audio controls autoPlay src={r.audioUrl!} />
                ))}
            </li>
          ))}
        </ul>
      </section>

      <aside className="side-forms">
        {c.me?.can_stream ? (
          <form className="panel stack" onSubmit={start}>
            <h2>Iniciar un directo</h2>
            <label>
              Tema de la sesión
              <input required minLength={3} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Repaso para el parcial" />
            </label>
            <button className="primary">Iniciar directo</button>
            <p className="muted small">Se avisará a todos los miembros. Puedes compartir cámara o pantalla.</p>
          </form>
        ) : c.me ? (
          <div className="panel stack">
            <h2>Transmitir</h2>
            <p className="muted">Para transmitir en esta comunidad necesitas el permiso de su creador o de un moderador.</p>
            <button type="button" onClick={requestPermission}>Pedir permiso para transmitir</button>
          </div>
        ) : null}
        {msg && <p className="notice">{msg}</p>}
        {manager && <p className="muted small">Como {c.me?.role === 'owner' ? 'creador' : 'moderador'}, puedes conservar cualquier grabación.</p>}
      </aside>
    </div>
  );
}

// ---------- Apuntes compartidos ----------
interface SharedNote {
  id: string;
  title: string;
  updated_at: string;
  author: string;
  modules: number;
  locked: boolean;
  stream: { id: string; title: string } | null;
}

/** Con el Data API, `json_build_object` puede llegar como texto: se acepta de las dos formas. */
function parseStream(v: unknown): SharedNote['stream'] {
  if (typeof v !== 'string') return (v as SharedNote['stream']) ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function SharedNotesTab({ c }: { c: Community }) {
  const [notes, setNotes] = useState<SharedNote[] | null>(null);
  useEffect(() => {
    api<SharedNote[]>('GET', `/communities/${c.id}/notes`)
      .then((rows) => setNotes(rows.map((n) => ({ ...n, stream: parseStream(n.stream) }))))
      .catch(() => setNotes([]));
  }, [c.id]);
  return (
    <div className="tab-body">
      {notes?.length === 0 && <p className="muted">Nadie ha compartido apuntes todavía. Comparte una nota desde «Mis notas».</p>}
      <ul className="rows">
        {notes?.map((n) => (
          <li key={n.id}>
            <Link to={`/notes/${n.id}`} className="row-link">
              <span className="row-main">
                <strong>
                  {n.title}
                  {n.locked && (
                    <span className="lock-mark" title="Copia congelada">
                      {' '}
                      <span aria-hidden="true">🔒</span>
                      <span className="sr-only">Copia congelada</span>
                    </span>
                  )}
                </strong>
                <span className="muted">
                  {n.author}, {n.modules} {n.modules === 1 ? 'módulo' : 'módulos'}
                  {n.stream && ` · Directo: ${n.stream.title}`}
                </span>
              </span>
              <span className="row-meta">{formatDate(n.updated_at)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Miembros y permisos ----------
function MembersTab({ c, onChange }: { c: Community; onChange: () => void }) {
  const { user } = useSession();
  const [error, setError] = useState<string | null>(null);
  const me = c.me?.role;

  const patch = async (m: Member, body: object) => {
    setError(null);
    try {
      await api('PATCH', `/communities/${c.id}/members/${m.id}`, body);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (m: Member) => {
    await api('DELETE', `/communities/${c.id}/members/${m.id}`);
    onChange();
  };

  if (!c.me) return <p className="muted tab-body">Únete para ver a los miembros.</p>;

  return (
    <div className="tab-body">
      {error && <p className="error">{error}</p>}
      <table className="members">
        <thead>
          <tr>
            <th scope="col">Persona</th>
            <th scope="col">Rol</th>
            <th scope="col">Puede transmitir</th>
            <th scope="col"><span className="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          {c.members.map((m) => {
            const canToggle = m.role !== 'owner' && (me === 'owner' || (me === 'moderator' && m.role === 'member'));
            return (
              <tr key={m.id}>
                <td>
                  {m.name}
                  {m.id === user?.id && <span className="muted"> (tú)</span>}
                  <br />
                  <span className="muted small">{m.email}</span>
                </td>
                <td>
                  {me === 'owner' && m.role !== 'owner' ? (
                    <select value={m.role} aria-label={`Rol de ${m.name}`} onChange={(e) => patch(m, { role: e.target.value })}>
                      <option value="member">Miembro</option>
                      <option value="moderator">Moderador</option>
                    </select>
                  ) : (
                    roleName[m.role]
                  )}
                </td>
                <td>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={m.can_stream}
                      disabled={!canToggle}
                      aria-label={`Permiso para transmitir de ${m.name}`}
                      onChange={(e) => patch(m, { canStream: e.target.checked })}
                    />
                    <span>{m.can_stream ? 'Sí' : 'No'}</span>
                  </label>
                </td>
                <td>
                  {canToggle && m.id !== user?.id && (
                    <button type="button" className="link danger" onClick={() => remove(m)}>
                      Quitar
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, formatDate } from '../api';
import { NoteEditor } from '../components/NoteEditor';

interface NoteRow {
  id: string;
  title: string;
  updated_at: string;
  modules: number;
  stream_id: string | null;
  shared_with: { id: string; name: string }[];
}

export function NotesPage() {
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    api<NoteRow[]>('GET', '/notes').then(setNotes);
  }, []);

  const create = async () => {
    const n = await api('POST', '/notes', { title: 'Nota sin título' });
    navigate(`/notes/${n.id}`);
  };

  return (
    <div className="page">
      <header className="community-head">
        <h1>Mis notas</h1>
        <button type="button" className="primary" onClick={create}>
          Nueva nota
        </button>
      </header>
      {notes?.length === 0 && <p className="muted">Crea tu primera nota. Cada nota se arma con módulos: texto, títulos, código, listas y citas.</p>}
      <ul className="rows">
        {notes?.map((n) => (
          <li key={n.id}>
            <Link to={`/notes/${n.id}`} className="row-link">
              <span className="row-main">
                <strong>{n.title}</strong>
                <span className="muted">
                  {n.modules} {n.modules === 1 ? 'módulo' : 'módulos'}
                  {n.stream_id ? ', tomada en un directo' : ''}
                  {n.shared_with.length > 0 && `, compartida en ${n.shared_with.map((s) => s.name).join(', ')}`}
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

export function NotePage() {
  const { id } = useParams();
  const [meta, setMeta] = useState<{ canEdit: boolean; sharedWith: { id: string; name: string }[] } | null>(null);
  const [communities, setCommunities] = useState<{ id: string; name: string }[]>([]);
  const navigate = useNavigate();

  const load = () => api('GET', `/notes/${id}`).then(setMeta).catch(() => undefined);
  useEffect(() => {
    load();
    api('GET', '/communities').then(setCommunities).catch(() => undefined);
  }, [id]);

  const toggle = async (communityId: string, on: boolean) => {
    if (on) await api('POST', `/notes/${id}/shares`, { communityId });
    else await api('DELETE', `/notes/${id}/shares/${communityId}`);
    load();
  };

  const copy = async () => {
    const n = await api('POST', `/notes/${id}/copy`);
    navigate(`/notes/${n.id}`);
  };

  const remove = async () => {
    if (!window.confirm('¿Eliminar esta nota?')) return;
    await api('DELETE', `/notes/${id}`);
    navigate('/notas');
  };

  return (
    <div className="page note-page">
      <NoteEditor key={id} noteId={id!} />
      {meta && (
        <aside className="side-forms">
          {meta.canEdit ? (
            <div className="panel stack">
              <h2>Compartir con</h2>
              {communities.length === 0 && <p className="muted small">Únete a una comunidad para compartir tus notas.</p>}
              {communities.map((c) => (
                <label key={c.id} className="check-row">
                  <input type="checkbox" checked={meta.sharedWith.some((s) => s.id === c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                  {c.name}
                </label>
              ))}
              <p className="muted small">Los miembros podrán leerla y copiarla a sus notas.</p>
              <button type="button" className="link danger" onClick={remove}>
                Eliminar nota
              </button>
            </div>
          ) : (
            <div className="panel stack">
              <h2>Nota compartida</h2>
              <p className="muted small">Haz una copia para editarla. Cada módulo recordará quién lo escribió.</p>
              <button type="button" className="primary" onClick={copy}>
                Copiar a mis notas
              </button>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { api, formatDate, realtime } from '../api';

interface Reminder {
  id: string;
  title: string;
  fireAt: string;
  status: 'pending' | 'sent' | 'cancelled';
  kind: 'user' | 'recording_expiry';
}

const inMinutes = (m: number) => {
  const d = new Date(Date.now() + m * 60_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function RemindersPage() {
  const [list, setList] = useState<Reminder[]>([]);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(inMinutes(2));
  const [error, setError] = useState<string | null>(null);

  const load = () => api<Reminder[]>('GET', '/reminders').then(setList).catch(() => undefined);
  useEffect(() => {
    load();
    return realtime.listen((m) => m.type === 'notification' && m.data.type === 'ReminderDue' && load());
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('POST', '/reminders', { title, fireAt: new Date(when).toISOString() });
      setTitle('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const cancel = async (r: Reminder) => {
    await api('DELETE', `/reminders/${r.id}`);
    load();
  };

  const pending = list.filter((r) => r.status === 'pending');
  const past = list.filter((r) => r.status !== 'pending');

  return (
    <div className="page two-col">
      <section>
        <h1>Recordatorios</h1>
        {pending.length === 0 && <p className="muted">No tienes recordatorios pendientes.</p>}
        <ul className="rows">
          {pending.map((r) => (
            <li key={r.id} className="row">
              <span className="row-main">
                <strong>{r.title}</strong>
                <span className="muted">{formatDate(r.fireAt)}</span>
              </span>
              {r.kind === 'user' && (
                <button type="button" className="link" onClick={() => cancel(r)}>
                  Cancelar
                </button>
              )}
            </li>
          ))}
        </ul>
        {past.length > 0 && (
          <>
            <h2>Últimos 7 días</h2>
            <ul className="rows">
              {past.map((r) => (
                <li key={r.id} className="row past">
                  <span className="row-main">
                    <strong>{r.title}</strong>
                    <span className="muted">
                      {formatDate(r.fireAt)}, {r.status === 'sent' ? 'enviado' : 'cancelado'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <aside className="side-forms">
        <form className="panel stack" onSubmit={submit}>
          <h2>Nuevo recordatorio</h2>
          <label>
            Qué
            <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Entregar el informe de laboratorio" />
          </label>
          <label>
            Cuándo
            <input type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary">Crear recordatorio</button>
          <p className="muted small">Llega como aviso dentro de StreamNote, con un margen de pocos segundos.</p>
        </form>
      </aside>
    </div>
  );
}

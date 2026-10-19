import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, realtime, relative } from '../api';

interface Item {
  sk: string;
  id: string;
  type: string;
  title: string;
  body: string;
  link?: string;
  createdAt: string;
  read: boolean;
}

export function Notifications() {
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<Item | null>(null);
  const navigate = useNavigate();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Item[]>('GET', '/notifications').then(setItems).catch(() => undefined);
    return realtime.listen((m) => {
      if (m.type !== 'notification') return;
      setItems((list) => [m.data, ...list.filter((x) => x.id !== m.data.id)]);
      setToast(m.data);
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const unread = items.filter((i) => !i.read).length;

  const toggle = async () => {
    setOpen(!open);
    if (!open && unread) {
      await api('POST', '/notifications/read-all').catch(() => undefined);
      setItems((l) => l.map((i) => ({ ...i, read: true })));
    }
  };

  const go = (i: Item) => {
    setOpen(false);
    setToast(null);
    if (i.link) navigate(i.link);
  };

  return (
    <div className="notif" ref={panel}>
      <button type="button" className="notif-button" onClick={toggle} aria-expanded={open} aria-label={`Notificaciones${unread ? `, ${unread} sin leer` : ''}`}>
        Avisos{unread > 0 && <span className="badge">{unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notificaciones">
          {items.length === 0 && <p className="muted pad">Aquí aparecerán los avisos de tus comunidades.</p>}
          <ul>
            {items.map((i) => (
              <li key={i.sk}>
                <button type="button" onClick={() => go(i)} className={i.read ? '' : 'unread'}>
                  <strong>{i.title}</strong>
                  {i.body && <span>{i.body}</span>}
                  <time>{relative(i.createdAt)}</time>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {toast && !open && (
        <button type="button" className="toast" onClick={() => go(toast)} role="status">
          <strong>{toast.title}</strong>
          {toast.body && <span>{toast.body}</span>}
        </button>
      )}
    </div>
  );
}

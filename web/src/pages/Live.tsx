import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, realtime, type NoteModule } from '../api';
import { useSession } from '../App';
import { NoteEditor, ModuleView, type NoteEditorHandle } from '../components/NoteEditor';
import { play, publish } from '../webrtc';

interface StreamInfo {
  id: string;
  title: string;
  status: 'live' | 'ended';
  community: { id: string; name: string };
  host: { id: string; name: string };
  isHost: boolean;
  canManage: boolean;
  viewers: number;
  publishing: boolean;
  publishUrl: string | null;
  playback: { webrtc: string; hls: string } | null;
}
interface Shared {
  id: string;
  type: NoteModule['type'];
  content: any;
  sourceModuleId?: string | null;
  sharedBy: { id: string; name: string };
  sharedAt: string;
}
interface ChatMsg {
  id: string;
  text: string;
  from: { id: string; name: string };
  at: string;
}

export function LivePage() {
  const { id } = useParams();
  const { user } = useSession();
  const [info, setInfo] = useState<StreamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [shared, setShared] = useState<Shared[]>([]);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [ended, setEnded] = useState(false);
  const editor = useRef<NoteEditorHandle>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<StreamInfo>('GET', `/streams/${id}`)
        .then((s) => {
          if (!alive) return;
          setInfo((prev) => (prev && prev.status === s.status ? { ...prev, viewers: s.viewers, publishing: s.publishing } : s));
          if (s.status === 'ended') setEnded(true);
        })
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 10000);
    api<Shared[]>('GET', `/streams/${id}/modules`).then((l) => alive && setShared(l)).catch(() => undefined);
    const unsub = realtime.subscribe(`stream:${id}`);
    const unlisten = realtime.listen((m) => {
      if (m.channel !== `stream:${id}`) return;
      if (m.type === 'module.shared') setShared((l) => (l.some((x) => x.id === m.data.id) ? l : [...l, m.data]));
      if (m.type === 'chat.message') setChat((l) => (l.some((x) => x.id === m.data.id) ? l : [...l.slice(-199), m.data]));
      if (m.type === 'stream.ended') setEnded(true);
    });
    return () => {
      alive = false;
      clearInterval(t);
      unsub();
      unlisten();
    };
  }, [id]);

  // Cada participante toma sus apuntes en una nota propia ligada al directo
  useEffect(() => {
    if (!info) return;
    let alive = true;
    (async () => {
      const mine = await api<{ id: string; stream_id: string | null }[]>('GET', '/notes');
      const existing = mine.find((n) => n.stream_id === info.id);
      if (existing) return alive && setNoteId(existing.id);
      if (!alive || info.status !== 'live') return;
      const n = await api('POST', '/notes', { title: info.title, streamId: info.id });
      if (alive) setNoteId(n.id);
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [info?.id]);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!info) return <div className="page muted">Entrando al directo…</div>;

  const shareModule = async (m: NoteModule) => {
    await api('POST', `/streams/${info.id}/modules`, { type: m.type, content: m.content, sourceModuleId: m.sourceModuleId ?? m.id });
  };

  const addToNote = (s: Shared) => {
    editor.current?.addModule({ type: s.type, content: s.content, sourceModuleId: s.sourceModuleId ?? s.id, sourceAuthor: s.sharedBy.name });
    setAdded((a) => new Set(a).add(s.id));
  };

  return (
    <div className="live">
      <header className="live-head">
        <div>
          <h1>{info.title}</h1>
          <p className="muted">
            <Link to={`/c/${info.community.id}`}>{info.community.name}</Link>, transmite {info.isHost ? 'tú' : info.host.name}
          </p>
        </div>
        <div className="live-status">
          {ended ? <span className="ended-pill">Terminado</span> : <span className="live-pill">En vivo</span>}
          {!ended && <span className="muted">{info.viewers} {info.viewers === 1 ? 'espectador' : 'espectadores'}</span>}
        </div>
      </header>

      <div className="live-grid">
        <div className="live-left">
          {info.isHost ? (
            <HostStage info={info} ended={ended} onEnded={() => setEnded(true)} />
          ) : (
            <ViewerStage info={info} ended={ended} />
          )}
          <Chat streamId={info.id} messages={chat} meId={user!.id} disabled={ended} />
        </div>

        <div className="live-note">
          {noteId ? (
            <NoteEditor ref={editor} noteId={noteId} onShare={ended ? undefined : shareModule} compact />
          ) : (
            <p className="muted">{ended ? 'No tomaste apuntes en este directo.' : 'Preparando tu nota…'}</p>
          )}
        </div>

        <aside className="live-shared" aria-label="Módulos compartidos">
          <h2>Lo que se comparte</h2>
          {shared.length === 0 && <p className="muted small">Cuando alguien comparta un módulo de sus apuntes, aparecerá aquí y podrás agregarlo a tu nota.</p>}
          <ol className="shared-list">
            {shared.map((s) => (
              <li key={s.id} className="shared-item">
                <span className="highlight-tag">{s.sharedBy.id === user!.id ? 'Tú' : s.sharedBy.name}</span>
                <ModuleView m={s} />
                {s.sharedBy.id !== user!.id && noteId && (
                  <button type="button" onClick={() => addToNote(s)} disabled={added.has(s.id)}>
                    {added.has(s.id) ? 'Agregado a tu nota' : 'Agregar a mi nota'}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}

function HostStage({ info, ended, onEnded }: { info: StreamInfo; ended: boolean; onEnded: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const media = useRef<MediaStream | null>(null);
  const [state, setState] = useState<'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const stopping = useRef(false);

  const connect = async (attempt = 0): Promise<void> => {
    if (!media.current || stopping.current) return;
    try {
      const conn = await publish(info.publishUrl!, media.current);
      pc.current = conn;
      setState('live');
      conn.onconnectionstatechange = () => {
        if (['failed', 'disconnected'].includes(conn.connectionState) && !stopping.current) {
          conn.close();
          setState('reconnecting');
          // RNF-16: reintentar durante la ventana de reconexión
          setTimeout(() => connect(0), 2000);
        }
      };
    } catch (e) {
      if (attempt < 20 && !stopping.current) {
        setState('reconnecting');
        setTimeout(() => connect(attempt + 1), 3000);
      } else {
        setState('error');
        setMessage((e as Error).message);
      }
    }
  };

  const start = async (kind: 'camera' | 'screen') => {
    setMessage(null);
    setState('connecting');
    try {
      let stream: MediaStream;
      if (kind === 'camera') stream = await navigator.mediaDevices.getUserMedia({ video: { width: 854, height: 480 }, audio: true });
      else {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { height: 720 }, audio: false });
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        mic?.getAudioTracks().forEach((t) => stream.addTrack(t));
      }
      media.current = stream;
      if (video.current) video.current.srcObject = stream;
      await connect();
    } catch (e) {
      setState('error');
      setMessage((e as Error).name === 'NotAllowedError' ? 'No diste permiso para usar la cámara o la pantalla.' : (e as Error).message);
    }
  };

  const stopMedia = () => {
    stopping.current = true;
    pc.current?.close();
    media.current?.getTracks().forEach((t) => t.stop());
  };

  const end = async () => {
    stopMedia();
    await api('POST', `/streams/${info.id}/end`);
    onEnded();
  };

  // En modo estricto React monta, desmonta y vuelve a montar: se reinicia la bandera al montar
  useEffect(() => {
    stopping.current = false;
    return () => stopMedia();
  }, []);
  useEffect(() => {
    if (ended) stopMedia();
  }, [ended]);

  return (
    <div className="stage">
      <video ref={video} autoPlay muted playsInline className={state === 'idle' ? 'hidden' : ''} />
      {state === 'idle' && !ended && (
        <div className="stage-empty">
          <p>Elige qué transmitir. Todos los miembros recibirán un aviso.</p>
          <div className="row-actions">
            <button type="button" className="primary" onClick={() => start('camera')}>Compartir cámara</button>
            <button type="button" onClick={() => start('screen')}>Compartir pantalla</button>
          </div>
        </div>
      )}
      {ended && <div className="stage-empty"><p>El directo terminó. La grabación aparecerá en la comunidad en unos minutos.</p></div>}
      {!ended && (
        <div className="stage-bar">
          <span className={`stage-state ${state}`}>
            {{ idle: 'Sin emitir', connecting: 'Conectando…', live: 'Emitiendo', reconnecting: 'Reconectando…', error: 'Error' }[state]}
          </span>
          {message && <span className="error small">{message}</span>}
          <button type="button" className="danger" onClick={end}>Terminar directo</button>
        </div>
      )}
    </div>
  );
}

function ViewerStage({ info, ended }: { info: StreamInfo; ended: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'waiting' | 'playing' | 'reconnecting'>('waiting');
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    if (ended || !info.playback) return;
    let pc: RTCPeerConnection | null = null;
    let timer: number | undefined;
    let watchdog: number | undefined;
    let alive = true;

    const retry = (ms: number) => {
      clearInterval(watchdog);
      pc?.close();
      pc = null;
      if (alive) timer = window.setTimeout(attempt, ms);
    };

    // Si el video no avanza (sin imagen o congelado), se vuelve a conectar
    const watch = () => {
      let last = -1;
      let stalls = 0;
      watchdog = window.setInterval(() => {
        const v = video.current;
        if (!v) return;
        const advancing = v.videoWidth >= 16 && v.currentTime > last;
        last = v.currentTime;
        stalls = advancing ? 0 : stalls + 1;
        if (stalls >= 3) {
          setState('reconnecting');
          retry(500);
        }
      }, 2000);
    };

    const attempt = async () => {
      try {
        const conn = await play(info.playback!.webrtc, (s) => {
          if (video.current) video.current.srcObject = s;
        });
        if (!alive) return conn.close();
        pc = conn;
        setState('playing');
        watch();
        conn.onconnectionstatechange = () => {
          if (['failed', 'disconnected'].includes(conn.connectionState) && alive && pc === conn) {
            setState('reconnecting');
            retry(2000);
          }
        };
      } catch {
        retry(3000);
      }
    };
    attempt();
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(watchdog);
      pc?.close();
    };
  }, [info.playback?.webrtc, ended]);

  return (
    <div className="stage">
      <video ref={video} autoPlay playsInline muted={muted} className={state === 'playing' && !ended ? '' : 'hidden'} />
      {ended ? (
        <div className="stage-empty"><p>El directo terminó.</p></div>
      ) : state !== 'playing' ? (
        <div className="stage-empty">
          <p>{state === 'waiting' ? `Esperando a que ${info.host.name} empiece a transmitir…` : 'Se cortó la señal. Reconectando…'}</p>
        </div>
      ) : (
        <div className="stage-bar">
          <span className="stage-state live">Viendo en directo</span>
          <button type="button" onClick={() => setMuted(!muted)}>{muted ? 'Activar sonido' : 'Silenciar'}</button>
        </div>
      )}
    </div>
  );
}

function Chat({ streamId, messages, meId, disabled }: { streamId: string; messages: ChatMsg[]; meId: string; disabled: boolean }) {
  const [text, setText] = useState('');
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages.length]);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const t = text;
    setText('');
    await api('POST', `/streams/${streamId}/chat`, { text: t }).catch(() => setText(t));
  };
  return (
    <section className="chat" aria-label="Chat">
      <ol ref={list}>
        {messages.length === 0 && <li className="muted small">Los mensajes del chat no se guardan.</li>}
        {messages.map((m) => (
          <li key={m.id} className={m.from.id === meId ? 'mine' : ''}>
            <strong>{m.from.id === meId ? 'Tú' : m.from.name}</strong> {m.text}
          </li>
        ))}
      </ol>
      <form onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={disabled ? 'El directo terminó' : 'Escribe al grupo'} disabled={disabled} maxLength={500} aria-label="Mensaje" />
        <button disabled={disabled}>Enviar</button>
      </form>
    </section>
  );
}

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { handleUnauthorized, loadSession, realtime, saveSession, setToken, type User } from './api';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { CommunityPage } from './pages/Community';
import { NotesPage, NotePage } from './pages/Notes';
import { LivePage } from './pages/Live';
import { RemindersPage } from './pages/Reminders';
import { Notifications } from './components/Notifications';

interface Session {
  user: User | null;
  signIn(token: string, user: User): void;
  signOut(): void;
}

const SessionContext = createContext<Session>(null!);
export const useSession = () => useContext(SessionContext);

export function App() {
  const [user, setUser] = useState<User | null>(() => loadSession()?.user ?? null);

  const signOut = () => {
    saveSession(null);
    setToken(null);
    realtime.stop();
    setUser(null);
  };

  useEffect(() => {
    handleUnauthorized(signOut);
    if (user) realtime.start();
    return () => realtime.stop();
  }, [user?.id]);

  const signIn = (token: string, u: User) => {
    saveSession({ token, user: u });
    setToken(token);
    setUser(u);
  };

  return (
    <SessionContext.Provider value={{ user, signIn, signOut }}>
      <BrowserRouter>
        {user ? (
          <Shell>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/c/:id" element={<CommunityPage />} />
              <Route path="/notas" element={<NotesPage />} />
              <Route path="/notes/:id" element={<NotePage />} />
              <Route path="/live/:id" element={<LivePage />} />
              <Route path="/recordatorios" element={<RemindersPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Shell>
        ) : (
          <Routes>
            <Route path="*" element={<Login />} />
          </Routes>
        )}
      </BrowserRouter>
    </SessionContext.Provider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { user, signOut } = useSession();
  const location = useLocation();
  const [online, setOnline] = useState(realtime.connected);
  useEffect(() => realtime.onStatus(setOnline), []);
  const wide = location.pathname.startsWith('/live/');

  return (
    <div className={`shell${wide ? ' wide' : ''}`}>
      <header className="topbar">
        <NavLink to="/" className="brand">
          StreamNote
        </NavLink>
        <nav aria-label="Principal">
          <NavLink to="/" end>Comunidades</NavLink>
          <NavLink to="/notas">Mis notas</NavLink>
          <NavLink to="/recordatorios">Recordatorios</NavLink>
        </nav>
        <div className="topbar-right">
          <span className={`dot ${online ? 'on' : 'off'}`} title={online ? 'Conectado en tiempo real' : 'Reconectando…'} />
          <Notifications />
          <span className="who">{user?.name}</span>
          <button type="button" className="link" onClick={signOut}>
            Salir
          </button>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

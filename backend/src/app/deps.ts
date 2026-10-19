// Contenedor de dependencias: elige la implementación local o de AWS según la configuración.
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { loadConfig, type Config } from '../config.js';
import { PgDb, DataApiDb, type Db } from '../core/db.js';
import { Auth } from '../core/auth.js';
import { Queue, EventBus, Storage, NotificationStore } from '../core/aws.js';
import { HttpRelay, LocalHub, NoRealtime, type Realtime } from '../core/realtime.js';
import { PollingScheduler, EventBridgeScheduler, type Scheduler } from '../core/scheduler.js';
import { MediaMtx, MediaNotConfigured, type MediaServer } from '../core/media.js';

export interface Deps {
  cfg: Config;
  db: Db;
  auth: Auth;
  queue: Queue;
  bus: EventBus;
  storage: Storage;
  notifications: NotificationStore;
  realtime: Realtime;
  scheduler: Scheduler;
  media: MediaServer;
}

export function buildDeps(opts: { realtime: 'hub' | 'relay' }, cfg: Config = loadConfig()): Deps & { hub?: LocalHub } {
  const db: Db =
    cfg.db.driver === 'pg'
      ? PgDb.connect(cfg.db.url)
      : new DataApiDb(new RDSDataClient({ region: cfg.aws.region }), {
          resourceArn: cfg.db.clusterArn,
          secretArn: cfg.db.secretArn,
          database: cfg.db.database,
        });

  const hub = opts.realtime === 'hub' ? new LocalHub() : undefined;
  const realtime: Realtime = hub ?? (process.env.REALTIME_MODE === 'none' ? new NoRealtime() : new HttpRelay(cfg));

  return {
    cfg,
    db,
    auth: new Auth(cfg, db),
    queue: new Queue(cfg),
    bus: new EventBus(cfg),
    storage: new Storage(cfg),
    notifications: new NotificationStore(cfg),
    realtime,
    scheduler: cfg.scheduler.mode === 'eventbridge' ? new EventBridgeScheduler(cfg) : new PollingScheduler(),
    media: cfg.media.provider === 'mediamtx' ? new MediaMtx(cfg) : new MediaNotConfigured(),
    hub,
  };
}

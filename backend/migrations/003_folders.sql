-- Carpetas del explorador de archivos y vínculo de las notas con una comunidad.
-- Las notas existentes quedan en la raíz, privadas y editables.
CREATE TABLE folders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id     uuid REFERENCES folders(id),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind          text NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'directos', 'community')),
  community_id  uuid REFERENCES communities(id) ON DELETE SET NULL,  -- solo kind = 'community'
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Nombres únicos (sin distinguir mayúsculas) dentro de la misma carpeta del mismo dueño
CREATE UNIQUE INDEX folders_name_uniq ON folders (owner_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
-- Una sola «Directos» y una sola carpeta por comunidad para cada usuario
CREATE UNIQUE INDEX folders_directos_uniq ON folders (owner_id) WHERE kind = 'directos';
CREATE UNIQUE INDEX folders_community_uniq ON folders (owner_id, community_id) WHERE kind = 'community';
CREATE INDEX folders_parent_idx ON folders (owner_id, parent_id);

ALTER TABLE notes
  ADD COLUMN folder_id     uuid REFERENCES folders(id),
  ADD COLUMN community_id  uuid REFERENCES communities(id) ON DELETE SET NULL,
  ADD COLUMN locked        boolean NOT NULL DEFAULT false;
CREATE INDEX notes_folder_idx ON notes (owner_id, folder_id) WHERE deleted_at IS NULL;
CREATE INDEX notes_community_idx ON notes (community_id) WHERE deleted_at IS NULL;

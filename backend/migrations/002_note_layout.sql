-- Acomodo de los módulos en una cuadrícula de 12 columnas (x, y, w, h en unidades de cuadrícula).
-- Las notas existentes quedan con módulos a ancho completo, apilados en su orden actual.
ALTER TABLE note_modules
  ADD COLUMN x integer NOT NULL DEFAULT 0,
  ADD COLUMN y integer NOT NULL DEFAULT 0,
  ADD COLUMN w integer NOT NULL DEFAULT 12,
  ADD COLUMN h integer NOT NULL DEFAULT 2;

-- Alto inicial por tipo para lo que ya existe
UPDATE note_modules SET h = CASE type WHEN 'heading' THEN 2 WHEN 'text' THEN 3 WHEN 'quote' THEN 3 WHEN 'checklist' THEN 3 WHEN 'code' THEN 5 END;

-- Apilar en el orden actual: y = suma de los altos anteriores
UPDATE note_modules nm SET y = s.y
FROM (
  SELECT note_id, id, coalesce(sum(h) OVER (PARTITION BY note_id ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS y
  FROM note_modules
) s
WHERE nm.note_id = s.note_id AND nm.id = s.id;

ALTER TABLE note_modules
  ADD CONSTRAINT note_modules_layout_chk CHECK (x >= 0 AND w >= 1 AND x + w <= 12 AND y >= 0 AND h >= 1 AND h <= 200);

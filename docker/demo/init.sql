-- pgHeal demo database — Postgres 18 + HypoPG + pg_stat_statements
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS hypopg;

-- sample workload tables
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  status TEXT NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL
);

-- deliberately NO index on orders(user_id) — the demo scans will recommend one
INSERT INTO users (email, name)
SELECT 'user' || g || '@example.com', 'User ' || g
FROM generate_series(1, 10000) g;

INSERT INTO orders (user_id, status, total, created_at)
SELECT
  (random() * 9999 + 1)::bigint,
  (ARRAY['paid','pending','cancelled','refunded'])[1 + (random() * 3)::int],
  (random() * 500)::numeric(12,2),
  now() - (random() * 365) * interval '1 day'
FROM generate_series(1, 500000) g;

ANALYZE orders;
ANALYZE users;

-- generate a realistic slow workload in pg_stat_statements
DO $$
BEGIN
  FOR i IN 1..200 LOOP
    PERFORM * FROM orders WHERE user_id = (random() * 9999 + 1)::bigint AND status = 'paid' ORDER BY created_at DESC LIMIT 20;
  END LOOP;
END $$;

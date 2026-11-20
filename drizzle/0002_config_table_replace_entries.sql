DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE config (
  id INTEGER PRIMARY KEY,
  function_url TEXT NOT NULL,
  token TEXT NOT NULL
);

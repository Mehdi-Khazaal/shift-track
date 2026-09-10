-- Runs once, on first container start, via docker-entrypoint-initdb.d.
-- POSTGRES_DB already created shifttrack_dev; add the test database beside it
-- so the suite can wipe its own schema without touching your dev data.
CREATE DATABASE shifttrack_test OWNER shifttrack;

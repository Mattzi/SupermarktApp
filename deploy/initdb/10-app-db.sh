#!/bin/sh
# Eigene Datenbank und eigener Nutzer für die App im Postgres von Authentik (läuft nur beim allerersten Start)
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE USER angebotskueche WITH PASSWORD '$APP_DB_PASSWORD';
CREATE DATABASE angebotskueche OWNER angebotskueche;
SQL

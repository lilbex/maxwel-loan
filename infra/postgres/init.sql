-- Local development roles. Production uses the same two roles with secrets from your host.
CREATE ROLE loan_migrator LOGIN PASSWORD 'loan_migrator_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE loan_app LOGIN PASSWORD 'loan_app_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

ALTER DATABASE loan_platform OWNER TO loan_migrator;
ALTER SCHEMA public OWNER TO loan_migrator;
GRANT CONNECT ON DATABASE loan_platform TO loan_app;

import { loadEnvFile } from 'node:process';

try {
  loadEnvFile();
} catch {
  // No .env file present — normal in Docker, where env vars are already
  // populated by docker-compose's `env_file` directive before Node even starts.
}

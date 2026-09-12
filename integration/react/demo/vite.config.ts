import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Polling watcher: this machine's inotify limit is exhausted (same as aristos_frontend).
export default defineConfig({ plugins: [react()], server: { watch: { usePolling: true } } });

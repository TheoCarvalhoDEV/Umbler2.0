// Starts the API (tsx watch, port 3000) and the Vite dev server (port 5173) together. Ctrl+C stops both.
import { spawn } from 'node:child_process';

// One command string per workspace: with `shell: true`, an args array is only concatenated (Node DEP0190).
for (const ws of ['server', 'web']) {
  spawn(`npm run dev -w ${ws}`, { stdio: 'inherit', shell: true });
}

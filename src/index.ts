import { app } from './app.js';

// Kept separate from app.ts so tests can import the fully wired app without
// it binding a port.
const port = Number(process.env.PORT ?? 6559);
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});

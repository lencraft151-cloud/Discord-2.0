import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../server/app.js';

// Startet eine Testinstanz mit In-Memory-Datenbank.
export async function startTestApp(options = {}) {
  const app = createApp(options);
  const port = await app.listen(0);
  const base = `http://localhost:${port}`;
  const sockets = [];

  async function call(path, { token, method = 'GET', body, redirect = 'follow' } = {}) {
    const res = await fetch(`${base}${path.startsWith('/auth/discord') ? '' : '/api'}${path}`, {
      method,
      redirect,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }

  async function register(username) {
    const { status, data } = await call('/auth/register', { method: 'POST', body: { username, password: 'geheim123' } });
    assert.equal(status, 200, data.error);
    return data;
  }

  function socketFor(token) {
    const socket = connect(base, { auth: { token }, transports: ['websocket'] });
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }

  async function close() {
    for (const socket of sockets) socket.disconnect();
    await app.close();
    app.httpServer.close();
  }

  return { app, base, call, register, socketFor, close };
}

export const nextEvent = (socket, event, filter = () => true) =>
  new Promise((resolve) => {
    const handler = (payload) => {
      if (!filter(payload)) return;
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });

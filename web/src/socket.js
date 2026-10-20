import { io } from 'socket.io-client';
import { store } from './util.js';

let socket = null;

export function connect() {
  socket ??= io({ transports: ['websocket', 'polling'] });
  return socket;
}

export function request(event, payload = {}) {
  return new Promise((resolve) => {
    connect()
      .timeout(8000)
      .emit(event, payload, (err, res) => resolve(err ? { error: 'The server did not respond. Check your connection.' } : res));
  });
}

export const rememberPlayer = (code, playerId) => store.set(`gg:player:${code}`, playerId);
export const rememberedPlayer = (code) => store.get(`gg:player:${code}`);
export const forgetPlayer = (code) => store.remove(`gg:player:${code}`);

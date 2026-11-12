// @ts-check

const net = require('node:net');

const TIMEOUT_MS = 5000;
// Same bound the bridge applies to requests and the Neovim client applies to replies.
const LIMIT = 1024 * 1024;

/**
 * @typedef {{review_id: string; root: string; socket: string; token: string}} Connection
 */

/**
 * One bounded request per connection, as the review bridge expects: write one JSON line, read one
 * JSON line. A bridge `{error}` reply rejects.
 *
 * @param {Pick<Connection, 'socket' | 'token'>} connection
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 * @returns {Promise<any>}
 */
const call = (connection, method, params = {}) =>
  new Promise((resolve, reject) => {
    const request = `${JSON.stringify({ ...params, method, token: connection.token })}\n`;
    if (Buffer.byteLength(request) > LIMIT) {
      reject(new Error('Review request is too large'));
      return;
    }

    const socket = net.connect(connection.socket);
    let received = '';
    let settled = false;
    /** @param {Error | null} error @param {any} [value] */
    const settle = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    socket.setEncoding('utf8');
    socket.setTimeout(TIMEOUT_MS, () => settle(new Error('Review bridge timed out')));
    socket.on('error', (error) =>
      settle(new Error(`Review bridge disconnected: ${error.message}`)),
    );
    socket.on('connect', () => socket.write(request));
    socket.on('close', () => settle(new Error('Review bridge closed the connection')));
    socket.on('data', (chunk) => {
      received += chunk;
      if (received.length > LIMIT) {
        settle(new Error('Review response is too large'));
        return;
      }
      const end = received.indexOf('\n');
      if (end === -1) {
        return;
      }
      try {
        const response = JSON.parse(received.slice(0, end));
        if (response === null || typeof response !== 'object' || Array.isArray(response)) {
          throw new Error('not an object');
        }
        settle(response.error ? new Error(String(response.error)) : null, response);
      } catch {
        settle(new Error('Invalid review bridge response'));
      }
    });
  });

module.exports = { call };

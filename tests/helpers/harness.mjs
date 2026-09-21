/**
 * Minimal HTTP req/res doubles for driving the serverless handler in tests.
 */
import { EventEmitter } from 'node:events';

export function mockReq(method, body, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.body = body;
  return req;
}

export function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    setHeader(k, v) {
      res.headers[k] = v;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    end() {
      res.body = res.body ?? null;
      return res;
    }
  };
  return res;
}
